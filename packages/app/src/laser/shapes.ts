// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { FontOutline } from "@chili3d/core";
import { BARCODE_FORMATS, type BarcodeSpec, barcodeGeometry } from "./barcodeShape";
import { QR_LEVELS } from "./barcodes";
import { arcSegments, ellipsePath, flattenCubic, flattenQuadratic } from "./flatten";
import { type LaserPath, type Pt, pathsBounds } from "./geometry";

/**
 * The parametric figures the laser editor draws (as EzCAD and LightBurn do): a polyline, a
 * rectangle with round corners, an ellipse, a polygon or star, and a text. An object drawn
 * with a tool keeps its `shape`, and its outlines are made from it again whenever a parameter
 * changes; «Преобразовать в кривые» drops it and leaves plain outlines.
 *
 * Every figure is made in its own millimetre frame and moved so its box starts at 0, 0 — the
 * object's frame ([0, sourceWidth] × [0, sourceHeight]). Where it sits, its turn and any
 * stretch are the object's placement, untouched by a change of parameters.
 */

export const TEXT_ALIGNS = ["left", "center", "right"] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

/** A font a text is set in: one of the catalogue's (fetched) or one installed on this computer. */
export interface LaserFontRef {
    family: string;
    /** Where the catalogue fetches it; absent for a local font. */
    url?: string;
    local?: boolean;
}

export type LaserShape =
    | { type: "polyline"; points: Pt[]; closed: boolean }
    | { type: "rect"; width: number; height: number; radius: number }
    | { type: "ellipse"; rx: number; ry: number }
    /** `star`: the inner radius as a share of the outer one; 0 is a plain polygon. */
    | { type: "polygon"; sides: number; radius: number; star: number }
    | {
          type: "text";
          text: string;
          font: LaserFontRef;
          /** Font size (the em), mm. */
          size: number;
          /** Added between letters, mm. */
          letterSpacing: number;
          /** Baseline to baseline, in font sizes. */
          lineSpacing: number;
          align: TextAlign;
          /** 0: a straight line. Otherwise the text runs along a circle of this radius, mm:
           * positive over its top (reading clockwise), negative along its bottom. */
          arcRadius: number;
      }
    | ({ type: "barcode" } & BarcodeSpec);

export type LaserShapeType = LaserShape["type"];

export interface ShapeGeometry {
    paths: LaserPath[];
    width: number;
    height: number;
    /** Why there are no outlines (an i18n key): data a barcode cannot hold. */
    error?: string;
}

/** Curves are flattened finer than an imported SVG: these are drawn to be engraved. */
const TOLERANCE = 0.02;
/** A figure is never thinner than this, so a straight line still has a box to grab. */
const MIN_SIZE = 0.01;

/** The figure's outlines in its own frame, the box from 0, 0. */
export function shapeGeometry(shape: LaserShape, font?: FontOutline): ShapeGeometry {
    // a barcode's box is its symbol and quiet zone, not just the ink
    if (shape.type === "barcode") return barcodeGeometry(shape, font, captionPaths);
    return normalize(rawPaths(shape, font));
}

/** A plain line of text for a barcode's digits. */
function captionPaths(text: string, size: number, font: FontOutline): LaserPath[] {
    return textPaths(
        {
            type: "text",
            text,
            font: { family: "" },
            size,
            letterSpacing: 0,
            lineSpacing: 1.2,
            align: "left",
            arcRadius: 0,
        },
        font,
    );
}

function rawPaths(shape: LaserShape, font: FontOutline | undefined): LaserPath[] {
    switch (shape.type) {
        case "polyline":
            return shape.points.length < 2
                ? []
                : [{ points: shape.points.map((p) => ({ ...p })), closed: shape.closed }];
        case "rect":
            return [roundedRect(shape.width, shape.height, shape.radius)];
        case "ellipse":
            return [ellipsePath(0, 0, Math.max(shape.rx, MIN_SIZE), Math.max(shape.ry, MIN_SIZE), TOLERANCE)];
        case "polygon":
            return [polygon(shape.sides, shape.radius, shape.star)];
        case "text":
            return font === undefined ? [] : textPaths(shape, font);
        case "barcode":
            return [];
    }
}

/** A text, or a barcode with its digits under it, is made with a font. */
export function needsFont(shape: LaserShape): boolean {
    return (
        shape.type === "text" ||
        (shape.type === "barcode" && shape.showText && /^(code128|ean13)$/.test(shape.format))
    );
}

/** The quiet zone each code asks for, in modules. */
export function defaultQuiet(format: BarcodeSpec["format"]): number {
    return { qr: 4, datamatrix: 1, code128: 10, ean13: 9 }[format];
}

/** Moved so its box starts at 0, 0. */
function normalize(paths: LaserPath[]): ShapeGeometry {
    const b = pathsBounds(paths);
    if (!Number.isFinite(b.minX)) return { paths: [], width: MIN_SIZE, height: MIN_SIZE };
    const moved = paths.map((p) => ({
        closed: p.closed,
        points: p.points.map((q) => ({ x: q.x - b.minX, y: q.y - b.minY })),
    }));
    return {
        paths: moved,
        width: Math.max(b.maxX - b.minX, MIN_SIZE),
        height: Math.max(b.maxY - b.minY, MIN_SIZE),
    };
}

/** Counter-clockwise from the lower edge; the corners quarter circles, at most half a side. */
export function roundedRect(width: number, height: number, radius: number): LaserPath {
    const w = Math.max(width, MIN_SIZE);
    const h = Math.max(height, MIN_SIZE);
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    if (r <= 1e-9) {
        return {
            closed: true,
            points: [
                { x: 0, y: 0 },
                { x: w, y: 0 },
                { x: w, y: h },
                { x: 0, y: h },
            ],
        };
    }
    const points: Pt[] = [];
    const n = arcSegments(r, Math.PI / 2, TOLERANCE);
    const corner = (cx: number, cy: number, from: number) => {
        for (let i = 0; i <= n; i++) {
            const a = from + (i / n) * (Math.PI / 2);
            points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
        }
    };
    corner(w - r, r, -Math.PI / 2);
    corner(w - r, h - r, 0);
    corner(r, h - r, Math.PI / 2);
    corner(r, r, Math.PI);
    return { closed: true, points: dropRepeats(points) };
}

/** A first vertex straight up; a star alternates the outer and the inner radius. */
export function polygon(sides: number, radius: number, star: number): LaserPath {
    const n = Math.max(3, Math.min(200, Math.round(sides)));
    const r = Math.max(radius, MIN_SIZE);
    const inner = Math.max(0, Math.min(0.99, star));
    const points: Pt[] = [];
    const count = inner > 0 ? 2 * n : n;
    for (let i = 0; i < count; i++) {
        const a = Math.PI / 2 + (i * 2 * Math.PI) / count;
        const k = inner > 0 && i % 2 === 1 ? inner * r : r;
        points.push({ x: k * Math.cos(a), y: k * Math.sin(a) });
    }
    return { closed: true, points };
}

function dropRepeats(points: Pt[]): Pt[] {
    const out: Pt[] = [];
    for (const p of points) {
        const last = out[out.length - 1];
        if (last === undefined || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) out.push(p);
    }
    const first = out[0];
    const last = out[out.length - 1];
    if (out.length > 1 && Math.hypot(first.x - last.x, first.y - last.y) <= 1e-9) out.pop();
    return out;
}

// ---- text ------------------------------------------------------------------------------------

interface GlyphRun {
    /** Outlines of one glyph in mm, its origin on the baseline at x = 0. */
    paths: LaserPath[];
    /** Where its origin goes along the line, mm, and how wide it is. */
    offset: number;
    advance: number;
}

/**
 * Each line laid out from the font's advances plus the letter spacing, aligned on the widest
 * line, the lines `lineSpacing` font sizes apart going down; then, for an arc, every glyph
 * turned onto the circle about the middle of its advance so the letters stay upright on it.
 */
export function textPaths(shape: Extract<LaserShape, { type: "text" }>, font: FontOutline): LaserPath[] {
    const size = Math.max(shape.size, 0.1);
    const scale = size / font.unitsPerEm;
    const lines = shape.text.split(/\r?\n/);
    const laid = lines.map((line) => layout(line, font, scale, shape.letterSpacing));
    const widest = Math.max(0, ...laid.map((l) => l.width));
    const out: LaserPath[] = [];
    laid.forEach((line, index) => {
        const shift =
            shape.align === "center"
                ? (widest - line.width) / 2
                : shape.align === "right"
                  ? widest - line.width
                  : 0;
        const baseline = -index * shape.lineSpacing * size;
        for (const g of line.glyphs) {
            if (shape.arcRadius === 0) {
                for (const p of g.paths)
                    out.push({
                        closed: p.closed,
                        points: p.points.map((q) => ({ x: q.x + shift + g.offset, y: q.y + baseline })),
                    });
                continue;
            }
            // around the middle of the run: the text's centre at the top (or bottom) of the circle
            const along = shift + g.offset + g.advance / 2 - widest / 2;
            for (const p of g.paths)
                out.push({
                    closed: p.closed,
                    points: p.points.map((q) =>
                        onArc(q.x - g.advance / 2, q.y + baseline, along, shape.arcRadius),
                    ),
                });
        }
    });
    return out;
}

/** A point of a glyph (dx from its middle, y above the baseline) on a circle of radius `r`. */
function onArc(dx: number, y: number, along: number, r: number): Pt {
    if (r > 0) {
        const a = Math.PI / 2 - (along + dx) / r;
        const rr = r + y;
        return { x: rr * Math.cos(a), y: rr * Math.sin(a) };
    }
    const R = -r;
    const a = -Math.PI / 2 + (along + dx) / R;
    const rr = R - y;
    return { x: rr * Math.cos(a), y: rr * Math.sin(a) };
}

function layout(line: string, font: FontOutline, scale: number, spacing: number) {
    const glyphs: GlyphRun[] = [];
    let pen = 0;
    let count = 0;
    for (const character of line) {
        const code = character.codePointAt(0);
        if (code === undefined) continue;
        if (count > 0) pen += spacing;
        const glyph = font.glyph(code);
        const advance = (glyph?.advance ?? font.missingAdvance) * scale;
        const paths: LaserPath[] = [];
        for (const contour of glyph?.contours ?? []) {
            const at = (v: { x: number; y: number }) => ({ x: v.x * scale, y: v.y * scale });
            let current = at(contour.start);
            const points: Pt[] = [current];
            for (const s of contour.segments) {
                const to = at(s.to);
                if (s.kind === "line") points.push(to);
                else if (s.kind === "quad") flattenQuadratic(current, at(s.c1), to, TOLERANCE, points);
                else flattenCubic(current, at(s.c1), at(s.c2), to, TOLERANCE, points);
                current = to;
            }
            const clean = dropRepeats(points);
            if (clean.length >= 3) paths.push({ closed: true, points: clean });
        }
        glyphs.push({ paths, offset: pen, advance });
        pen += advance;
        count++;
    }
    return { glyphs, width: pen };
}

// ---- stored shapes ---------------------------------------------------------------------------

function num(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A stored shape checked field by field; anything unreadable is no shape at all. */
export function parseShape(raw: any): LaserShape | undefined {
    if (raw === null || typeof raw !== "object") return undefined;
    switch (raw.type) {
        case "polyline": {
            if (!Array.isArray(raw.points)) return undefined;
            const points = raw.points
                .filter((p: any) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
                .map((p: any) => ({ x: p.x, y: p.y }));
            return points.length < 2 ? undefined : { type: "polyline", points, closed: raw.closed === true };
        }
        case "rect":
            return {
                type: "rect",
                width: Math.max(num(raw.width, 10), MIN_SIZE),
                height: Math.max(num(raw.height, 10), MIN_SIZE),
                radius: Math.max(0, num(raw.radius, 0)),
            };
        case "ellipse":
            return {
                type: "ellipse",
                rx: Math.max(num(raw.rx, 5), MIN_SIZE),
                ry: Math.max(num(raw.ry, 5), MIN_SIZE),
            };
        case "polygon":
            return {
                type: "polygon",
                sides: Math.max(3, Math.round(num(raw.sides, 6))),
                radius: Math.max(num(raw.radius, 10), MIN_SIZE),
                star: Math.max(0, Math.min(0.99, num(raw.star, 0))),
            };
        case "barcode": {
            const format = BARCODE_FORMATS.includes(raw.format) ? raw.format : "qr";
            return {
                type: "barcode",
                format,
                data: typeof raw.data === "string" ? raw.data : "",
                level: QR_LEVELS.includes(raw.level) ? raw.level : "M",
                module: Math.max(num(raw.module, 0.5), 0.01),
                quiet: Math.max(0, num(raw.quiet, defaultQuiet(format))),
                barHeight: Math.max(num(raw.barHeight, 15), 0.1),
                showText: raw.showText !== false,
                invert: raw.invert === true,
            };
        }
        case "text": {
            const font = raw.font ?? {};
            return {
                type: "text",
                text: typeof raw.text === "string" ? raw.text : "",
                font: {
                    family: typeof font.family === "string" ? font.family : "Roboto",
                    url: typeof font.url === "string" ? font.url : undefined,
                    local: font.local === true ? true : undefined,
                },
                size: Math.max(num(raw.size, 10), 0.1),
                letterSpacing: num(raw.letterSpacing, 0),
                lineSpacing: num(raw.lineSpacing, 1.2),
                align: TEXT_ALIGNS.includes(raw.align) ? raw.align : "left",
                arcRadius: num(raw.arcRadius, 0),
            };
        }
    }
    return undefined;
}
