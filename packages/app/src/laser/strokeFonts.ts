// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Contour2D, FontOutline, GlyphOutline } from "@chili3d/core";
import type { Pt } from "./geometry";
import { parsePathData } from "./svgImport";

/**
 * Single-line (engraving) fonts: every letter a few open strokes the beam follows once, as
 * EzCAD's JSF / SHX fonts and CAD lettering are — a text in them is traced, not filled, and
 * burns many times faster than an outline font's hatch.
 *
 * Bundled (no download), each read from its own format into one frame: 1000 units to the
 * em, capitals 700 high, the baseline at 0, y up.
 *  - Hershey (Dr. A. V. Hershey, NBS; .jhf by James Hurt): Sans, Sans Bold, Serif (Times
 *    Roman), Script, Gothic. Their Cyrillic is Hershey's complex set, placed on Latin keys in cyrillic.jhf —
 *    mapped to Unicode below; it serves Hershey Serif (same style) as its own letters.
 *  - OpenGOST type A and B (LibreCAD's .lff, SIL OFL): GOST 2.304 drawing lettering with
 *    Latin and Cyrillic; the Cyrillic for the sans fonts that have none.
 *  - Relief SingleLine (isdaT, SIL OFL): an SVG font of open paths, Latin only.
 */

export const UNITS_PER_EM = 1000;
const CAP = 700;
/** Curves (LFF arcs, SVG Béziers) in font units: well under a hair at any engraving size. */
const TOLERANCE = 2;

export interface StrokeFontInfo {
    id: string;
    /** As the font menu shows it, and as the text keeps it. */
    family: string;
    /** Has its own Cyrillic; otherwise Russian letters come from `fallback`. */
    cyrillic: boolean;
    fallback?: string;
}

export const STROKE_FONTS: readonly StrokeFontInfo[] = [
    { id: "gost-b", family: "ГОСТ тип Б", cyrillic: true },
    { id: "gost-a", family: "ГОСТ тип А", cyrillic: true },
    { id: "hershey-sans", family: "Hershey Sans", cyrillic: false, fallback: "gost-b" },
    { id: "hershey-sans-bold", family: "Hershey Sans Bold", cyrillic: false, fallback: "gost-b" },
    { id: "hershey-serif", family: "Hershey Serif", cyrillic: true },
    { id: "hershey-script", family: "Hershey Script", cyrillic: false, fallback: "hershey-serif" },
    { id: "hershey-gothic", family: "Hershey Gothic", cyrillic: false, fallback: "hershey-serif" },
    { id: "relief", family: "Relief SingleLine", cyrillic: false, fallback: "gost-b" },
];

export function strokeFontInfo(id: string): StrokeFontInfo | undefined {
    return STROKE_FONTS.find((f) => f.id === id);
}

/** A glyph: its open strokes and its advance, font units. */
export interface StrokeGlyph {
    advance: number;
    strokes: Pt[][];
}

/**
 * A single-line font as the text layout takes a font: glyphs whose contours are open
 * polylines (`strokes` tells the layout not to close them). Missing letters come from the
 * fallback font.
 */
export class StrokeOutline implements FontOutline {
    readonly strokes = true;
    readonly unitsPerEm = UNITS_PER_EM;
    readonly missingAdvance: number;

    constructor(
        readonly familyName: string,
        private readonly glyphs: ReadonlyMap<number, StrokeGlyph>,
        private readonly fallback?: StrokeOutline,
    ) {
        this.missingAdvance = glyphs.get(0x20)?.advance ?? UNITS_PER_EM / 3;
    }

    strokeGlyph(code: number): StrokeGlyph | undefined {
        return this.glyphs.get(code) ?? this.fallback?.strokeGlyph(code);
    }

    glyph(code: number): GlyphOutline | undefined {
        const g = this.strokeGlyph(code);
        if (g === undefined) return undefined;
        const contours: Contour2D[] = g.strokes
            .filter((s) => s.length >= 2)
            .map((s) => ({ start: s[0], segments: s.slice(1).map((to) => ({ kind: "line" as const, to })) }));
        return { advance: g.advance, contours };
    }
}

/** Whether a font lays out open strokes (a single-line font) rather than closed outlines. */
export function isStrokeFont(font: FontOutline | undefined): boolean {
    return (font as { strokes?: boolean } | undefined)?.strokes === true;
}

// ---- Hershey (.jhf) --------------------------------------------------------------------------

/**
 * One record per line as the generator stores them: the vertex count (3 digits), then pairs
 * of characters, each a coordinate as its distance from "R"; the first pair is the glyph's
 * left and right side, " R" lifts the pen. y runs down; capitals span −12 … 9, baseline 9.
 * The glyphs of a font are characters 32, 33, … in order.
 */
export function parseJhf(data: string): StrokeGlyph[] {
    const k = CAP / 21;
    const out: StrokeGlyph[] = [];
    for (const record of data.split("\n")) {
        if (record.length < 5) continue;
        const count = Number.parseInt(record.slice(0, 3), 10);
        const body = record.slice(3, 3 + 2 * count);
        const v = (i: number) => body.charCodeAt(i) - 82;
        const left = v(0);
        const right = v(1);
        const strokes: Pt[][] = [];
        let current: Pt[] = [];
        for (let i = 1; i < count; i++) {
            if (body[2 * i] === " " && body[2 * i + 1] === "R") {
                if (current.length > 0) strokes.push(current);
                current = [];
                continue;
            }
            current.push({ x: (v(2 * i) - left) * k, y: (9 - v(2 * i + 1)) * k });
        }
        if (current.length > 0) strokes.push(current);
        out.push({ advance: (right - left) * k, strokes });
    }
    return out;
}

function asciiGlyphs(glyphs: StrokeGlyph[]): Map<number, StrokeGlyph> {
    const map = new Map<number, StrokeGlyph>();
    glyphs.forEach((g, i) => {
        if (32 + i <= 126) map.set(32 + i, g);
    });
    return map;
}

/**
 * Where cyrillic.jhf keeps each letter: the Latin key it sits on (a phonetic layout), worked
 * out by drawing the file. Ё/ё are not in it, its Й has no breve and its э is a capital
 * (the same as Э): those are made below.
 */
export const HERSHEY_CYRILLIC_KEYS: Record<string, string> = {
    А: "A",
    Б: "B",
    В: "V",
    Г: "G",
    Д: "D",
    Е: "[",
    Ж: "H",
    З: "Z",
    И: "I",
    Й: "E",
    К: "K",
    Л: "L",
    М: "M",
    Н: "N",
    О: "O",
    П: "P",
    Р: "R",
    С: "S",
    Т: "T",
    У: "Y",
    Ф: "F",
    Х: "X",
    Ц: "`",
    Ч: "J",
    Ш: "Q",
    Щ: "W",
    Ъ: "]",
    Ы: "$",
    Ь: "_",
    Э: "C",
    Ю: "U",
    Я: "^",
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "{",
    ж: "h",
    з: "z",
    и: "i",
    й: "e",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "y",
    ф: "f",
    х: "x",
    ц: "%",
    ч: "j",
    ш: "q",
    щ: "w",
    ъ: "|",
    ы: "&",
    ь: "~",
    ю: "u",
    я: "}",
};

function circle(cx: number, cy: number, r: number): Pt[] {
    const pts: Pt[] = [];
    for (let i = 0; i <= 12; i++) {
        const a = (i / 12) * 2 * Math.PI;
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return pts;
}

function glyphBox(g: StrokeGlyph) {
    let minX = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of g.strokes)
        for (const p of s) {
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        }
    return { minX, maxX, maxY };
}

/** A letter with marks over it: two dots (Ё) or a breve (Й), above its top. */
function withMark(base: StrokeGlyph, mark: "dots" | "breve"): StrokeGlyph {
    const b = glyphBox(base);
    const w = b.maxX - b.minX;
    const y = b.maxY + 110;
    const strokes = base.strokes.map((s) => s.map((p) => ({ ...p })));
    if (mark === "dots") {
        strokes.push(circle(b.minX + w * 0.3, y, 22), circle(b.minX + w * 0.7, y, 22));
    } else {
        const arc: Pt[] = [];
        for (let i = 0; i <= 10; i++) {
            const a = Math.PI + (i / 10) * Math.PI;
            arc.push({ x: b.minX + w / 2 + w * 0.22 * Math.cos(a), y: y + 10 + 70 * Math.sin(a) + 70 });
        }
        strokes.push(arc);
    }
    return { advance: base.advance, strokes };
}

function hersheyCyrillic(data: string): Map<number, StrokeGlyph> {
    const glyphs = parseJhf(data);
    const map = new Map<number, StrokeGlyph>();
    for (const [letter, key] of Object.entries(HERSHEY_CYRILLIC_KEYS)) {
        const g = glyphs[key.charCodeAt(0) - 32];
        if (g !== undefined) map.set(letter.codePointAt(0) ?? 0, g);
    }
    const at = (c: string) => map.get(c.codePointAt(0) ?? 0);
    const set = (c: string, g: StrokeGlyph | undefined) => {
        if (g !== undefined) map.set(c.codePointAt(0) ?? 0, g);
    };
    const upperE = at("Е");
    const lowerE = at("е");
    const upperI = at("И");
    set("Ё", upperE && withMark(upperE, "dots"));
    set("ё", lowerE && withMark(lowerE, "dots"));
    set("Й", upperI && withMark(upperI, "breve"));
    // э: the capital brought down to the x-height (14 of the capital's 21 units), a bit narrower
    const upperE2 = at("Э");
    if (upperE2 !== undefined) {
        const ky = 14 / 21;
        const kx = 0.8;
        set("э", {
            advance: upperE2.advance * kx,
            strokes: upperE2.strokes.map((st) => st.map((p) => ({ x: p.x * kx, y: p.y * ky }))),
        });
    }
    return map;
}

// ---- LibreCAD (.lff) -------------------------------------------------------------------------

/** The points of an arc from `a` to `b` with a DXF bulge (tan of a quarter of its angle, + ccw). */
function bulgeArc(a: Pt, b: Pt, bulge: number, out: Pt[]) {
    const theta = 4 * Math.atan(bulge);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const chord = Math.hypot(dx, dy);
    if (chord === 0 || Math.abs(theta) < 1e-9) {
        out.push(b);
        return;
    }
    const s = chord / 2 / Math.tan(theta / 2);
    const cx = (a.x + b.x) / 2 - (dy / chord) * s;
    const cy = (a.y + b.y) / 2 + (dx / chord) * s;
    const r = Math.hypot(a.x - cx, a.y - cy);
    const a0 = Math.atan2(a.y - cy, a.x - cx);
    const steps = Math.max(
        2,
        Math.ceil(Math.abs(theta) / (2 * Math.acos(Math.max(-1, 1 - 0.002 / Math.max(r, 1e-6))))),
    );
    const n = Math.min(64, steps);
    for (let i = 1; i < n; i++) {
        const t = a0 + (theta * i) / n;
        out.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
    }
    out.push(b);
}

/**
 * LibreCAD Font: "# LetterSpacing: …", "# WordSpacing: …", then "[hex] char" headers with a
 * polyline per line — "x,y;x,y,A<bulge>;…" (a bulge makes the way to that point an arc) — or
 * "C<hex>" to draw another glyph. A glyph advances by its right edge plus the letter spacing.
 */
export function parseLff(data: string): Map<number, StrokeGlyph> {
    let letterSpacing = 3;
    let wordSpacing = 6.75;
    const raw = new Map<number, { lines: string[] }>();
    let current: { lines: string[] } | undefined;
    for (const line of data.split("\n")) {
        const t = line.trim();
        if (t === "") continue;
        const meta = /^#\s*(LetterSpacing|WordSpacing)\s*:\s*([\d.]+)/i.exec(t);
        if (meta !== null) {
            if (/letter/i.test(meta[1])) letterSpacing = Number(meta[2]);
            else wordSpacing = Number(meta[2]);
            continue;
        }
        if (t.startsWith("#")) continue;
        const head = /^\[([0-9a-fA-F]+)\]/.exec(t);
        if (head !== null) {
            current = { lines: [] };
            raw.set(Number.parseInt(head[1], 16), current);
            continue;
        }
        current?.lines.push(t);
    }
    const strokesOf = (code: number, depth = 0): Pt[][] => {
        const g = raw.get(code);
        if (g === undefined || depth > 4) return [];
        const out: Pt[][] = [];
        for (const line of g.lines) {
            const ref = /^C([0-9a-fA-F]+)$/.exec(line);
            if (ref !== null) {
                out.push(...strokesOf(Number.parseInt(ref[1], 16), depth + 1));
                continue;
            }
            const pts: Pt[] = [];
            for (const item of line.split(";")) {
                const parts = item.split(",");
                if (parts.length < 2) continue;
                const p = { x: Number(parts[0]), y: Number(parts[1]) };
                if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
                const bulge = parts[2]?.startsWith("A") ? Number(parts[2].slice(1)) : 0;
                if (pts.length > 0 && bulge !== 0 && Number.isFinite(bulge))
                    bulgeArc(pts[pts.length - 1], p, bulge, pts);
                else pts.push(p);
            }
            if (pts.length > 0) out.push(pts);
        }
        return out;
    };
    // the scale that makes an H 700 high
    const h = strokesOf(0x48);
    const capTop = Math.max(...h.flat().map((p) => p.y));
    const k = Number.isFinite(capTop) && capTop > 0 ? CAP / capTop : CAP / 9;
    const glyphs = new Map<number, StrokeGlyph>();
    for (const code of raw.keys()) {
        const strokes = strokesOf(code).map((s) => s.map((p) => ({ x: p.x * k, y: p.y * k })));
        const right = Math.max(0, ...strokes.flat().map((p) => p.x));
        glyphs.set(code, { advance: right + letterSpacing * k, strokes });
    }
    glyphs.set(0x20, { advance: wordSpacing * k, strokes: [] });
    return glyphs;
}

// ---- SVG font (Relief SingleLine) ------------------------------------------------------------

/** "unitsPerEm capHeight" on the first line, then "code advance pathData" per glyph. */
export function parseSvgStrokeFont(data: string): Map<number, StrokeGlyph> {
    const [head, ...lines] = data.split("\n");
    const [, capText] = head.split(" ");
    const k = CAP / (Number(capText) || CAP);
    const glyphs = new Map<number, StrokeGlyph>();
    for (const line of lines) {
        const first = line.indexOf(" ");
        const second = line.indexOf(" ", first + 1);
        if (first < 0) continue;
        const code = Number(line.slice(0, first));
        const advance = Number(second < 0 ? line.slice(first + 1) : line.slice(first + 1, second));
        const d = second < 0 ? "" : line.slice(second + 1);
        const strokes =
            d === ""
                ? []
                : parsePathData(d, TOLERANCE / k).map((p) => {
                      const pts = p.points.map((q) => ({ x: q.x * k, y: q.y * k }));
                      if (p.closed && pts.length > 1) pts.push({ ...pts[0] });
                      return pts;
                  });
        glyphs.set(code, { advance: advance * k, strokes });
    }
    return glyphs;
}

// ---- loading ---------------------------------------------------------------------------------

type Loader = () => Promise<{ default: string }>;

const DATA: Record<string, Loader> = {
    "gost-a": () => import("./strokeFonts/gostA"),
    "gost-b": () => import("./strokeFonts/gostB"),
    "hershey-sans": () => import("./strokeFonts/hersheySans"),
    "hershey-sans-bold": () => import("./strokeFonts/hersheySansBold"),
    "hershey-serif": () => import("./strokeFonts/hersheySerif"),
    "hershey-script": () => import("./strokeFonts/hersheyScript"),
    "hershey-gothic": () => import("./strokeFonts/hersheyGothic"),
    relief: () => import("./strokeFonts/relief"),
};

async function glyphsOf(id: string): Promise<Map<number, StrokeGlyph>> {
    const data = (await DATA[id]()).default;
    if (id.startsWith("gost-")) return parseLff(data);
    if (id === "relief") return parseSvgStrokeFont(data);
    const glyphs = asciiGlyphs(parseJhf(data));
    if (id === "hershey-serif") {
        const cyrillic = hersheyCyrillic((await import("./strokeFonts/hersheyCyrillic")).default);
        for (const [code, g] of cyrillic) glyphs.set(code, g);
    }
    return glyphs;
}

const loaded = new Map<string, Promise<StrokeOutline | undefined>>();

/** A bundled single-line font with its fallback for the letters it lacks; undefined if unknown. */
export function loadStrokeFont(id: string): Promise<StrokeOutline | undefined> {
    let font = loaded.get(id);
    if (font === undefined) {
        const info = strokeFontInfo(id);
        font =
            info === undefined || DATA[id] === undefined
                ? Promise.resolve(undefined)
                : (async () => {
                      const fallback =
                          info.fallback === undefined ? undefined : await loadStrokeFont(info.fallback);
                      return new StrokeOutline(info.family, await glyphsOf(id), fallback);
                  })();
        loaded.set(id, font);
    }
    return font;
}
