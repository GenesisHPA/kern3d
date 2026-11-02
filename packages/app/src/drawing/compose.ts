// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DrawingData,
    type DrawingDimensionData,
    type DrawingNoteData,
    type DrawingViewData,
    isRadialDimension,
    type LinearDimensionData,
    type Point2,
    type RadialDimensionData,
} from "./drawingData";
import type { Polyline2, ViewGeometry } from "./hlr";
import {
    type ComposedSheet,
    DASH_CENTER,
    DASH_HIDDEN,
    type DrawingLayer,
    type DrawingPrimitive,
    estimateTextWidth,
    LINE_WIDTH,
    line,
    text,
} from "./primitives";
import { composeFrame, sheetSize } from "./sheet";
import { formatScale } from "./viewBasis";

export const DIMENSION_TEXT_HEIGHT = 3.5;
const ARROW_LENGTH = 3;
const ARROW_HALF_WIDTH = 0.55;
const EXTENSION_OVERSHOOT = 2;
const EXTENSION_GAP = 1;

/** Maps a view's model 2D frame onto the sheet: centred at the view's position, scaled. */
export interface ViewPlacement {
    view: DrawingViewData;
    geometry: ViewGeometry | undefined;
    cx: number;
    cy: number;
}

export function placementOf(view: DrawingViewData, geometry: ViewGeometry | undefined): ViewPlacement {
    const b = geometry?.bounds;
    const valid = b !== undefined && Number.isFinite(b.minX);
    return {
        view,
        geometry,
        cx: valid ? (b.minX + b.maxX) / 2 : 0,
        cy: valid ? (b.minY + b.maxY) / 2 : 0,
    };
}

export function toSheet(placement: ViewPlacement, x: number, y: number): Point2 {
    const s = placement.view.scale;
    return [placement.view.x + s * (x - placement.cx), placement.view.y + s * (y - placement.cy)];
}

export function fromSheet(placement: ViewPlacement, x: number, y: number): Point2 {
    const s = placement.view.scale;
    return [placement.cx + (x - placement.view.x) / s, placement.cy + (y - placement.view.y) / s];
}

/** Model length as a dimension states it: up to two decimals, a comma for ГОСТ. */
export function formatLength(value: number, decimalComma: boolean): string {
    const rounded = Math.round(value * 100) / 100;
    const s = Number.parseFloat(rounded.toFixed(2)).toString();
    return decimalComma ? s.replace(".", ",") : s;
}

function mapPoints(placement: ViewPlacement, points: number[]): number[] {
    const result: number[] = [];
    for (let k = 0; k + 1 < points.length; k += 2)
        result.push(...toSheet(placement, points[k], points[k + 1]));
    return result;
}

function lineworkOf(
    placement: ViewPlacement,
    lines: Polyline2[],
    layer: DrawingLayer,
    width: number,
    dash: number[] | undefined,
): DrawingPrimitive[] {
    const owner = `view:${placement.view.id}`;
    const s = placement.view.scale;
    return lines.map((l): DrawingPrimitive => {
        if (l.arc !== undefined) {
            const [cx, cy] = toSheet(placement, l.arc.cx, l.arc.cy);
            return {
                kind: "arc",
                layer,
                cx,
                cy,
                r: l.arc.r * s,
                start: l.arc.start,
                sweep: l.arc.sweep,
                width,
                dash,
                owner,
            };
        }
        return { kind: "polyline", layer, points: mapPoints(placement, l.points), width, dash, owner };
    });
}

/** Centre marks on circles facing the viewer and centre lines along side-on axes. */
function centerLines(placement: ViewPlacement): DrawingPrimitive[] {
    const g = placement.geometry!;
    const owner = `view:${placement.view.id}`;
    const s = placement.view.scale;
    const result: DrawingPrimitive[] = [];
    for (const c of g.circles) {
        const r = c.r * s;
        if (r < 1) continue;
        const [x, y] = toSheet(placement, c.cx, c.cy);
        const e = r + 3;
        // ГОСТ 2.303: below 12 mm the centre lines of a circle are drawn solid
        const dash = 2 * r >= 12 ? DASH_CENTER : undefined;
        result.push({ ...line("center", [x - e, y, x + e, y], LINE_WIDTH.thin, owner), dash });
        result.push({ ...line("center", [x, y - e, x, y + e], LINE_WIDTH.thin, owner), dash });
    }
    for (const a of g.axes) {
        const [x1, y1] = toSheet(placement, a.x1, a.y1);
        const [x2, y2] = toSheet(placement, a.x2, a.y2);
        const length = Math.hypot(x2 - x1, y2 - y1);
        if (length === 0) continue;
        const dx = ((x2 - x1) / length) * 3;
        const dy = ((y2 - y1) / length) * 3;
        result.push({
            ...line("center", [x1 - dx, y1 - dy, x2 + dx, y2 + dy], LINE_WIDTH.thin, owner),
            dash: DASH_CENTER,
        });
    }
    return result;
}

function composeView(placement: ViewPlacement): DrawingPrimitive[] {
    const view = placement.view;
    const g = placement.geometry;
    const owner = `view:${view.id}`;
    if (g === undefined || !Number.isFinite(g.bounds.minX)) {
        const [x, y] = [view.x, view.y];
        return [
            {
                kind: "polyline",
                layer: "visible",
                points: [x - 20, y - 15, x + 20, y - 15, x + 20, y + 15, x - 20, y + 15],
                closed: true,
                width: LINE_WIDTH.thin,
                dash: DASH_HIDDEN,
                owner,
            },
            text("text", x, y - 1.75, "?", 3.5, "middle", 0, owner),
        ];
    }
    const result = lineworkOf(placement, g.visible, "visible", LINE_WIDTH.thick, undefined);
    if (view.showHidden)
        result.push(...lineworkOf(placement, g.hidden, "hidden", LINE_WIDTH.thin, DASH_HIDDEN));
    if (view.showTangent)
        result.push(...lineworkOf(placement, g.tangent, "tangent", LINE_WIDTH.thin, undefined));
    if (view.showCenterMarks) result.push(...centerLines(placement));
    if (view.label) {
        const [, top] = toSheet(placement, 0, g.bounds.maxY);
        result.push(text("text", view.x, top + 6, view.label, 5, "middle", 0, owner));
    }
    return result;
}

function arrow(tipX: number, tipY: number, dx: number, dy: number, owner: string): DrawingPrimitive {
    // (dx, dy): unit direction the arrow points in
    const bx = tipX - dx * ARROW_LENGTH;
    const by = tipY - dy * ARROW_LENGTH;
    const nx = -dy * ARROW_HALF_WIDTH;
    const ny = dx * ARROW_HALF_WIDTH;
    return {
        kind: "fill",
        layer: "dimension",
        points: [tipX, tipY, bx + nx, by + ny, bx - nx, by - ny],
        owner,
    };
}

/** Angle (degrees) that keeps text along a direction readable: never upside down. */
function readableAngle(dx: number, dy: number): number {
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (angle > 90.001) angle -= 180;
    if (angle <= -89.999) angle += 180;
    return angle;
}

/** Text along a line, centred on (x, y) and lifted 1 mm off it to its upper (or left) side. */
function textAlong(
    x: number,
    y: number,
    dx: number,
    dy: number,
    value: string,
    owner: string,
): DrawingPrimitive {
    const angle = readableAngle(dx, dy);
    const rad = (angle * Math.PI) / 180;
    const ux = -Math.sin(rad);
    const uy = Math.cos(rad);
    return text("dimension", x + ux, y + uy, value, DIMENSION_TEXT_HEIGHT, "middle", angle, owner);
}

export interface LinearGeometry {
    q1: Point2;
    q2: Point2;
    direction: Point2;
    normal: Point2;
    value: number;
}

/** Where a linear dimension's line runs on the sheet and what it measures on the model. */
export function linearGeometry(placement: ViewPlacement, d: LinearDimensionData): LinearGeometry {
    const p1 = toSheet(placement, d.a[0], d.a[1]);
    const p2 = toSheet(placement, d.b[0], d.b[1]);
    let dir: Point2;
    let value: number;
    if (d.kind === "horizontal") {
        dir = [1, 0];
        value = Math.abs(d.b[0] - d.a[0]);
    } else if (d.kind === "vertical") {
        dir = [0, 1];
        value = Math.abs(d.b[1] - d.a[1]);
    } else {
        const length = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) || 1;
        dir = [(p2[0] - p1[0]) / length, (p2[1] - p1[1]) / length];
        value = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
    }
    const n: Point2 = [-dir[1], dir[0]];
    const q1: Point2 = [p1[0] + n[0] * d.offset, p1[1] + n[1] * d.offset];
    const shift = (p1[0] - p2[0]) * n[0] + (p1[1] - p2[1]) * n[1] + d.offset;
    const q2: Point2 = [p2[0] + n[0] * shift, p2[1] + n[1] * shift];
    return { q1, q2, direction: dir, normal: n, value };
}

function extension(from: Point2, to: Point2, owner: string): DrawingPrimitive | undefined {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const length = Math.hypot(dx, dy);
    if (length < EXTENSION_GAP) return undefined;
    const ux = dx / length;
    const uy = dy / length;
    return line(
        "dimension",
        [
            from[0] + ux * EXTENSION_GAP,
            from[1] + uy * EXTENSION_GAP,
            to[0] + ux * EXTENSION_OVERSHOOT,
            to[1] + uy * EXTENSION_OVERSHOOT,
        ],
        LINE_WIDTH.thin,
        owner,
    );
}

function composeLinear(placement: ViewPlacement, d: LinearDimensionData, comma: boolean): DrawingPrimitive[] {
    const owner = `dim:${d.id}`;
    const g = linearGeometry(placement, d);
    const p1 = toSheet(placement, d.a[0], d.a[1]);
    const p2 = toSheet(placement, d.b[0], d.b[1]);
    const label = d.textOverride ?? formatLength(g.value, comma);
    const result: DrawingPrimitive[] = [];
    for (const e of [extension(p1, g.q1, owner), extension(p2, g.q2, owner)]) if (e) result.push(e);
    const span = Math.hypot(g.q2[0] - g.q1[0], g.q2[1] - g.q1[1]);
    const ux = span === 0 ? g.direction[0] : (g.q2[0] - g.q1[0]) / span;
    const uy = span === 0 ? g.direction[1] : (g.q2[1] - g.q1[1]) / span;
    if (span >= 2 * ARROW_LENGTH + 2) {
        result.push(line("dimension", [...g.q1, ...g.q2], LINE_WIDTH.thin, owner));
        result.push(arrow(g.q1[0], g.q1[1], -ux, -uy, owner), arrow(g.q2[0], g.q2[1], ux, uy, owner));
    } else {
        // too tight for arrows inside: they point in from outside
        const o = ARROW_LENGTH + 4;
        result.push(
            line(
                "dimension",
                [g.q1[0] - ux * o, g.q1[1] - uy * o, g.q2[0] + ux * o, g.q2[1] + uy * o],
                LINE_WIDTH.thin,
                owner,
            ),
        );
        result.push(arrow(g.q1[0], g.q1[1], ux, uy, owner), arrow(g.q2[0], g.q2[1], -ux, -uy, owner));
    }
    const mx = (g.q1[0] + g.q2[0]) / 2;
    const my = (g.q1[1] + g.q2[1]) / 2;
    result.push(textAlong(mx, my, ux, uy, label, owner));
    return result;
}

function composeRadial(placement: ViewPlacement, d: RadialDimensionData, comma: boolean): DrawingPrimitive[] {
    const owner = `dim:${d.id}`;
    const [cx, cy] = toSheet(placement, d.center[0], d.center[1]);
    const r = d.radius * placement.view.scale;
    const rad = (d.angle * Math.PI) / 180;
    const ux = Math.cos(rad);
    const uy = Math.sin(rad);
    const value = d.kind === "diameter" ? 2 * d.radius : d.radius;
    const label = d.textOverride ?? `${d.kind === "diameter" ? "Ø" : "R"}${formatLength(value, comma)}`;
    const width = estimateTextWidth(label, DIMENSION_TEXT_HEIGHT);
    const ax = cx + ux * r;
    const ay = cy + uy * r;
    const tail = width + 3;
    const start: Point2 = d.kind === "diameter" ? [cx - ux * r, cy - uy * r] : [cx, cy];
    const result: DrawingPrimitive[] = [
        line("dimension", [...start, ax + ux * tail, ay + uy * tail], LINE_WIDTH.thin, owner),
        arrow(ax, ay, ux, uy, owner),
    ];
    if (d.kind === "diameter") result.push(arrow(start[0], start[1], -ux, -uy, owner));
    result.push(textAlong(ax + ux * (1.5 + width / 2), ay + uy * (1.5 + width / 2), ux, uy, label, owner));
    return result;
}

export function dimensionValue(d: DrawingDimensionData): number {
    if (isRadialDimension(d)) return d.kind === "diameter" ? 2 * d.radius : d.radius;
    if (d.kind === "horizontal") return Math.abs(d.b[0] - d.a[0]);
    if (d.kind === "vertical") return Math.abs(d.b[1] - d.a[1]);
    return Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
}

function composeNote(note: DrawingNoteData): DrawingPrimitive[] {
    const owner = `note:${note.id}`;
    return note.text
        .split("\n")
        .map((row, i) =>
            text("text", note.x, note.y - i * note.height * 1.6, row, note.height, "start", 0, owner),
        );
}

/** The base view's scale as the title block states it, unless the user typed one. */
export function titleFields(data: DrawingData): DrawingData["titleBlock"]["fields"] {
    const fields = { ...data.titleBlock.fields };
    if (!fields.scale) {
        const base = data.views.find((v) => v.parentId === undefined) ?? data.views[0];
        if (base !== undefined) fields.scale = formatScale(base.scale);
    }
    return fields;
}

/** Everything on the sheet, given each view's projected geometry (missing ones show as "?"). */
export function composeDrawing(
    data: DrawingData,
    geometries: ReadonlyMap<string, ViewGeometry>,
): ComposedSheet {
    const [width, height] = sheetSize(data.sheet);
    const primitives = composeFrame(data, titleFields(data));
    const comma = data.titleBlock.kind === "gost";
    const placements = new Map<string, ViewPlacement>();
    for (const view of data.views) {
        const placement = placementOf(view, geometries.get(view.id));
        placements.set(view.id, placement);
        primitives.push(...composeView(placement));
    }
    for (const d of data.dimensions) {
        const placement = placements.get(d.viewId);
        if (placement === undefined) continue;
        primitives.push(
            ...(isRadialDimension(d)
                ? composeRadial(placement, d, comma)
                : composeLinear(placement, d, comma)),
        );
    }
    for (const note of data.notes) primitives.push(...composeNote(note));
    return { width, height, primitives };
}
