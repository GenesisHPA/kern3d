// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.
//
// Reading EzCAD 2 project files (.ezd), ported to TypeScript from the MIT-licensed MeerK40t
// EZD parser — `meerk40t/extra/ezd.py` (https://github.com/meerk40t/meerk40t, commit
// 28427457b79816e850c338ffa57ad27828929700, Copyright (c) 2021 meerk40t). Its licence text is
// in THIRD_PARTY_NOTICES.md. The file layout (header, seek table, pens, the Huffman-packed object
// stream) and the meaning of the fields follow that source; the code is our own.

import { ellipsePath, FLATTEN_TOLERANCE, flattenCubic, flattenEllipseArc, flattenQuadratic } from "./flatten";
import {
    type Affine,
    apply,
    type Bounds,
    cleanPath,
    emptyBounds,
    isEmpty,
    type LaserPath,
    type Pt,
    pathsBounds,
    transformPaths,
    translation,
    unionBounds,
} from "./geometry";
import type { JczPen } from "./jczSettings";
import {
    defaultOperation,
    type LaserImageObject,
    type LaserMode,
    type LaserObject,
    type LaserOperation,
    type LaserVectorObject,
    newLaserId,
} from "./laserData";
import type { SvgImport } from "./svgImport";

// ---- a little-endian cursor over the file -------------------------------------------------------

export class EzdReader {
    readonly view: DataView;
    pos = 0;

    constructor(readonly bytes: Uint8Array) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    get remaining(): number {
        return this.bytes.length - this.pos;
    }

    private need(n: number) {
        if (n < 0 || this.pos + n > this.bytes.length) throw new RangeError("ezd: read past the end");
    }

    i32(): number {
        this.need(4);
        const v = this.view.getInt32(this.pos, true);
        this.pos += 4;
        return v;
    }

    u32(): number {
        this.need(4);
        const v = this.view.getUint32(this.pos, true);
        this.pos += 4;
        return v;
    }

    u16(): number {
        this.need(2);
        const v = this.view.getUint16(this.pos, true);
        this.pos += 2;
        return v;
    }

    u8(): number {
        this.need(1);
        return this.bytes[this.pos++];
    }

    f64(): number {
        this.need(8);
        const v = this.view.getFloat64(this.pos, true);
        this.pos += 8;
        return v;
    }

    take(n: number): Uint8Array {
        this.need(n);
        const out = this.bytes.subarray(this.pos, this.pos + n);
        this.pos += n;
        return out;
    }

    peekI32(at = this.pos): number | undefined {
        return at + 4 <= this.bytes.length ? this.view.getInt32(at, true) : undefined;
    }
}

/** UTF-16LE up to the first NUL. */
export function utf16(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
        const c = bytes[i] | (bytes[i + 1] << 8);
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
}

/**
 * EzCAD's generic record: an int32 count, then that many (int32 length, bytes) fields. A length
 * of −1 or one running past the data ends it early, as MeerK40t's `_parse_struct` does.
 */
export function readStruct(r: EzdReader, maxItem = 1 << 24): Uint8Array[] {
    const count = r.i32();
    const out: Uint8Array[] = [];
    if (count < 0 || count > 100_000) throw new RangeError(`ezd: bad field count ${count}`);
    for (let i = 0; i < count; i++) {
        const len = r.i32();
        if (len === -1) break;
        if (len < 0 || len > maxItem) throw new RangeError(`ezd: bad field length ${len}`);
        out.push(r.take(len));
    }
    return out;
}

/** A struct field read by its size, as `_construct` guesses it: 2 u16, 4 i32, 8 f64. */
export function num(fields: readonly Uint8Array[], i: number, fallback = 0): number {
    const b = fields[i];
    if (b === undefined) return fallback;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.length === 2) return v.getUint16(0, true);
    if (b.length === 4) return v.getInt32(0, true);
    if (b.length === 8) return v.getFloat64(0, true);
    return fallback;
}

export function point(fields: readonly Uint8Array[], i: number): Pt {
    const b = fields[i];
    if (b === undefined || b.length < 16) return { x: 0, y: 0 };
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { x: v.getFloat64(0, true), y: v.getFloat64(8, true) };
}

export function text(fields: readonly Uint8Array[], i: number): string {
    const b = fields[i];
    return b === undefined ? "" : utf16(b);
}

/** A 3×3 matrix field (9 doubles) as the 2D affine it holds: [m0 m1 m3 m4 m6 m7]. */
export function matrix(fields: readonly Uint8Array[], i: number): Affine {
    const b = fields[i];
    if (b === undefined || b.length < 72) return [1, 0, 0, 1, 0, 0];
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const m = (k: number) => v.getFloat64(8 * k, true);
    return [m(0), m(1), m(3), m(4), m(6), m(7)];
}

// ---- the Huffman-packed object stream ------------------------------------------------------------

/**
 * Decodes the vector section's payload starting at `r.pos`: a uint16 table size, entries of
 * (uint8 byte, uint32 code, uint16 bit length) — the code's low `length` bits, most significant
 * first — and then the bit stream, read MSB first, until `length` bytes came out.
 */
export function huffmanDecode(r: EzdReader, length: number): Uint8Array {
    const entries = r.u16();
    // a binary tree in flat arrays: child[2n] for a 0 bit, child[2n+1] for a 1; leaf = −1 − byte
    const child: number[] = [0, 0];
    let nodes = 1;
    for (let i = 0; i < entries; i++) {
        const byte = r.u8();
        const code = r.u32();
        const bits = r.u16();
        if (bits < 1 || bits > 32) throw new RangeError("ezd: bad Huffman code length");
        let n = 0;
        for (let k = bits - 1; k >= 0; k--) {
            const slot = 2 * n + ((code >>> k) & 1);
            if (k === 0) {
                child[slot] = -1 - byte;
                break;
            }
            if (child[slot] <= 0) {
                if (child[slot] < 0) throw new RangeError("ezd: Huffman code is a prefix of another");
                child[slot] = nodes++;
                child.push(0, 0);
            }
            n = child[slot];
        }
    }
    const out = new Uint8Array(length);
    let written = 0;
    let n = 0;
    const data = r.bytes;
    for (let p = r.pos; p < data.length && written < length; p++) {
        const byte = data[p];
        for (let k = 7; k >= 0 && written < length; k--) {
            const next = child[2 * n + ((byte >>> k) & 1)];
            if (next < 0) {
                out[written++] = -1 - next;
                n = 0;
            } else if (next === 0) {
                throw new RangeError("ezd: bit pattern with no Huffman code");
            } else n = next;
        }
    }
    r.pos = data.length;
    return written === length ? out : out.subarray(0, written);
}

// ---- objects ----------------------------------------------------------------------------------

export const EZD_TYPES: Record<number, string> = {
    1: "curve",
    3: "rect",
    4: "circle",
    5: "ellipse",
    6: "polygon",
    16: "group",
    32: "hatch",
    48: "combine",
    64: "image",
    80: "vectorFile",
    96: "spiral",
    2048: "text",
    8192: "timer",
    12288: "input",
    16384: "output",
    20480: "extendAxis",
    24576: "encoderDistance",
};

const CONTAINERS = new Set([0x10, 0x20, 0x30, 0x50, 0x60]);

export interface EzdHatch {
    /** Which of hatch 1..3 was taken (0 = none was switched on). */
    index: number;
    /** How many of the three were switched on (only the first is used). */
    enabled: number;
    pen: number;
    /** mm. */
    interval: number;
    /** Degrees from +x, in [0, 180). */
    angle: number;
    /** EzCAD's "auto rotate": degrees added after every mark (not reproduced). */
    angleStep: number;
    crosshatch: boolean;
    markContours: boolean;
    /** Values that were guessed, not read (the V1 layout keeps no spacing). */
    guessed: boolean;
}

export interface EzdObject {
    type: number;
    kind: string;
    pen: number;
    label: string;
    hidden: boolean;
    position: Pt;
    children: EzdObject[];
    /** Outlines in EzCAD's field, mm, centre origin, y up. */
    paths: LaserPath[];
    /** Hatch and spiral: the lines EzCAD cached (not used for a hatch — the fill is regenerated). */
    cached?: EzdObject;
    hatch?: EzdHatch;
    text?: { value: string; height: number; font: string };
    image?: { bmp: Uint8Array; width: number; height: number; mirrorX: boolean; mirrorY: boolean };
}

interface Ctx {
    tolerance: number;
    warnings: string[];
}

function readHeader(r: EzdReader, type: number): EzdObject {
    const h = readStruct(r);
    const state = num(h, 2);
    return {
        type,
        kind: EZD_TYPES[type] ?? `0x${type.toString(16)}`,
        pen: num(h, 0),
        label: text(h, 3),
        hidden: (state & 0x01) !== 0,
        position: point(h, 13),
        children: [],
        paths: [],
    };
}

/** The curve record: contours of line (1), quadratic (2) or cubic (3) runs; 0 = a skipped node. */
function readCurve(r: EzdReader, o: EzdObject, ctx: Ctx) {
    const count = r.u32();
    const closed = r.u32() !== 0;
    let current: Pt[] | undefined;
    const flush = () => {
        if (current !== undefined && current.length > 1) o.paths.push(cleanPath({ points: current, closed }));
        current = undefined;
    };
    for (let i = 0; i < count; i++) {
        r.u8();
        const kind = r.u8();
        r.u16();
        r.u16();
        if (kind === 0) {
            r.take(40);
            continue;
        }
        const n = r.i32();
        if (n < 0 || n > 10_000_000) throw new RangeError("ezd: bad curve point count");
        const pts: Pt[] = [];
        for (let k = 0; k < n; k++) pts.push({ x: r.f64(), y: r.f64() });
        if (pts.length === 0) continue;
        const last = current?.[current.length - 1];
        if (last === undefined || Math.hypot(last.x - pts[0].x, last.y - pts[0].y) > 1e-9) {
            flush();
            current = [pts[0]];
        }
        appendRun(current as Pt[], pts, kind, ctx.tolerance);
    }
    flush();
}

function appendRun(out: Pt[], pts: Pt[], kind: number, tolerance: number) {
    if (kind === 3) {
        for (let k = 1; k + 2 < pts.length; k += 3) {
            flattenCubic(out[out.length - 1], pts[k], pts[k + 1], pts[k + 2], tolerance, out);
        }
    } else if (kind === 2) {
        for (let k = 1; k + 1 < pts.length; k += 2) {
            flattenQuadratic(out[out.length - 1], pts[k], pts[k + 1], tolerance, out);
        }
    } else out.push(...pts.slice(1));
}

/** A rectangle with each corner optionally rounded (radius, mm). */
export function roundedRect(a: Pt, b: Pt, radii: readonly number[], tolerance: number): LaserPath {
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    const limit = Math.min(x1 - x0, y1 - y0) / 2;
    // corners counter-clockwise from the lower left, each with its arc's start angle
    const corners: [number, number, number][] = [
        [x0, y0, Math.PI],
        [x1, y0, 1.5 * Math.PI],
        [x1, y1, 0],
        [x0, y1, 0.5 * Math.PI],
    ];
    const points: Pt[] = [];
    corners.forEach(([x, y, start], i) => {
        const rad = Math.max(0, Math.min(radii[i] ?? 0, limit));
        if (rad <= 1e-9) {
            points.push({ x, y });
            return;
        }
        const cx = x + (x === x0 ? rad : -rad);
        const cy = y + (y === y0 ? rad : -rad);
        points.push({ x: cx + rad * Math.cos(start), y: cy + rad * Math.sin(start) });
        flattenEllipseArc(cx, cy, rad, rad, 0, start, Math.PI / 2, tolerance, points);
    });
    return cleanPath({ points, closed: true });
}

function placed(path: LaserPath, m: Affine): LaserPath {
    return { closed: path.closed, points: path.points.map((p) => apply(m, p)) };
}

function readShape(r: EzdReader, o: EzdObject, ctx: Ctx) {
    const a = readStruct(r);
    const tol = ctx.tolerance;
    if (o.type === 3) {
        const radii = [num(a, 2), num(a, 3), num(a, 4), num(a, 5)];
        o.paths.push(placed(roundedRect(point(a, 0), point(a, 1), radii, tol), matrix(a, 7)));
    } else if (o.type === 4) {
        const c = point(a, 0);
        const rad = Math.abs(num(a, 1));
        if (rad > 0) o.paths.push(placed(ellipsePath(c.x, c.y, rad, rad, tol), matrix(a, 5)));
    } else if (o.type === 5) {
        o.paths.push(
            ...ellipseOf(point(a, 1), point(a, 2), num(a, 3), num(a, 4), tol).map((p) =>
                placed(p, matrix(a, 6)),
            ),
        );
    } else if (o.type === 6) {
        const path = polygonOf(point(a, 1), point(a, 2), num(a, 7));
        if (path !== undefined) o.paths.push(placed(path, matrix(a, 9)));
    }
}

function ellipseOf(a: Pt, b: Pt, start: number, end: number, tol: number): LaserPath[] {
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const rx = Math.abs(b.x - a.x) / 2;
    const ry = Math.abs(b.y - a.y) / 2;
    if (rx <= 0 || ry <= 0) return [];
    let sweep = end - start;
    if (Math.abs(sweep) < 1e-9 || Math.abs(Math.abs(sweep) - 2 * Math.PI) < 1e-9) {
        return [ellipsePath(cx, cy, rx, ry, tol)];
    }
    if (sweep < 0) sweep += 2 * Math.PI;
    const pts: Pt[] = [{ x: cx + rx * Math.cos(start), y: cy + ry * Math.sin(start) }];
    flattenEllipseArc(cx, cy, rx, ry, 0, start, sweep, tol, pts);
    return [{ points: pts, closed: false }];
}

function polygonOf(a: Pt, b: Pt, sides: number): LaserPath | undefined {
    const n = Math.round(sides);
    if (!(n >= 3 && n <= 10_000)) return undefined;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const rx = (b.x - a.x) / 2;
    const ry = (b.y - a.y) / 2;
    const step = (2 * Math.PI) / n;
    const points: Pt[] = [];
    for (let i = 0; i < n; i++) {
        const t = step / 2 + i * step;
        points.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
    }
    return { points, closed: true };
}

function readText(r: EzdReader, o: EzdObject) {
    const a = readStruct(r);
    o.text = { value: text(a, 10), height: num(a, 1), font: text(a, 18) };
    const count = r.i32();
    if (count < 0 || count > 10_000) throw new RangeError("ezd: bad text record count");
    for (let i = 0; i < count; i++) {
        r.u16();
        readStruct(r);
        readStruct(r);
    }
    r.i32();
}

function readImage(r: EzdReader, o: EzdObject) {
    const a = readStruct(r);
    const start = r.pos;
    const magic = r.u16();
    const size = r.i32();
    if (magic !== 0x4d42 || size < 26) throw new RangeError("ezd: image is not a BMP");
    r.take(size - 6);
    const status = num(a, 10);
    o.image = {
        bmp: r.bytes.subarray(start, start + size),
        width: num(a, 5),
        height: num(a, 4),
        mirrorX: (status & 0x20) !== 0,
        mirrorY: (status & 0x40) !== 0,
    };
}

function readHatch(r: EzdReader, o: EzdObject) {
    const a = readStruct(r);
    if (a.length >= 3 && a.length < 6) o.hatch = oldHatch(a, o.pen);
    else if (a.length >= 42) {
        // hatch n's enable, pen, type, spacing, angle and per-mark angle step sit at these fields
        const sets = [
            [1, 2, 3, 5, 8, 18],
            [9, 10, 11, 13, 16, 19],
            [20, 21, 22, 24, 27, 28],
        ];
        const enabled = sets.filter(([en]) => num(a, en) !== 0);
        const [, pen, type, space, angle, step] = enabled[0] ?? sets[0];
        o.hatch = {
            index: enabled.length === 0 ? 0 : sets.indexOf(enabled[0]) + 1,
            enabled: enabled.length,
            pen: enabled.length === 0 ? o.pen : num(a, pen),
            interval: num(a, space),
            angle: lineAngle(num(a, angle)),
            angleStep: num(a, step),
            crosshatch: (num(a, type) & 0x400) !== 0,
            markContours: num(a, 0) !== 0,
            guessed: enabled.length === 0,
        };
    }
    // the cached result: a group record with no type word (its header struct has 15 fields)
    if (r.peekI32() === 15) o.cached = readBody(r, 0x10, { tolerance: FLATTEN_TOLERANCE, warnings: [] });
}

/** The old layout: hatch 1 packed big-endian into the third field, no spacing kept. */
function oldHatch(a: Uint8Array[], pen: number): EzdHatch {
    const blob = a[2];
    const v = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const ok = blob.length >= 116;
    return {
        index: 1,
        enabled: 1,
        pen: ok ? v.getUint32(4, false) : pen,
        interval: 0.03,
        angle: ok ? lineAngle(v.getInt32(112, false)) : 0,
        angleStep: 0,
        crosshatch: ok ? (v.getUint32(8, false) & 0x400) !== 0 : false,
        markContours: (a[0]?.[0] ?? 0) !== 0,
        guessed: true,
    };
}

/** A hatch direction in [0, 180): EzCAD keeps adding its per-mark step to the stored angle. */
export function lineAngle(degrees: number): number {
    const a = ((degrees % 180) + 180) % 180;
    return Number.isFinite(a) ? a : 0;
}

/** One object of `type` whose type word was already read. */
function readBody(r: EzdReader, type: number, ctx: Ctx): EzdObject {
    const o = readHeader(r, type);
    if (CONTAINERS.has(type)) {
        const count = r.i32();
        for (let i = 0; i < count && count <= 100_000; i++) {
            const child = readObject(r, ctx, false);
            if (child === undefined) break;
            if (child !== null) o.children.push(child);
        }
    }
    if (type === 1) readCurve(r, o, ctx);
    else if (type >= 3 && type <= 6) readShape(r, o, ctx);
    else if (type === 0x800) readText(r, o);
    else if (type === 0x40) readImage(r, o);
    else if (type === 0x20) readHatch(r, o);
    else if (type === 0x50) readStruct(r);
    else if (type === 0x60) {
        readStruct(r);
        o.cached = readBody(r, 0x10, ctx);
    } else if (type >= 0x2000) readStruct(r);
    return o;
}

/** A type word that starts a real object: a known type followed by its 15-field header. */
function looksLikeObject(r: EzdReader, at: number): boolean {
    const t = r.peekI32(at);
    return t !== undefined && EZD_TYPES[t] !== undefined && r.peekI32(at + 4) === 15;
}

/**
 * The next object: the object, null for a section terminator (type 0), undefined at the end or
 * when it cannot be read. At the top level an unreadable stretch is skipped to the next place
 * that looks like an object (MeerK40t's resync, tightened by the header check).
 */
function readObject(r: EzdReader, ctx: Ctx, top: boolean): EzdObject | null | undefined {
    if (r.remaining < 4) return undefined;
    const start = r.pos;
    const type = r.i32();
    if (type === 0) return null;
    if (EZD_TYPES[type] !== undefined) {
        try {
            return readBody(r, type, ctx);
        } catch (e) {
            ctx.warnings.push(`unreadable-object:${EZD_TYPES[type]}@${start}:${(e as Error).message}`);
        }
    } else if (!top) return undefined;
    else ctx.warnings.push(`unknown-object-type:0x${(type >>> 0).toString(16)}@${start}`);
    if (!top) return undefined;
    for (let at = start + 1; at + 8 <= r.bytes.length; at++) {
        if (looksLikeObject(r, at)) {
            r.pos = at;
            return readObject(r, ctx, top);
        }
    }
    return undefined;
}

/** Every top-level object of a decoded vector stream (sections split by 0 words are joined). */
export function readObjects(stream: Uint8Array, warnings: string[] = [], tolerance = FLATTEN_TOLERANCE) {
    const r = new EzdReader(stream);
    const ctx: Ctx = { tolerance, warnings };
    const out: EzdObject[] = [];
    for (let guard = 0; guard < 1_000_000; guard++) {
        const o = readObject(r, ctx, true);
        if (o === undefined) break;
        if (o !== null) out.push(o);
    }
    return out;
}

// ---- the file -------------------------------------------------------------------------------

export interface EzdPen extends JczPen {
    index: number;
    /** #rrggbb, EzCAD's display colour. */
    color: string;
    enabled: boolean;
    passes: number;
}

function readPen(r: EzdReader, index: number): EzdPen {
    const a = readStruct(r);
    const bgr = num(a, 0);
    const hex = (v: number) => v.toString(16).padStart(2, "0");
    return {
        index,
        name: text(a, 1),
        color: `#${hex(bgr & 0xff)}${hex((bgr >> 8) & 0xff)}${hex((bgr >> 16) & 0xff)}`,
        enabled: num(a, 2) !== 0,
        passes: Math.max(1, num(a, 4, 1)),
        speed: num(a, 5),
        power: num(a, 6),
        frequency: num(a, 7) / 1000,
        pulseWidth: 0,
        laserOnDelay: num(a, 9),
        laserOffDelay: num(a, 10),
        polygonDelay: num(a, 11),
    };
}

export interface EzdFile {
    pens: EzdPen[];
    fonts: string[];
    objects: EzdObject[];
    warnings: string[];
}

const MAGIC = "EZCADUNI";

/** The raw content of an .ezd: pens, fonts and the object tree; undefined when it is not one. */
export function readEzdFile(
    buffer: ArrayBuffer | Uint8Array,
    tolerance = FLATTEN_TOLERANCE,
): EzdFile | undefined {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.length < 16 + 8 + 180 + 140 + 28 || utf16(bytes.subarray(0, 16)) !== MAGIC) return undefined;
    const r = new EzdReader(bytes);
    // magic, two version words, three 60-byte strings, 140 unknown bytes, then the seek table
    r.pos = 16 + 8 + 180 + 140;
    const seek = {
        preview: r.i32(),
        v1: r.i32(),
        pens: r.i32(),
        font: r.i32(),
        v4: r.i32(),
        vectors: r.i32(),
    };
    const warnings: string[] = [];
    const file: EzdFile = { pens: [], fonts: [], objects: [], warnings };
    section(warnings, "pens", () => {
        if (seek.pens <= 0) return;
        r.pos = seek.pens;
        const count = r.i32();
        r.pos = r.i32();
        for (let i = 0; i < count && i < 4096; i++) file.pens.push(readPen(r, i));
    });
    section(warnings, "fonts", () => {
        if (seek.font <= 0) return;
        r.pos = seek.font;
        const count = r.i32();
        for (let i = 0; i < count && i < 1024; i++) file.fonts.push(utf16(r.take(100)));
    });
    section(warnings, "vectors", () => {
        if (seek.vectors <= 0) return;
        r.pos = seek.vectors;
        const length = r.u32();
        r.take(16);
        if (length > 1 << 30) throw new RangeError("ezd: vector section too large");
        file.objects = readObjects(huffmanDecode(r, length), warnings, tolerance);
    });
    return file;
}

function section(warnings: string[], name: string, read: () => void) {
    try {
        read();
    } catch (e) {
        warnings.push(`unreadable-section:${name}:${(e as Error).message}`);
    }
}

// ---- to the laser job -------------------------------------------------------------------------

export interface EzdImport {
    /**
     * One object per top-level EzCAD object (a group stays whole), measured from the field
     * centre — the bed's centre origin; `withOrigin` moves them for a corner-origin machine.
     */
    objects: LaserObject[];
    /** Every pen of the file; the objects' `op.pen` names one of them. */
    pens: EzdPen[];
    /** Skipped or approximated things, as `code` or `code:detail` (English, for the caller to map). */
    warnings: string[];
    /** Counts of the EzCAD objects read, by kind, nested ones included. */
    counts: Record<string, number>;
    /** For each object, the index in `pens` of the pen its operation came from (−1: none). */
    objectPens: number[];
    /** Around every object, mm, centre origin (empty when there are none). */
    bounds: Bounds;
}

/** The EzCAD pen each operation was made from (pen names repeat — EzCAD calls them all "Default"). */
const penIndexOf = new WeakMap<LaserOperation, number>();

function operationOf(pen: EzdPen | undefined, mode: LaserMode): LaserOperation {
    const op = defaultOperation(mode);
    if (pen === undefined) return op;
    const out = {
        ...op,
        power: pen.power,
        speed: pen.speed * 60,
        passes: pen.passes,
        frequency: pen.frequency > 0 ? pen.frequency : op.frequency,
        pen: pen.name,
    };
    penIndexOf.set(out, pen.index);
    return out;
}

function countKinds(objects: readonly EzdObject[], counts: Record<string, number>) {
    for (const o of objects) {
        counts[o.kind] = (counts[o.kind] ?? 0) + 1;
        countKinds(o.children, counts);
    }
}

interface Collected {
    paths: LaserPath[];
    pens: number[];
}

/** The outlines under `o` that can be burnt, with the pen of each leaf; unusable leaves warned. */
function collect(o: EzdObject, out: Collected, warnings: string[]) {
    if (o.paths.length > 0) {
        out.paths.push(...o.paths);
        out.pens.push(o.pen);
    }
    if (o.type === 0x800) warnings.push(`text-without-outline:${o.text?.value ?? ""}`);
    else if (o.type === 0x40) warnings.push("image-inside-group-skipped");
    else if (o.type >= 0x2000) warnings.push(`control-object-skipped:${o.kind}`);
    else if (EZD_TYPES[o.type] === undefined) warnings.push(`unsupported-object:${o.kind}`);
    if (o.type === 0x60 && o.cached !== undefined) {
        collect(o.cached, out, warnings);
        return;
    }
    for (const c of o.children) collect(c, out, warnings);
}

function mostCommon(values: readonly number[], fallback: number): number {
    const seen = new Map<number, number>();
    let best = fallback;
    let bestCount = 0;
    for (const v of values) {
        const n = (seen.get(v) ?? 0) + 1;
        seen.set(v, n);
        if (n > bestCount) [best, bestCount] = [v, n];
    }
    return best;
}

function vectorObject(
    name: string,
    paths: LaserPath[],
    op: LaserOperation,
    hidden: boolean,
): LaserVectorObject {
    const b = pathsBounds(paths);
    const w = Math.max(b.maxX - b.minX, 0.01);
    const h = Math.max(b.maxY - b.minY, 0.01);
    return {
        id: newLaserId(),
        name,
        kind: "vector",
        x: b.minX,
        y: b.minY,
        width: w,
        height: h,
        angle: 0,
        lockAspect: true,
        hidden: hidden ? true : undefined,
        paths: transformPaths(paths, translation(-b.minX, -b.minY)),
        sourceWidth: w,
        sourceHeight: h,
        op,
    };
}

function base64(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
}

function imageObject(o: EzdObject, pens: EzdPen[], warnings: string[]): LaserImageObject | undefined {
    const img = o.image;
    if (img === undefined || !(img.width > 0 && img.height > 0)) return undefined;
    const v = new DataView(img.bmp.buffer, img.bmp.byteOffset, img.bmp.byteLength);
    if (img.mirrorX || img.mirrorY) warnings.push(`image-mirror-ignored:${o.label}`);
    return {
        id: newLaserId(),
        name: o.label || "image",
        kind: "image",
        x: o.position.x - img.width / 2,
        y: o.position.y - img.height / 2,
        width: img.width,
        height: img.height,
        angle: 0,
        lockAspect: true,
        hidden: o.hidden ? true : undefined,
        dataUrl: `data:image/bmp;base64,${base64(img.bmp)}`,
        pixelWidth: Math.abs(v.getInt32(18, true)),
        pixelHeight: Math.abs(v.getInt32(22, true)),
        op: operationOf(pens[o.pen], "image"),
    };
}

function hatchObject(
    o: EzdObject,
    pens: EzdPen[],
    warnings: string[],
    label?: string,
): LaserVectorObject | undefined {
    const got: Collected = { paths: [], pens: [] };
    for (const c of o.children) collect(c, got, warnings);
    const hatch = o.hatch;
    const name = label ?? (o.label || "hatch");
    if (got.paths.length === 0) {
        // nothing to fill (text without outlines, say): burn the lines EzCAD cached instead
        const cached: Collected = { paths: [], pens: [] };
        if (o.cached !== undefined) collect(o.cached, cached, []);
        if (cached.paths.length === 0) return undefined;
        warnings.push(`hatch-cached-lines-used:${name}`);
        return vectorObject(name, cached.paths, operationOf(pens[hatch?.pen ?? o.pen], "line"), o.hidden);
    }
    if (hatch === undefined) {
        warnings.push(`hatch-settings-unreadable:${name}`);
        return vectorObject(name, got.paths, operationOf(pens[o.pen], "fill"), o.hidden);
    }
    if (hatch.guessed) warnings.push(`hatch-settings-guessed:${name}`);
    if (hatch.crosshatch) warnings.push(`hatch-crosshatch-single-angle:${name}`);
    if (hatch.enabled > 1) warnings.push(`hatch-extra-patterns-ignored:${name}`);
    if (hatch.angleStep !== 0) warnings.push(`hatch-auto-rotate-ignored:${name}`);
    const op = operationOf(pens[hatch.pen], "fill");
    op.fillInterval = hatch.interval > 0 ? hatch.interval : op.fillInterval;
    op.fillAngle = hatch.angle;
    // EzCAD's «обвести контур»: the outline traced with the hatch
    if (hatch.markContours) op.fillOutline = true;
    return vectorObject(name, got.paths, op, o.hidden);
}

/** A text object EzCAD keeps no outline of: an empty placeholder the size of its line. */
function textPlaceholder(o: EzdObject, pens: EzdPen[]): LaserVectorObject {
    const t = o.text ?? { value: "", height: 1, font: "" };
    const h = Math.max(t.height, 0.01);
    const w = Math.max(h * 0.6 * t.value.length, 0.01);
    return {
        ...vectorObject(`text: ${t.value}`, [], operationOf(pens[o.pen], "line"), o.hidden),
        x: o.position.x - w / 2,
        y: o.position.y - h / 2,
        width: w,
        height: h,
        sourceWidth: w,
        sourceHeight: h,
    };
}

/**
 * A hatched text is stored as the text record followed by a hatch at the same place holding the
 * glyph outlines: that hatch is the text's geometry.
 */
function isTextHatch(text: EzdObject, next: EzdObject | undefined): next is EzdObject {
    if (text.type !== 0x800 || next?.type !== 0x20) return false;
    return Math.hypot(text.position.x - next.position.x, text.position.y - next.position.y) < 1e-3;
}

function toLaser(o: EzdObject, pens: EzdPen[], warnings: string[]): LaserObject | undefined {
    if (o.type === 0x40) return imageObject(o, pens, warnings);
    if (o.type === 0x20) return hatchObject(o, pens, warnings);
    if (o.type === 0x800) {
        warnings.push(`text-without-outline:${o.text?.value ?? ""}`);
        return textPlaceholder(o, pens);
    }
    const got: Collected = { paths: [], pens: [] };
    collect(o, got, warnings);
    if (got.paths.length === 0) return undefined;
    if (new Set(got.pens).size > 1) warnings.push(`mixed-pens:${o.label || o.kind}`);
    const op = operationOf(pens[mostCommon(got.pens, o.pen)], "line");
    return vectorObject(o.label || o.kind, got.paths, op, o.hidden);
}

/**
 * An EzCAD 2 project as laser objects: curves (lines, quadratic and cubic Béziers), rectangles
 * (rounded corners too), circles, ellipses and arcs, polygons, groups, combines and vector files
 * as line objects; hatches as fill objects with the hatch's pen, spacing and angle; bitmaps as
 * image objects. Each object takes its pen's power, speed (mm/s → mm/min), passes and frequency.
 * Text with no outline in the file becomes an empty placeholder; I/O, timer and axis objects are
 * skipped — both reported in `warnings`. Undefined when the bytes are not an .ezd.
 */
export function importEzd(
    buffer: ArrayBuffer | Uint8Array,
    tolerance = FLATTEN_TOLERANCE,
): EzdImport | undefined {
    const file = readEzdFile(buffer, tolerance);
    if (file === undefined) return undefined;
    const warnings = [...file.warnings];
    const counts: Record<string, number> = {};
    countKinds(file.objects, counts);
    const objects: LaserObject[] = [];
    for (let i = 0; i < file.objects.length; i++) {
        const o = file.objects[i];
        const next = file.objects[i + 1];
        let laser: LaserObject | undefined;
        if (isTextHatch(o, next)) {
            laser = hatchObject(next, file.pens, warnings, `text: ${o.text?.value.trim() ?? ""}`);
            i++;
        } else laser = toLaser(o, file.pens, warnings);
        if (laser !== undefined) objects.push(laser);
        else if (o.type < 0x2000 && o.type !== 0x800)
            warnings.push(`empty-object-skipped:${o.label || o.kind}`);
    }
    let bounds = emptyBounds();
    for (const o of objects) {
        bounds = unionBounds(bounds, { minX: o.x, minY: o.y, maxX: o.x + o.width, maxY: o.y + o.height });
    }
    const objectPens = objects.map((o) => penIndexOf.get(o.op) ?? -1);
    return { objects, pens: file.pens, warnings: [...new Set(warnings)], counts, objectPens, bounds };
}

/** Every vector outline of the import as one drawing, the shape `importSvg` gives. */
export function ezdAsSvgImport(imported: EzdImport | undefined): SvgImport | undefined {
    if (imported === undefined) return undefined;
    const paths: LaserPath[] = [];
    for (const o of imported.objects) {
        if (o.kind === "vector") paths.push(...transformPaths(o.paths, translation(o.x, o.y)));
    }
    const b = pathsBounds(paths);
    if (isEmpty(b)) return { paths: [], width: 0, height: 0 };
    return {
        paths: transformPaths(paths, translation(-b.minX, -b.minY)),
        width: b.maxX - b.minX,
        height: b.maxY - b.minY,
    };
}
