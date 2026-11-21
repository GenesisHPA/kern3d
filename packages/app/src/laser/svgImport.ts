// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ellipsePath, FLATTEN_TOLERANCE, flattenCubic, flattenQuadratic, flattenSvgArc } from "./flatten";
import {
    type Affine,
    cleanPath,
    IDENTITY,
    isEmpty,
    type LaserPath,
    maxScale,
    multiply,
    type Pt,
    pathsBounds,
    rotation,
    scaling,
    transformPaths,
    translation,
} from "./geometry";

// ---- a small XML reader: elements and attributes, nothing else is needed for geometry ----------

export interface XmlElement {
    name: string;
    attrs: Record<string, string>;
    children: XmlElement[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code: string) => {
        if (code[0] === "#") {
            const n =
                code[1] === "x" || code[1] === "X"
                    ? Number.parseInt(code.slice(2), 16)
                    : Number(code.slice(1));
            return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
        }
        return ENTITIES[code] ?? whole;
    });
}

function parseAttributes(source: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    for (let m = re.exec(source); m !== null; m = re.exec(source)) {
        attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? "");
    }
    return attrs;
}

/** Skips past a markup declaration or processing instruction starting at `i`; returns the index after it. */
function skipSpecial(xml: string, i: number): number {
    const ends: [string, string][] = [
        ["<!--", "-->"],
        ["<![CDATA[", "]]>"],
        ["<?", "?>"],
    ];
    for (const [open, close] of ends) {
        if (xml.startsWith(open, i)) {
            const end = xml.indexOf(close, i + open.length);
            return end < 0 ? xml.length : end + close.length;
        }
    }
    // <!DOCTYPE ...> with an optional [internal subset]
    let depth = 0;
    for (let k = i + 2; k < xml.length; k++) {
        if (xml[k] === "[") depth++;
        else if (xml[k] === "]") depth--;
        else if (xml[k] === ">" && depth <= 0) return k + 1;
    }
    return xml.length;
}

function localName(name: string): string {
    const colon = name.indexOf(":");
    return colon < 0 ? name : name.slice(colon + 1);
}

/** The document's root element, or undefined when there is none. Unbalanced closing tags are tolerated. */
export function parseXml(xml: string): XmlElement | undefined {
    const root: XmlElement = { name: "#root", attrs: {}, children: [] };
    const stack: XmlElement[] = [root];
    let i = 0;
    while (i < xml.length) {
        const lt = xml.indexOf("<", i);
        if (lt < 0) break;
        if (xml[lt + 1] === "!" || xml[lt + 1] === "?") {
            i = skipSpecial(xml, lt);
            continue;
        }
        const gt = findTagEnd(xml, lt + 1);
        const body = xml.slice(lt + 1, gt);
        i = gt + 1;
        if (body.startsWith("/")) {
            const name = localName(body.slice(1).trim());
            const at = stack.map((e) => e.name).lastIndexOf(name);
            if (at > 0) stack.length = at;
            continue;
        }
        const selfClosing = body.endsWith("/");
        const nameEnd = body.search(/[\s/]|$/);
        const element: XmlElement = {
            name: localName(body.slice(0, nameEnd)),
            attrs: parseAttributes(body.slice(nameEnd)),
            children: [],
        };
        stack[stack.length - 1].children.push(element);
        if (!selfClosing) stack.push(element);
    }
    return root.children[0];
}

/** The `>` closing a tag, skipping any inside quoted attribute values. */
function findTagEnd(xml: string, from: number): number {
    let quote: string | undefined;
    for (let k = from; k < xml.length; k++) {
        const c = xml[k];
        if (quote !== undefined) {
            if (c === quote) quote = undefined;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") return k;
    }
    return xml.length;
}

// ---- numbers, lengths, transforms ---------------------------------------------------------------

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

export function parseNumbers(text: string): number[] {
    return (text.match(NUMBER) ?? []).map(Number);
}

const UNIT_MM: Record<string, number> = {
    mm: 1,
    cm: 10,
    in: 25.4,
    pt: 25.4 / 72,
    pc: 25.4 / 6,
    px: 25.4 / 96,
    "": 25.4 / 96,
};

/** A length in millimetres (user units are CSS px at 96 dpi); undefined for a percentage or junk. */
export function lengthToMm(text: string | undefined): number | undefined {
    if (text === undefined) return undefined;
    const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(text);
    if (m === null) return undefined;
    const factor = UNIT_MM[m[2].toLowerCase()];
    return factor === undefined ? undefined : Number(m[1]) * factor;
}

/** An SVG `transform` list, applied as written: the leftmost is outermost. */
export function parseTransform(text: string | undefined): Affine {
    let result: Affine = [...IDENTITY];
    if (text === undefined) return result;
    const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        result = multiply(result, transformOf(m[1], parseNumbers(m[2])));
    }
    return result;
}

function transformOf(kind: string, v: number[]): Affine {
    switch (kind) {
        case "matrix":
            return v.length >= 6 ? [v[0], v[1], v[2], v[3], v[4], v[5]] : [...IDENTITY];
        case "translate":
            return translation(v[0] ?? 0, v[1] ?? 0);
        case "scale":
            return scaling(v[0] ?? 1, v[1] ?? v[0] ?? 1);
        case "rotate": {
            // SVG's y points down, so a positive angle turns clockwise on screen — the same matrix
            const r = rotation(v[0] ?? 0);
            if (v.length < 3) return r;
            return multiply(translation(v[1], v[2]), multiply(r, translation(-v[1], -v[2])));
        }
        case "skewX":
            return [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        default:
            return [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    }
}

// ---- path data ------------------------------------------------------------------------------------

/** Commands as their letter, numbers as written (an arc's run-together flags need the digits). */
function tokenizePathData(d: string): string[] {
    return d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
}

function isCommand(token: string | undefined): boolean {
    return token !== undefined && /^[A-Za-z]$/.test(token);
}

/** Arc flags may be written without separators ("A5 5 0 0110 10"): a flag is one digit of a run. */
function arcArguments(tokens: string[], at: number): { values: number[]; next: number } | undefined {
    const values: number[] = [];
    let k = at;
    let pending: string | undefined;
    while (values.length < 7) {
        const raw = pending ?? tokens[k++];
        pending = undefined;
        if (raw === undefined || isCommand(raw)) return undefined;
        const slot = values.length;
        if (slot === 3 || slot === 4) {
            if (raw[0] !== "0" && raw[0] !== "1") return undefined;
            values.push(Number(raw[0]));
            if (raw.length > 1) pending = raw.slice(1);
            continue;
        }
        values.push(Number(raw));
    }
    if (pending !== undefined) return undefined;
    return { values, next: k };
}

/**
 * The subpaths of an SVG path's `d`, curves flattened to `tolerance` (in the path's own units).
 * Every command, absolute and relative, with the smooth-curve reflections and implicit repeats.
 */
export function parsePathData(d: string, tolerance: number): LaserPath[] {
    const tokens = tokenizePathData(d);
    const paths: LaserPath[] = [];
    let current: Pt[] = [];
    let pos: Pt = { x: 0, y: 0 };
    let start: Pt = { x: 0, y: 0 };
    let lastControl: Pt | undefined;
    let lastKind = "";
    let command = "";
    let i = 0;
    const finish = (closed: boolean) => {
        if (current.length > 1) paths.push({ points: current, closed });
        current = [];
    };
    const take = (n: number): number[] | undefined => {
        const out: number[] = [];
        for (let k = 0; k < n; k++) {
            const t = tokens[i + k];
            if (t === undefined || isCommand(t)) return undefined;
            out.push(Number(t));
        }
        i += n;
        return out;
    };
    while (i < tokens.length) {
        const token = tokens[i];
        if (isCommand(token)) {
            command = token;
            i++;
            if (command === "Z" || command === "z") {
                finish(true);
                pos = start;
                current = [pos];
                lastKind = "Z";
                lastControl = undefined;
                continue;
            }
        } else if (command === "" || command === "Z" || command === "z") {
            i++; // a stray number
            continue;
        }
        const rel = command === command.toLowerCase();
        const at = (x: number, y: number): Pt => (rel ? { x: pos.x + x, y: pos.y + y } : { x, y });
        const upper = command.toUpperCase();
        if (upper === "A") {
            const parsed = arcArguments(tokens, i);
            if (parsed === undefined) break;
            i = parsed.next;
            const [rx, ry, phi, large, sweep, x, y] = parsed.values;
            const to = at(x, y);
            flattenSvgArc(pos, rx, ry, phi, large !== 0, sweep !== 0, to, tolerance, current);
            pos = to;
            lastControl = undefined;
            lastKind = "A";
            continue;
        }
        const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2 };
        const v = take(arity[upper] ?? 0);
        if (v === undefined || arity[upper] === undefined) break;
        switch (upper) {
            case "M": {
                finish(false);
                pos = at(v[0], v[1]);
                start = pos;
                current = [pos];
                // further pairs after a moveto are linetos
                command = rel ? "l" : "L";
                lastControl = undefined;
                break;
            }
            case "L":
                pos = at(v[0], v[1]);
                current.push(pos);
                lastControl = undefined;
                break;
            case "H":
                pos = { x: rel ? pos.x + v[0] : v[0], y: pos.y };
                current.push(pos);
                lastControl = undefined;
                break;
            case "V":
                pos = { x: pos.x, y: rel ? pos.y + v[0] : v[0] };
                current.push(pos);
                lastControl = undefined;
                break;
            case "C":
            case "S": {
                const c1 =
                    upper === "C"
                        ? at(v[0], v[1])
                        : lastControl !== undefined && (lastKind === "C" || lastKind === "S")
                          ? { x: 2 * pos.x - lastControl.x, y: 2 * pos.y - lastControl.y }
                          : pos;
                const c2 = upper === "C" ? at(v[2], v[3]) : at(v[0], v[1]);
                const to = upper === "C" ? at(v[4], v[5]) : at(v[2], v[3]);
                flattenCubic(pos, c1, c2, to, tolerance, current);
                lastControl = c2;
                pos = to;
                break;
            }
            case "Q":
            case "T": {
                const c =
                    upper === "Q"
                        ? at(v[0], v[1])
                        : lastControl !== undefined && (lastKind === "Q" || lastKind === "T")
                          ? { x: 2 * pos.x - lastControl.x, y: 2 * pos.y - lastControl.y }
                          : pos;
                const to = upper === "Q" ? at(v[2], v[3]) : at(v[0], v[1]);
                flattenQuadratic(pos, c, to, tolerance, current);
                lastControl = c;
                pos = to;
                break;
            }
        }
        lastKind = upper;
    }
    finish(false);
    return paths;
}

// ---- elements ------------------------------------------------------------------------------------

const SKIPPED = new Set([
    "defs",
    "clipPath",
    "mask",
    "marker",
    "pattern",
    "symbol",
    "metadata",
    "title",
    "desc",
    "style",
    "script",
    "linearGradient",
    "radialGradient",
    "filter",
    "text",
    "image",
    "foreignObject",
]);

function styleValue(e: XmlElement, property: string): string | undefined {
    const style = e.attrs["style"];
    if (style !== undefined) {
        const m = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(style);
        if (m !== null) return m[1].trim();
    }
    return e.attrs[property];
}

function isHidden(e: XmlElement): boolean {
    return styleValue(e, "display") === "none" || styleValue(e, "visibility") === "hidden";
}

function num(e: XmlElement, name: string, fallback = 0): number {
    const v = Number.parseFloat(e.attrs[name] ?? "");
    return Number.isFinite(v) ? v : fallback;
}

function pointsPath(e: XmlElement, closed: boolean): LaserPath[] {
    const v = parseNumbers(e.attrs["points"] ?? "");
    const points: Pt[] = [];
    for (let k = 0; k + 1 < v.length; k += 2) points.push({ x: v[k], y: v[k + 1] });
    return points.length > 1 ? [{ points, closed }] : [];
}

function rectPath(e: XmlElement, tolerance: number): LaserPath[] {
    const x = num(e, "x");
    const y = num(e, "y");
    const w = num(e, "width");
    const h = num(e, "height");
    if (w <= 0 || h <= 0) return [];
    let rx = e.attrs["rx"] !== undefined ? num(e, "rx") : num(e, "ry");
    let ry = e.attrs["ry"] !== undefined ? num(e, "ry") : rx;
    rx = Math.min(Math.max(0, rx), w / 2);
    ry = Math.min(Math.max(0, ry), h / 2);
    if (rx === 0 || ry === 0) {
        const points = [
            { x, y },
            { x: x + w, y },
            { x: x + w, y: y + h },
            { x, y: y + h },
        ];
        return [{ points, closed: true }];
    }
    const d =
        `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}` +
        `A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
        `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    return parsePathData(d, tolerance);
}

/** The element's own geometry in its user units, or undefined for a container / unknown element. */
function shapeOf(e: XmlElement, tolerance: number): LaserPath[] | undefined {
    switch (e.name) {
        case "path":
            return parsePathData(e.attrs["d"] ?? "", tolerance);
        case "line":
            return [
                {
                    points: [
                        { x: num(e, "x1"), y: num(e, "y1") },
                        { x: num(e, "x2"), y: num(e, "y2") },
                    ],
                    closed: false,
                },
            ];
        case "polyline":
            return pointsPath(e, false);
        case "polygon":
            return pointsPath(e, true);
        case "rect":
            return rectPath(e, tolerance);
        case "circle": {
            const r = num(e, "r");
            return r > 0 ? [ellipsePath(num(e, "cx"), num(e, "cy"), r, r, tolerance)] : [];
        }
        case "ellipse": {
            const rx = num(e, "rx");
            const ry = num(e, "ry");
            return rx > 0 && ry > 0 ? [ellipsePath(num(e, "cx"), num(e, "cy"), rx, ry, tolerance)] : [];
        }
        default:
            return undefined;
    }
}

function indexIds(e: XmlElement, ids: Map<string, XmlElement>) {
    const id = e.attrs["id"];
    if (id !== undefined) ids.set(id, e);
    for (const child of e.children) indexIds(child, ids);
}

interface Walk {
    tolerance: number;
    ids: Map<string, XmlElement>;
    out: LaserPath[];
    depth: number;
}

function walk(e: XmlElement, ctm: Affine, w: Walk) {
    if (SKIPPED.has(e.name) || isHidden(e) || w.depth > 64) return;
    let m = multiply(ctm, parseTransform(e.attrs["transform"]));
    if (e.name === "use") {
        const href = (e.attrs["href"] ?? e.attrs["xlink:href"] ?? "").replace(/^#/, "");
        const target = w.ids.get(href);
        if (target === undefined) return;
        m = multiply(m, translation(num(e, "x"), num(e, "y")));
        w.depth++;
        // a referenced symbol is drawn as a group
        if (target.name === "symbol") for (const child of target.children) walk(child, m, w);
        else walk(target, m, w);
        w.depth--;
        return;
    }
    if (e.name === "svg" && w.depth > 0) m = multiply(m, translation(num(e, "x"), num(e, "y")));
    const shape = shapeOf(e, w.tolerance / maxScale(m));
    if (shape !== undefined) {
        for (const path of transformPaths(shape, m)) {
            const clean = cleanPath(path);
            if (clean.points.length > 1) w.out.push(clean);
        }
        return;
    }
    w.depth++;
    for (const child of e.children) walk(child, m, w);
    w.depth--;
}

export interface SvgImport {
    /** Paths in millimetres, y up, moved so their bounding box starts at (0, 0). */
    paths: LaserPath[];
    width: number;
    height: number;
}

/** From the root's width/height/viewBox: user units to millimetres, y still down. */
function rootTransform(root: XmlElement): { m: Affine; height: number } {
    const vb = parseNumbers(root.attrs["viewBox"] ?? "");
    const hasViewBox = vb.length === 4 && vb[2] > 0 && vb[3] > 0;
    const px = UNIT_MM["px"];
    const widthMm = lengthToMm(root.attrs["width"]) ?? (hasViewBox ? vb[2] * px : undefined);
    const heightMm = lengthToMm(root.attrs["height"]) ?? (hasViewBox ? vb[3] * px : undefined);
    if (!hasViewBox) return { m: scaling(px, px), height: heightMm ?? 0 };
    const w = widthMm ?? vb[2] * px;
    const h = heightMm ?? vb[3] * px;
    let sx = w / vb[2];
    let sy = h / vb[3];
    let ox = 0;
    let oy = 0;
    if (!(root.attrs["preserveAspectRatio"] ?? "").startsWith("none")) {
        const s = Math.min(sx, sy);
        ox = (w - vb[2] * s) / 2;
        oy = (h - vb[3] * s) / 2;
        sx = s;
        sy = s;
    }
    return { m: [sx, 0, 0, sy, ox - vb[0] * sx, oy - vb[1] * sy], height: h };
}

/**
 * The drawable geometry of an SVG document as millimetre polylines, y up (the bed's frame):
 * paths, lines, polylines, polygons, rects (rounded too), circles and ellipses, through every
 * group transform and `use`, scaled by the root's width/height against its viewBox. Text,
 * embedded images and anything hidden are left out.
 */
export function importSvg(xml: string, tolerance = FLATTEN_TOLERANCE): SvgImport | undefined {
    const root = parseXml(xml);
    if (root === undefined || root.name !== "svg") return undefined;
    const ids = new Map<string, XmlElement>();
    indexIds(root, ids);
    const { m } = rootTransform(root);
    // flip y so the drawing reads upright on a bed whose y points up
    const flip: Affine = [1, 0, 0, -1, 0, 0];
    const w: Walk = { tolerance, ids, out: [], depth: 0 };
    walk(root, multiply(flip, m), w);
    const bounds = pathsBounds(w.out);
    if (isEmpty(bounds)) return { paths: [], width: 0, height: 0 };
    const paths = transformPaths(w.out, translation(-bounds.minX, -bounds.minY));
    return { paths, width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY };
}
