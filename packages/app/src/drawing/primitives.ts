// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * What a composed drawing sheet is made of, in sheet millimetres (origin at the lower-left
 * corner, y up). Every exporter (SVG, PDF, DXF) and the on-screen editor draw these, so they
 * all show the same thing.
 */

export const DRAWING_LAYERS = [
    "frame",
    "visible",
    "hidden",
    "tangent",
    "center",
    "dimension",
    "text",
] as const;
export type DrawingLayer = (typeof DRAWING_LAYERS)[number];

/** Line widths per ГОСТ 2.303 with S = 0.5 mm. */
export const LINE_WIDTH = {
    thick: 0.5,
    thin: 0.25,
    frame: 0.7,
} as const;

/** Dash patterns in paper mm: dashed for hidden lines, dash-dot for centre lines. */
export const DASH_HIDDEN = [4, 1.5];
export const DASH_CENTER = [10, 2, 1.5, 2];

interface PrimitiveBase {
    layer: DrawingLayer;
    /** `view:<id>`, `dim:<id>`, `note:<id>`, or undefined for the frame and title block. */
    owner?: string;
}

export interface PolylinePrimitive extends PrimitiveBase {
    kind: "polyline";
    points: number[];
    closed?: boolean;
    width: number;
    dash?: number[];
}

export interface ArcPrimitive extends PrimitiveBase {
    kind: "arc";
    cx: number;
    cy: number;
    r: number;
    /** Radians, counter-clockwise from +x. */
    start: number;
    /** Signed sweep, radians; ±2π for a full circle. */
    sweep: number;
    width: number;
    dash?: number[];
}

/** A filled polygon: arrowheads. */
export interface FillPrimitive extends PrimitiveBase {
    kind: "fill";
    points: number[];
}

export type TextAnchor = "start" | "middle" | "end";

export interface TextPrimitive extends PrimitiveBase {
    kind: "text";
    x: number;
    y: number;
    text: string;
    /** Capital height, mm (the ГОСТ 2.304 font size). */
    height: number;
    anchor: TextAnchor;
    /** Degrees, counter-clockwise. */
    angle: number;
}

export type DrawingPrimitive = PolylinePrimitive | ArcPrimitive | FillPrimitive | TextPrimitive;

export interface ComposedSheet {
    width: number;
    height: number;
    primitives: DrawingPrimitive[];
}

/** Estimated advance of a text, mm: what layout uses before a font is at hand. */
export function estimateTextWidth(text: string, height: number): number {
    return [...text].length * height * 0.72;
}

export function line(
    layer: DrawingLayer,
    points: number[],
    width: number = LINE_WIDTH.thin,
    owner?: string,
): PolylinePrimitive {
    return { kind: "polyline", layer, points, width, owner };
}

export function text(
    layer: DrawingLayer,
    x: number,
    y: number,
    value: string,
    height: number,
    anchor: TextAnchor = "start",
    angle = 0,
    owner?: string,
): TextPrimitive {
    return { kind: "text", layer, x, y, text: value, height, anchor, angle, owner };
}

/** The sampled points of an arc, for consumers that cannot draw one natively. */
export function arcPoints(
    arc: Pick<ArcPrimitive, "cx" | "cy" | "r" | "start" | "sweep">,
    maxStep = 0.1,
): number[] {
    const n = Math.max(8, Math.ceil(Math.abs(arc.sweep) / maxStep));
    const points: number[] = [];
    for (let i = 0; i <= n; i++) {
        const a = arc.start + (arc.sweep * i) / n;
        points.push(arc.cx + arc.r * Math.cos(a), arc.cy + arc.r * Math.sin(a));
    }
    return points;
}

export interface Rect {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** Bounds of the primitives each owner draws, for hit-testing on screen. */
export function ownerBounds(primitives: readonly DrawingPrimitive[]): Map<string, Rect> {
    const result = new Map<string, Rect>();
    const grow = (owner: string, x: number, y: number) => {
        const r = result.get(owner);
        if (r === undefined) {
            result.set(owner, { minX: x, minY: y, maxX: x, maxY: y });
            return;
        }
        r.minX = Math.min(r.minX, x);
        r.minY = Math.min(r.minY, y);
        r.maxX = Math.max(r.maxX, x);
        r.maxY = Math.max(r.maxY, y);
    };
    for (const p of primitives) {
        if (p.owner === undefined) continue;
        const owner = p.owner;
        if (p.kind === "polyline" || p.kind === "fill") {
            for (let k = 0; k + 1 < p.points.length; k += 2) grow(owner, p.points[k], p.points[k + 1]);
        } else if (p.kind === "arc") {
            grow(owner, p.cx - p.r, p.cy - p.r);
            grow(owner, p.cx + p.r, p.cy + p.r);
        } else {
            const w = estimateTextWidth(p.text, p.height);
            const x0 = p.anchor === "start" ? p.x : p.anchor === "middle" ? p.x - w / 2 : p.x - w;
            const rad = (p.angle * Math.PI) / 180;
            for (const [dx, dy] of [
                [x0 - p.x, 0],
                [x0 - p.x + w, 0],
                [x0 - p.x, p.height],
                [x0 - p.x + w, p.height],
            ]) {
                grow(
                    owner,
                    p.x + dx * Math.cos(rad) - dy * Math.sin(rad),
                    p.y + dx * Math.sin(rad) + dy * Math.cos(rad),
                );
            }
        }
    }
    return result;
}
