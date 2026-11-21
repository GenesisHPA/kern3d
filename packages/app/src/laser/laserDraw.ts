// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ellipsePath } from "./flatten";
import type { LaserPath, Pt } from "./geometry";
import { type LaserShape, polygon, roundedRect } from "./shapes";

/**
 * What a drawing tool has so far, before it becomes an object: a box being dragged (rectangle,
 * ellipse, polygon from its centre) or the points of a polyline. Pure: the editor feeds it bed
 * points and draws `draftPaths` as the rubber band; `finishBox` / `finishPolyline` give the
 * figure and where it goes.
 */

export const DRAW_TOOLS = ["select", "line", "rect", "ellipse", "polygon", "text", "barcode"] as const;
export type DrawTool = (typeof DRAW_TOOLS)[number];

/** EzCAD-like single keys for the tools. */
export const TOOL_KEYS: Record<string, DrawTool> = {
    v: "select",
    l: "line",
    r: "rect",
    e: "ellipse",
    p: "polygon",
    t: "text",
    b: "barcode",
};

export type Draft =
    | { kind: "box"; tool: "rect" | "ellipse" | "polygon"; start: Pt; end: Pt; square: boolean }
    | { kind: "polyline"; points: Pt[]; hover: Pt | undefined };

export interface PolygonDefaults {
    sides: number;
    star: number;
}

/** On the millimetre grid. */
export function snapToGrid(p: Pt, step = 1): Pt {
    return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
}

/** `p` moved onto the nearest 15° ray from `from`, at the same distance. */
export function constrainAngle(from: Pt, p: Pt, stepDeg = 15): Pt {
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const d = Math.hypot(dx, dy);
    if (d === 0) return p;
    const step = (stepDeg * Math.PI) / 180;
    const a = Math.round(Math.atan2(dy, dx) / step) * step;
    return { x: from.x + d * Math.cos(a), y: from.y + d * Math.sin(a) };
}

/** The dragged box, lower-left corner and size; a square one keeps the larger side. */
export function dragBox(start: Pt, end: Pt, square: boolean): { x: number; y: number; w: number; h: number } {
    let w = Math.abs(end.x - start.x);
    let h = Math.abs(end.y - start.y);
    if (square) w = h = Math.max(w, h);
    const x = end.x >= start.x ? start.x : start.x - w;
    const y = end.y >= start.y ? start.y : start.y - h;
    return { x, y, w, h };
}

/** A polygon dragged from its centre: the radius, and the turn that puts a vertex under the pointer. */
export function polygonDrag(start: Pt, end: Pt, constrain: boolean): { radius: number; angle: number } {
    const radius = Math.hypot(end.x - start.x, end.y - start.y);
    let angle = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI - 90;
    if (constrain) angle = Math.round(angle / 15) * 15;
    return { radius, angle: Math.round(angle * 100) / 100 };
}

function moved(path: LaserPath, dx: number, dy: number, turn = 0): LaserPath {
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    return {
        closed: path.closed,
        points: path.points.map((p) => ({ x: dx + p.x * c - p.y * s, y: dy + p.x * s + p.y * c })),
    };
}

/** The rubber band in bed millimetres. */
export function draftPaths(draft: Draft, poly: PolygonDefaults): LaserPath[] {
    if (draft.kind === "polyline") {
        const points = draft.hover === undefined ? draft.points : [...draft.points, draft.hover];
        return points.length < 2 ? [] : [{ points, closed: false }];
    }
    if (draft.tool === "polygon") {
        const { radius, angle } = polygonDrag(draft.start, draft.end, draft.square);
        if (radius <= 0) return [];
        return [
            moved(
                polygon(poly.sides, radius, poly.star),
                draft.start.x,
                draft.start.y,
                (angle * Math.PI) / 180,
            ),
        ];
    }
    const b = dragBox(draft.start, draft.end, draft.square);
    if (b.w <= 0 && b.h <= 0) return [];
    if (draft.tool === "rect") return [moved(roundedRect(b.w, b.h, 0), b.x, b.y)];
    return [ellipsePath(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0.05)];
}

export interface DrawnFigure {
    shape: LaserShape;
    at: { corner?: Pt; centre?: Pt; angle?: number };
}

/** The figure a finished drag makes; undefined when it is too small to be meant (a click). */
export function finishBox(
    draft: Extract<Draft, { kind: "box" }>,
    poly: PolygonDefaults,
    minimum: number,
): DrawnFigure | undefined {
    if (draft.tool === "polygon") {
        const { radius, angle } = polygonDrag(draft.start, draft.end, draft.square);
        if (radius < minimum) return undefined;
        return {
            shape: { type: "polygon", sides: poly.sides, radius, star: poly.star },
            at: { centre: polygonBoxCentre(draft.start, poly, radius, angle), angle },
        };
    }
    const b = dragBox(draft.start, draft.end, draft.square);
    if (Math.max(b.w, b.h) < minimum) return undefined;
    const w = Math.max(b.w, 0.01);
    const h = Math.max(b.h, 0.01);
    const shape: LaserShape =
        draft.tool === "rect"
            ? { type: "rect", width: w, height: h, radius: 0 }
            : { type: "ellipse", rx: w / 2, ry: h / 2 };
    return { shape, at: { corner: { x: b.x, y: b.y } } };
}

/**
 * An odd polygon's box is not centred on its centre: the object is turned about its box's
 * middle, so that middle goes where the dragged centre puts it once turned.
 */
function polygonBoxCentre(centre: Pt, poly: PolygonDefaults, radius: number, angleDeg: number): Pt {
    const pts = polygon(poly.sides, radius, poly.star).points;
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    const ox = (minX + maxX) / 2;
    const oy = (minY + maxY) / 2;
    const a = (angleDeg * Math.PI) / 180;
    return {
        x: centre.x + ox * Math.cos(a) - oy * Math.sin(a),
        y: centre.y + ox * Math.sin(a) + oy * Math.cos(a),
    };
}

/** A polyline from its clicked points: its own frame from the lowest corner of its box. */
export function finishPolyline(points: readonly Pt[], closed: boolean): DrawnFigure | undefined {
    const clean: Pt[] = [];
    for (const p of points) {
        const last = clean[clean.length - 1];
        if (last === undefined || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) clean.push({ ...p });
    }
    if (clean.length < 2) return undefined;
    const minX = Math.min(...clean.map((p) => p.x));
    const minY = Math.min(...clean.map((p) => p.y));
    return {
        shape: {
            type: "polyline",
            points: clean.map((p) => ({ x: p.x - minX, y: p.y - minY })),
            closed: closed && clean.length >= 3,
        },
        at: { corner: { x: minX, y: minY } },
    };
}
