// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { symmetryAxes } from "./centerMarks";
import { linearGeometry } from "./compose";
import {
    type DrawingData,
    type DrawingDimensionData,
    type DrawingViewData,
    isRadialDimension,
    type LinearDimensionKind,
    newDrawingItemId,
    type Point2,
    type ProjectionSide,
    type Vec3,
} from "./drawingData";
import {
    layoutStandardViews,
    newView,
    projectedView,
    type ViewGeometryCache,
    viewBasisOf,
} from "./drawingViews";
import type { HlrInput, Polyline2, ViewGeometry } from "./hlr";
import { pointSegmentDistance } from "./hlr";
import { placementOf, toSheet, type ViewPlacement } from "./placement";
import { cutTraceHost, traceOn } from "./sectionMarks";
import { drawingArea, reservedRects } from "./sheet";
import { cross, dot, formatScale, normalize, STANDARD_SCALES } from "./viewBasis";

/**
 * A drawing laid out by the rules rather than by hand (ГОСТ 2.305, 2.307):
 *
 * - the model is read as planes and cylinders: the coordinates along each model axis at
 *   which faces lie, and every cylinder's axis, radius, extent, and whether it is a hole;
 * - a view sees holes side-on → it becomes a full cut through the most of them (А–А, Б–Б…);
 * - every coordinate is dimensioned once, from the part's base face on that axis, on the view
 *   where the feature is seen best — a hole's position on the view showing it as a circle, a
 *   face's on one showing it as a visible line; a blind hole's depth from its opening face;
 * - diameters: a hole's where it is a circle (a set of equal holes once, "4 отв. Ø8"), a
 *   turned part's along its side; arcs get R;
 * - dimension lines go outside the views, on the side away from their neighbours, 10 mm from
 *   the contour and 7 mm apart, the shorter ones closer in; the views are spaced to make room
 *   and the scale is the largest standard one at which all of it fits the sheet.
 */

/** A circle family of the model: coaxial circles of one radius, a hole or a boss. */
export interface Cylinder {
    /** Unit axis, sign fixed so its largest component is positive. */
    axis: Vec3;
    /** The model axis it runs along, when it does. */
    axisIndex: number | undefined;
    /** A point on the axis (a circle's centre). */
    point: Vec3;
    radius: number;
    /** Extent along `axis`: the positions (point · axis) of its first and last circle. */
    lo: number;
    hi: number;
    /** Some circle of it is whole: a Ø; otherwise it is only arcs, an R. */
    full: boolean;
    /** The material is outside it: a hole. */
    concave: boolean;
    /** For arcs: a point halfway along one, where an R leader can land. */
    arcMid?: Vec3;
}

type Side = "up" | "down" | "left" | "right";

interface PlannedLinear {
    type: "linear";
    viewId: string;
    kind: LinearDimensionKind;
    a: Point2;
    b: Point2;
    side: Side;
    prefix?: string;
}

interface PlannedRadial {
    type: "radial";
    viewId: string;
    kind: "diameter" | "radius";
    center: Point2;
    radius: number;
    angle: number;
    prefix?: string;
}

type Planned = PlannedLinear | PlannedRadial;

export interface Margins {
    up: number;
    down: number;
    left: number;
    right: number;
}

const FIRST_TIER = 10;
const TIER_STEP = 7;
const TEXT_ROOM = 5;
const VIEW_GAP = 20;
const MARGIN_GAP = 12;
/** ГОСТ 2.316 letters for sections, skipping Ё, З, Й, О, Х, Ъ, Ы, Ь. */
const SECTION_LETTERS = ["А", "Б", "В", "Г", "Д", "Е", "Ж", "И", "К", "Л", "М", "Н", "П", "Р", "С", "Т"];

function sub(a: Vec3, b: Vec3): Vec3 {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scaled(a: Vec3, s: number): Vec3 {
    return [a[0] * s, a[1] * s, a[2] * s];
}

function canonicalAxis(a: Vec3): Vec3 {
    const n = normalize(a);
    let k = 0;
    for (let i = 1; i < 3; i++) if (Math.abs(n[i]) > Math.abs(n[k])) k = i;
    return n[k] < 0 ? scaled(n, -1) : n;
}

function axisIndexOf(a: Vec3): number | undefined {
    for (let i = 0; i < 3; i++) if (Math.abs(a[i]) > 1 - 1e-9) return i;
    return undefined;
}

function distanceToAxis(p: Vec3, point: Vec3, axis: Vec3): number {
    const d = sub(p, point);
    const along = dot(d, axis);
    return Math.hypot(d[0] - axis[0] * along, d[1] - axis[1] * along, d[2] - axis[2] * along);
}

/** The size of the model and the tolerance its coordinates are compared with. */
export function modelTolerance(input: HlrInput): number {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const e of input.edges) {
        for (const p of e.points) {
            for (let i = 0; i < 3; i++) {
                lo[i] = Math.min(lo[i], p[i]);
                hi[i] = Math.max(hi[i], p[i]);
            }
        }
    }
    const size = Number.isFinite(lo[0]) ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 1;
    return size * 1e-5 + 1e-6;
}

/** The model's extent along each axis: [min, max] of every edge point. */
function extentsOf(input: HlrInput): [number, number][] {
    const result: [number, number][] = [
        [Infinity, -Infinity],
        [Infinity, -Infinity],
        [Infinity, -Infinity],
    ];
    for (const e of input.edges) {
        for (const p of e.points) {
            for (let i = 0; i < 3; i++) {
                result[i][0] = Math.min(result[i][0], p[i]);
                result[i][1] = Math.max(result[i][1], p[i]);
            }
        }
    }
    return result;
}

/** The swept angle of a sampled arc round `center`. */
function sweepOf(points: Vec3[], center: Vec3): number {
    let total = 0;
    for (let k = 1; k < points.length; k++) {
        const a = sub(points[k - 1], center);
        const b = sub(points[k], center);
        const c = cross(a, b);
        total += Math.atan2(Math.hypot(c[0], c[1], c[2]), dot(a, b));
    }
    return total;
}

/** Hole or boss: which way the mesh normals on the cylinder's wall point, in or out. */
function isConcave(input: HlrInput, c: Cylinder, tolerance: number): boolean {
    let inward = 0;
    let outward = 0;
    const p = input.position;
    const n = input.normal;
    const wall = Math.max(tolerance * 10, c.radius * 1e-3);
    for (let i = 0; i + 2 < p.length; i += 3) {
        const d: Vec3 = [p[i] - c.point[0], p[i + 1] - c.point[1], p[i + 2] - c.point[2]];
        const along = dot(d, c.axis);
        const t = dot(c.point, c.axis) + along;
        if (t < c.lo - wall || t > c.hi + wall) continue;
        const radial: Vec3 = [d[0] - c.axis[0] * along, d[1] - c.axis[1] * along, d[2] - c.axis[2] * along];
        const r = Math.hypot(radial[0], radial[1], radial[2]);
        if (r === 0 || Math.abs(r - c.radius) > wall) continue;
        const dn = (n[i] * radial[0] + n[i + 1] * radial[1] + n[i + 2] * radial[2]) / r;
        if (dn < -0.5) inward++;
        else if (dn > 0.5) outward++;
    }
    return inward > outward;
}

/** Every circular edge of the model, gathered into cylinders by axis line and radius. */
export function cylindersOf(input: HlrInput, tolerance = modelTolerance(input)): Cylinder[] {
    const result: { cylinder: Cylinder; sweeps: Map<number, number> }[] = [];
    for (const edge of input.edges) {
        const circle = edge.circle;
        if (circle === undefined || edge.points.length < 2) continue;
        const axis = canonicalAxis(circle.axis);
        const t = dot(circle.center, axis);
        let entry = result.find(
            ({ cylinder: c }) =>
                Math.abs(Math.abs(dot(c.axis, axis)) - 1) < 1e-9 &&
                Math.abs(c.radius - circle.radius) <= tolerance &&
                distanceToAxis(circle.center, c.point, c.axis) <= tolerance,
        );
        if (entry === undefined) {
            entry = {
                cylinder: {
                    axis,
                    axisIndex: axisIndexOf(axis),
                    point: circle.center,
                    radius: circle.radius,
                    lo: t,
                    hi: t,
                    full: false,
                    concave: false,
                },
                sweeps: new Map(),
            };
            result.push(entry);
        }
        const c = entry.cylinder;
        c.lo = Math.min(c.lo, t);
        c.hi = Math.max(c.hi, t);
        const key = Math.round(t / (tolerance * 10));
        const sweep = (entry.sweeps.get(key) ?? 0) + sweepOf(edge.points, circle.center);
        entry.sweeps.set(key, sweep);
        if (sweep > 2 * Math.PI * 0.99) c.full = true;
        if (c.arcMid === undefined) c.arcMid = edge.points[Math.floor(edge.points.length / 2)];
    }
    const cylinders = result.map((x) => x.cylinder);
    for (const c of cylinders) {
        c.concave = isConcave(input, c, tolerance);
        if (c.full) c.arcMid = undefined;
    }
    return cylinders;
}

/** A coordinate along one model axis at which something is to be dimensioned. */
interface Coordinate {
    value: number;
    /** A face lies there: a non-circular edge runs at it. */
    face: boolean;
    /** A circle of a cylinder along this axis ends there. */
    rims: Cylinder[];
    /** The axis of a cylinder across this axis runs through it. */
    centers: Cylinder[];
}

function coordinatesAlong(
    axis: number,
    input: HlrInput,
    cylinders: Cylinder[],
    tolerance: number,
    placed: ReadonlySet<Cylinder> = new Set(),
): Coordinate[] {
    const result: Coordinate[] = [];
    const at = (value: number): Coordinate => {
        let c = result.find((x) => Math.abs(x.value - value) <= tolerance);
        if (c === undefined) {
            c = { value, face: false, rims: [], centers: [] };
            result.push(c);
        }
        return c;
    };
    for (const edge of input.edges) {
        if (edge.tangent || edge.circle !== undefined || edge.points.length < 2) continue;
        const v = edge.points[0][axis];
        if (edge.points.every((p) => Math.abs(p[axis] - v) <= tolerance)) at(v).face = true;
    }
    for (const c of cylinders) {
        if (c.axisIndex === axis) {
            // its circles lie at constant coordinates along the axis: where it begins and ends
            const sign = c.axis[axis];
            for (const t of [c.lo, c.hi]) {
                const rims = at(t * sign).rims;
                if (!rims.includes(c)) rims.push(c);
            }
        } else if (c.axisIndex !== undefined) {
            if (placed.has(c)) continue;
            if (!c.full && !roundEnd(c, axis, input, result, tolerance)) continue;
            at(c.point[axis]).centers.push(c);
        }
    }
    return result.sort((a, b) => a.value - b.value);
}

/**
 * An arc ending the part along an axis (a slot's round end): dimensioned to its centre, as
 * the part has no face there. A fillet rounds a corner between faces and is not.
 */
function roundEnd(c: Cylinder, axis: number, input: HlrInput, coordinates: Coordinate[], tolerance: number) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const e of input.edges) {
        for (const p of e.points) {
            lo = Math.min(lo, p[axis]);
            hi = Math.max(hi, p[axis]);
        }
    }
    const reach = [c.point[axis] - c.radius, c.point[axis] + c.radius];
    const end = reach.find((x) => Math.abs(x - lo) <= tolerance * 10 || Math.abs(x - hi) <= tolerance * 10);
    if (end === undefined) return false;
    return !coordinates.some((x) => x.face && Math.abs(x.value - end) <= tolerance * 10);
}

// ---- views ------------------------------------------------------------------------------

function orthographic(view: DrawingViewData): boolean {
    return view.orientation !== "iso" && view.orientation !== "custom";
}

/** Which sheet axis (0 = x, 1 = y) a model axis runs along in a view, and its sign. */
function roleIn(view: DrawingViewData, axis: number): [number, number] | undefined {
    const b = viewBasisOf(view);
    if (Math.abs(b.u[axis]) > 0.999) return [0, Math.sign(b.u[axis])];
    if (Math.abs(b.v[axis]) > 0.999) return [1, Math.sign(b.v[axis])];
    return undefined;
}

function project2(view: DrawingViewData, p: Vec3): Point2 {
    const b = viewBasisOf(view);
    return [dot(p, b.u), dot(p, b.v)];
}

function segmentsOf(
    lines: readonly Polyline2[],
    visit: (x1: number, y1: number, x2: number, y2: number) => boolean,
) {
    for (const line of lines) {
        const p = line.points;
        for (let k = 0; k + 3 < p.length; k += 2) if (visit(p[k], p[k + 1], p[k + 2], p[k + 3])) return true;
    }
    return false;
}

/** A line of the view runs across sheet axis `k` at `x`: a face seen edge-on. */
function lineAt(lines: readonly Polyline2[], k: number, x: number, tolerance: number): boolean {
    const o = 1 - k;
    return segmentsOf(
        lines,
        (x1, y1, x2, y2) =>
            Math.abs([x1, y1][k] - x) <= tolerance &&
            Math.abs([x2, y2][k] - x) <= tolerance &&
            Math.abs([x2, y2][o] - [x1, y1][o]) > tolerance,
    );
}

/** The point of the view's line work at `x` along sheet axis `k` furthest toward `high`. */
function pointAt(
    g: ViewGeometry,
    k: number,
    x: number,
    high: boolean,
    tolerance: number,
): Point2 | undefined {
    for (const lines of [g.visible, g.hidden]) {
        let best: Point2 | undefined;
        for (const line of lines) {
            const p = line.points;
            for (let i = 0; i + 1 < p.length; i += 2) {
                const q: Point2 = [p[i], p[i + 1]];
                if (Math.abs(q[k] - x) > tolerance) continue;
                if (best === undefined || (high ? q[1 - k] > best[1 - k] : q[1 - k] < best[1 - k])) best = q;
            }
        }
        if (best !== undefined) return best;
    }
    return undefined;
}

/** The sides of each view taken by its neighbours (the parent and the views projected from it). */
function occupiedSides(data: DrawingData): Map<string, Set<Side>> {
    const opposite: Record<ProjectionSide, Side> = { up: "down", down: "up", left: "right", right: "left" };
    const result = new Map<string, Set<Side>>(data.views.map((v) => [v.id, new Set<Side>()]));
    for (const v of data.views) {
        if (v.parentId === undefined || v.side === undefined) continue;
        result.get(v.parentId)?.add(v.side);
        result.get(v.id)?.add(opposite[v.side]);
    }
    return result;
}

function sideFor(occupied: Set<Side> | undefined, k: number): Side {
    if (k === 0) return occupied?.has("up") && !occupied.has("down") ? "down" : "up";
    return occupied?.has("left") && !occupied.has("right") ? "right" : "left";
}

/** Views in the order dimensions prefer them: the main view (or its section) first. */
function viewPriority(data: DrawingData): DrawingViewData[] {
    const views = data.views.filter(orthographic);
    const root = views.find((v) => v.parentId === undefined);
    return root === undefined ? views : [root, ...views.filter((v) => v !== root)];
}

// ---- sections ----------------------------------------------------------------------------

/**
 * Turns views into full cuts where holes run across them: for each view in priority order,
 * the plane along its direction through the axes of the most holes not yet cut. Views left
 * with nothing hidden but cut holes stop drawing hidden lines.
 */
export function autoSections(data: DrawingData, cylinders: Cylinder[], tolerance: number) {
    const holes = cylinders.filter((c) => c.concave && c.full);
    const cut = new Set<Cylinder>();
    let letter = 0;
    for (const view of viewPriority(data)) {
        view.section = undefined;
        const w = viewBasisOf(view).w;
        const across = holes.filter((h) => !cut.has(h) && Math.abs(dot(h.axis, w)) < 1e-6);
        if (across.length === 0) continue;
        let best: { offset: number; holes: Cylinder[] } | undefined;
        for (const h of across) {
            const offset = dot(h.point, w);
            const on = across.filter((x) => Math.abs(dot(x.point, w) - offset) <= tolerance * 10);
            if (best === undefined || on.length > best.holes.length) best = { offset, holes: on };
        }
        if (best === undefined || letter >= SECTION_LETTERS.length) continue;
        view.section = { offset: best.offset, name: SECTION_LETTERS[letter++] };
        view.showHidden = false;
        // one cut shows a set of equal holes: the callout "4 отв." says the rest are alike
        for (const h of best.holes) for (const x of holes) if (sameHole(x, h, tolerance)) cut.add(x);
    }
    for (const view of viewPriority(data)) {
        if (view.section !== undefined) continue;
        const w = viewBasisOf(view).w;
        const hidden = holes.filter((h) => Math.abs(dot(h.axis, w)) < 1e-6);
        view.showHidden = hidden.some((h) => !cut.has(h));
    }
}

/**
 * A section for one view, asked for by hand: through the axes of the most holes across it,
 * or through the middle of the model when there are none; lettered after the cuts there are.
 */
export function sectionThrough(
    data: DrawingData,
    view: DrawingViewData,
    input: HlrInput | undefined,
): { offset: number; name: string } {
    const w = viewBasisOf(view).w;
    const used = new Set(data.views.map((v) => v.section?.name).filter((x) => x !== undefined));
    const name = SECTION_LETTERS.find((x) => !used.has(x)) ?? "А";
    if (input === undefined) return { offset: 0, name };
    const tolerance = modelTolerance(input);
    const across = cylindersOf(input, tolerance).filter(
        (c) => c.concave && c.full && Math.abs(dot(c.axis, w)) < 1e-6,
    );
    let best: { offset: number; count: number } | undefined;
    for (const h of across) {
        const offset = dot(h.point, w);
        const count = across.filter((x) => Math.abs(dot(x.point, w) - offset) <= tolerance * 10).length;
        if (best === undefined || count > best.count) best = { offset, count };
    }
    if (best !== undefined) return { offset: best.offset, name };
    let lo = Infinity;
    let hi = -Infinity;
    for (const e of input.edges) {
        for (const p of e.points) {
            const d = dot(p, w);
            lo = Math.min(lo, d);
            hi = Math.max(hi, d);
        }
    }
    return { offset: Number.isFinite(lo) ? (lo + hi) / 2 : 0, name };
}

// ---- dimensions --------------------------------------------------------------------------

function circleIn(view: DrawingViewData, c: Cylinder): boolean {
    return Math.abs(Math.abs(dot(viewBasisOf(view).w, c.axis)) - 1) < 1e-6;
}

function sideOn(view: DrawingViewData, c: Cylinder): boolean {
    return Math.abs(dot(viewBasisOf(view).w, c.axis)) < 1e-6;
}

/** Holes alike enough to be called out once: size, direction and length. */
function sameHole(a: Cylinder, b: Cylinder, tolerance: number): boolean {
    return (
        a.concave === b.concave &&
        a.full === b.full &&
        Math.abs(a.radius - b.radius) <= tolerance &&
        Math.abs(Math.abs(dot(a.axis, b.axis)) - 1) < 1e-9 &&
        Math.abs(a.hi - a.lo - (b.hi - b.lo)) <= tolerance * 10
    );
}

function leaderAngle(view: DrawingViewData, g: ViewGeometry, center: Point2, taken: number[]): number {
    const mx = (g.bounds.minX + g.bounds.maxX) / 2;
    const my = (g.bounds.minY + g.bounds.maxY) / 2;
    const dx = center[0] - mx;
    const dy = center[1] - my;
    const preferred = Math.hypot(dx, dy) < 1e-9 ? 45 : (Math.atan2(dy, dx) * 180) / Math.PI;
    const options = [45, 135, 315, 225].sort(
        (a, b) => angularDistance(a, preferred) - angularDistance(b, preferred),
    );
    return options.find((a) => !taken.includes(a)) ?? options[0];
}

function angularDistance(a: number, b: number): number {
    const d = Math.abs(((a - b) % 360) + 360) % 360;
    return Math.min(d, 360 - d);
}

/**
 * Plans the dimensions of a source's model on the drawing's views: which view and side each
 * one goes on and what it measures. Placement on paper (the tiers) comes after the layout.
 */
export function planDimensions(
    data: DrawingData,
    input: HlrInput,
    geometries: ReadonlyMap<string, ViewGeometry>,
    cylinders = cylindersOf(input),
    mode: "full" | "basic" = "full",
): Planned[] {
    const tolerance = modelTolerance(input);
    const basic = mode === "basic";
    const extents = extentsOf(input);
    // a turned outer surface: its diameter is the part's size across its axis
    const outer = (c: Cylinder) =>
        !c.concave &&
        c.axisIndex !== undefined &&
        [0, 1, 2]
            .filter((i) => i !== c.axisIndex)
            .every(
                (i) =>
                    Math.abs(c.point[i] - c.radius - extents[i][0]) <= tolerance * 100 &&
                    Math.abs(c.point[i] + c.radius - extents[i][1]) <= tolerance * 100,
            );
    const views = viewPriority(data).filter((v) => geometries.has(v.id));
    const occupied = occupiedSides(data);
    const planned: Planned[] = [];
    const tolerance2 = (g: ViewGeometry) =>
        Math.hypot(g.bounds.maxX - g.bounds.minX, g.bounds.maxY - g.bounds.minY) * 1e-3 + 1e-6;

    const linear = (
        view: DrawingViewData,
        k: number,
        from: Point2,
        to: Point2,
        prefix?: string,
    ): PlannedLinear => ({
        type: "linear",
        viewId: view.id,
        kind: k === 0 ? "horizontal" : "vertical",
        a: from,
        b: to,
        side: sideFor(occupied.get(view.id), k),
        prefix,
    });

    // -- diameters and radii
    const called = new Set<Cylinder>();
    const placedByPitch = new Set<Cylinder>();
    const radialAngles = new Map<string, number[]>();
    const radii = new Set<string>();
    const sideOnDiameter = (c: Cylinder, prefix?: string) => {
        for (const view of views) {
            if (!sideOn(view, c)) continue;
            // a hole is seen lengthwise only in a section whose plane runs through its axis
            if (c.concave) {
                const w = viewBasisOf(view).w;
                if (
                    view.section === undefined ||
                    Math.abs(dot(c.point, w) - view.section.offset) > tolerance * 10
                )
                    continue;
            }
            const g = geometries.get(view.id)!;
            const axis2 = project2(view, c.axis);
            // k: the sheet axis the diameter is measured along, across the cylinder's axis
            const k: 0 | 1 | -1 = Math.abs(axis2[0]) > 0.999 ? 1 : Math.abs(axis2[1]) > 0.999 ? 0 : -1;
            if (k === -1) continue;
            const center = project2(view, c.point);
            const t = tolerance2(g);
            if (
                !lineAt(g.visible, k, center[k] - c.radius, t) ||
                !lineAt(g.visible, k, center[k] + c.radius, t)
            )
                continue;
            // extension lines from the end of the cylinder nearer the dimension's side
            const side = sideFor(occupied.get(view.id), k);
            const high = side === "up" || side === "right";
            const along = dot(c.point, c.axis);
            const ends = [c.lo, c.hi].map(
                (x) =>
                    project2(view, [0, 1, 2].map((i) => c.point[i] + c.axis[i] * (x - along)) as Vec3)[1 - k],
            );
            const at = high ? Math.max(...ends) : Math.min(...ends);
            const a: Point2 = k === 0 ? [center[0] - c.radius, at] : [at, center[1] - c.radius];
            const b: Point2 = k === 0 ? [center[0] + c.radius, at] : [at, center[1] + c.radius];
            planned.push(linear(view, k, a, b, `${prefix ?? ""}Ø`));
            return true;
        }
        return false;
    };
    const radial = (c: Cylinder, kind: "diameter" | "radius", prefix?: string) => {
        // the view where the circle shows, before one that sees it hidden
        const facing = views.filter((v) => circleIn(v, c));
        const shows = (v: DrawingViewData) => arcShows(geometries.get(v.id)!, project2(v, c.point), c.radius);
        for (const view of [...facing.filter(shows), ...facing.filter((v) => !shows(v))]) {
            const g = geometries.get(view.id)!;
            const center = project2(view, c.point);
            const taken = radialAngles.get(view.id) ?? [];
            let angle: number;
            if (kind === "radius" && c.arcMid !== undefined) {
                const m = project2(view, c.arcMid);
                angle = (Math.atan2(m[1] - center[1], m[0] - center[0]) * 180) / Math.PI;
            } else {
                const same = planned.filter(
                    (p) =>
                        p.type === "radial" &&
                        p.viewId === view.id &&
                        Math.hypot(p.center[0] - center[0], p.center[1] - center[1]) <= tolerance2(g),
                ) as PlannedRadial[];
                angle = leaderAngle(
                    view,
                    g,
                    center,
                    same.map((p) => p.angle),
                );
            }
            taken.push(angle);
            radialAngles.set(view.id, taken);
            planned.push({ type: "radial", viewId: view.id, kind, center, radius: c.radius, angle, prefix });
            return true;
        }
        return false;
    };
    const ordered = [...cylinders].sort((a, b) => b.radius - a.radius);
    for (const c of ordered) {
        if (called.has(c)) continue;
        // the basic set of a busy part: its overall sizes (the outer diameter of a turned one)
        // — holes there crowd each other's callouts, they are clicked in one by one
        if (basic && !outer(c)) continue;
        if (!c.full) {
            const key = c.radius.toFixed(4);
            if (radii.has(key)) continue;
            radii.add(key);
            radial(c, "radius");
            continue;
        }
        const set = ordered.filter((x) => !called.has(x) && x.full && sameHole(x, c, tolerance));
        for (const x of set) called.add(x);
        const pitch = c.concave ? boltCircle(set, cylinders, tolerance) : undefined;
        if (pitch !== undefined) {
            // holes evenly round a centre: placed by the diameter of their circle, no coordinates
            for (const x of set) placedByPitch.add(x);
            const view = views.find((v) => circleIn(v, c));
            if (view !== undefined) {
                const center = project2(view, pitch.point);
                const taken = planned
                    .filter((p): p is PlannedRadial => p.type === "radial" && p.viewId === view.id)
                    .map((p) => p.angle);
                const angle = [225, 315, 135, 45].find((a) => !taken.includes(a)) ?? 225;
                planned.push({
                    type: "radial",
                    viewId: view.id,
                    kind: "diameter",
                    center,
                    radius: pitch.radius,
                    angle,
                });
            }
        }
        const prefix = c.concave && set.length > 1 ? `${set.length} отв. ` : undefined;
        // a hole is called out where it is a circle, a turned diameter along its side
        if (c.concave) {
            if (!radial(pickCallout(set, views, geometries), "diameter", prefix)) sideOnDiameter(c, prefix);
        } else if (!sideOnDiameter(c, prefix)) {
            radial(c, "diameter", prefix);
        }
    }

    // -- coordinates: from each axis's base, once each, on the view that shows them best
    for (let axis = 0; axis < 3; axis++) {
        const coordinates = coordinatesAlong(axis, input, cylinders, tolerance, placedByPitch);
        if (coordinates.length < 2) continue;
        const base = coordinates[0];
        const done = new Set<Coordinate>([base]);
        // a blind hole's depth is given from the face it is drilled from
        const holes = cylinders
            .filter((c) => c.concave && c.axisIndex === axis)
            .sort((a, b) => a.hi - a.lo - (b.hi - b.lo));
        const depths: [Coordinate, Coordinate][] = [];
        for (const h of holes) {
            const ends = [h.lo, h.hi]
                .map((t) => coordinates.find((x) => Math.abs(x.value - t * h.axis[axis]) <= tolerance))
                .filter((x): x is Coordinate => x !== undefined);
            if (ends.length !== 2) continue;
            const [e1, e2] = ends;
            const bottom = e1.face ? (e2.face ? undefined : e2) : e2.face ? e1 : undefined;
            const opening = bottom === e1 ? e2 : e1;
            if (bottom === undefined || done.has(bottom) || bottom === base) continue;
            done.add(bottom);
            depths.push([opening, bottom]);
        }
        const place = (from: Coordinate, to: Coordinate, center?: Cylinder) => {
            const view = chooseView(views, geometries, axis, [from, to], center, tolerance2);
            if (view === undefined) return;
            const g = geometries.get(view.id)!;
            const [k, sign] = roleIn(view, axis)!;
            const side = sideFor(occupied.get(view.id), k);
            const high = side === "up" || side === "right";
            const point = (c: Coordinate): Point2 | undefined => {
                // a hole's position is measured from its centre (on its centre lines)
                const cyl =
                    c.face || c.rims.length > 0
                        ? undefined
                        : (c.centers.find((x) => x === center) ?? c.centers[0]);
                if (cyl !== undefined) return project2(view, cyl.point);
                return pointAt(g, k, c.value * sign, high, tolerance2(g));
            };
            const a = point(from);
            const b = point(to);
            if (a === undefined || b === undefined) return;
            planned.push(linear(view, k, a, b));
        };
        if (basic) {
            // the overall size along the axis, when faces bound it at both ends
            const last = coordinates[coordinates.length - 1];
            if (
                Math.abs(base.value - extents[axis][0]) <= tolerance * 100 &&
                Math.abs(last.value - extents[axis][1]) <= tolerance * 100
            )
                place(base, last);
            continue;
        }
        for (const [opening, bottom] of depths) place(opening, bottom);
        for (const c of coordinates) {
            if (done.has(c)) continue;
            done.add(c);
            const center = !c.face && c.rims.length === 0 ? c.centers[0] : undefined;
            if (center !== undefined && onSymmetryAxis(views, geometries, axis, c, center)) continue;
            place(base, c, center);
        }
    }
    return planned;
}

/**
 * Three or more equal holes evenly spaced round the axis of a larger cylinder parallel to
 * them (a flange's bore or rim): their pitch circle, centred on that axis.
 */
export function boltCircle(
    set: Cylinder[],
    cylinders: Cylinder[],
    tolerance: number,
): { point: Vec3; radius: number } | undefined {
    if (set.length < 3) return undefined;
    const axis = set[0].axis;
    for (const c of cylinders) {
        if (c.radius <= set[0].radius || Math.abs(Math.abs(dot(c.axis, axis)) - 1) > 1e-9) continue;
        const radii = set.map((h) => distanceToAxis(h.point, c.point, axis));
        const r = radii[0];
        if (r <= tolerance * 100 || radii.some((x) => Math.abs(x - r) > tolerance * 10)) continue;
        // angles in the plane across the axis
        const ref = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        const e1 = normalize(cross(axis, ref as Vec3));
        const e2 = cross(axis, e1);
        const angles = set
            .map((h) => {
                const d = sub(h.point, c.point);
                return Math.atan2(dot(d, e2), dot(d, e1));
            })
            .sort((a, b) => a - b);
        const step = (2 * Math.PI) / angles.length;
        const even = angles.every((a, k) => {
            const next = k + 1 < angles.length ? angles[k + 1] : angles[0] + 2 * Math.PI;
            return Math.abs(next - a - step) < 1e-3;
        });
        if (!even) continue;
        // the centre on the axis, level with the holes' first circle
        const along = dot(sub(set[0].point, c.point), axis);
        return { point: [0, 1, 2].map((i) => c.point[i] + axis[i] * along) as Vec3, radius: r };
    }
    return undefined;
}

/** A visible arc of the view on this circle. */
function arcShows(g: ViewGeometry, center: Point2, radius: number): boolean {
    const t = Math.hypot(g.bounds.maxX - g.bounds.minX, g.bounds.maxY - g.bounds.minY) * 1e-3 + 1e-6;
    return g.visible.some(
        (l) =>
            l.arc !== undefined &&
            Math.abs(l.arc.cx - center[0]) <= t &&
            Math.abs(l.arc.cy - center[1]) <= t &&
            Math.abs(l.arc.r - radius) <= t,
    );
}

/** The member of a set of equal holes whose callout points out of the view most freely. */
function pickCallout(
    set: Cylinder[],
    views: DrawingViewData[],
    geometries: ReadonlyMap<string, ViewGeometry>,
) {
    const view = views.find((v) => circleIn(v, set[0]));
    if (view === undefined) return set[0];
    const g = geometries.get(view.id)!;
    const score = (c: Cylinder) => {
        const p = project2(view, c.point);
        return p[0] - g.bounds.minX + (p[1] - g.bounds.minY);
    };
    return set.reduce((best, c) => (score(c) > score(best) ? c : best), set[0]);
}

/** A hole on a view's axis of symmetry is placed by the axis: it needs no dimension. */
function onSymmetryAxis(
    views: DrawingViewData[],
    geometries: ReadonlyMap<string, ViewGeometry>,
    axis: number,
    c: Coordinate,
    center: Cylinder,
): boolean {
    const view = views.find((v) => circleIn(v, center) && roleIn(v, axis) !== undefined);
    if (view === undefined) return false;
    const g = geometries.get(view.id)!;
    const [k, sign] = roleIn(view, axis)!;
    const s = symmetryAxes(g);
    const at = k === 0 ? s.vertical : s.horizontal;
    const tolerance = Math.hypot(g.bounds.maxX - g.bounds.minX, g.bounds.maxY - g.bounds.minY) * 2e-3;
    return at !== undefined && Math.abs(at - c.value * sign) <= tolerance;
}

function chooseView(
    views: DrawingViewData[],
    geometries: ReadonlyMap<string, ViewGeometry>,
    axis: number,
    coordinates: Coordinate[],
    center: Cylinder | undefined,
    tolerance2: (g: ViewGeometry) => number,
): DrawingViewData | undefined {
    const candidates = views.filter((v) => roleIn(v, axis) !== undefined);
    if (center !== undefined) {
        const facing = candidates.filter((v) => circleIn(v, center));
        const seen =
            facing.find((v) => arcShows(geometries.get(v.id)!, project2(v, center.point), center.radius)) ??
            facing[0];
        if (seen !== undefined) return seen;
    }
    const visible = (v: DrawingViewData, c: Coordinate) => {
        if (c.centers.length > 0 && !c.face && c.rims.length === 0) return true;
        const g = geometries.get(v.id)!;
        const [k, sign] = roleIn(v, axis)!;
        return lineAt(g.visible, k, c.value * sign, tolerance2(g));
    };
    return candidates.find((v) => coordinates.every((c) => visible(v, c))) ?? candidates[0];
}

// ---- placement ---------------------------------------------------------------------------

function sheetRect(placement: ViewPlacement) {
    const b = placement.geometry!.bounds;
    const [x1, y1] = toSheet(placement, b.minX, b.minY);
    const [x2, y2] = toSheet(placement, b.maxX, b.maxY);
    return { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) };
}

function lengthOf(p: PlannedLinear): number {
    return p.kind === "horizontal" ? Math.abs(p.b[0] - p.a[0]) : Math.abs(p.b[1] - p.a[1]);
}

/**
 * A cut along a plane of symmetry needs no labels (ГОСТ 2.305): the plane's trace on its host
 * view lies on that view's axis of symmetry.
 */
export function settleSectionLabels(data: DrawingData, geometries: ReadonlyMap<string, ViewGeometry>) {
    for (const view of data.views) {
        if (view.section === undefined) continue;
        if (view.section.fixedLabel) continue;
        view.section.unlabeled = undefined;
        const host = cutTraceHost(data, view);
        const g = host === undefined ? undefined : geometries.get(host.id);
        if (host === undefined || g === undefined) continue;
        const { a, b, offset } = traceOn(host, view);
        const s = symmetryAxes(g);
        const tolerance = Math.hypot(g.bounds.maxX - g.bounds.minX, g.bounds.maxY - g.bounds.minY) * 2e-3;
        let along = false;
        if (Math.abs(a) < 1e-6)
            along = s.horizontal !== undefined && Math.abs(s.horizontal - offset * b) <= tolerance;
        else if (Math.abs(b) < 1e-6)
            along = s.vertical !== undefined && Math.abs(s.vertical - offset * a) <= tolerance;
        const projected =
            view.parentId === host.id || host.parentId === view.id || host.parentId === view.parentId;
        if (along && projected) view.section.unlabeled = true;
    }
}

/** View sides where a cut's strokes and arrows stand: dimensions there start further out. */
function crowdedSides(data: DrawingData): Map<string, Set<Side>> {
    const result = new Map<string, Set<Side>>();
    for (const view of data.views) {
        if (view.section === undefined || view.section.unlabeled) continue;
        const host = cutTraceHost(data, view);
        if (host === undefined) continue;
        const { a } = traceOn(host, view);
        const sides = result.get(host.id) ?? new Set<Side>();
        // a trace along the sheet's x (a = 0) has its strokes at the left and right
        const crowded: Side[] = Math.abs(a) < 1e-6 ? ["left", "right"] : ["up", "down"];
        for (const s of crowded) sides.add(s);
        result.set(host.id, sides);
    }
    return result;
}

const CROWDED_EXTRA = 8;

function firstTier(crowded: Map<string, Set<Side>>, p: PlannedLinear): number {
    return FIRST_TIER + (crowded.get(p.viewId)?.has(p.side) ? CROWDED_EXTRA : 0);
}

/** Tiers per view side, the shortest dimension innermost. */
function tiers(planned: Planned[]): Map<PlannedLinear, number> {
    const groups = new Map<string, PlannedLinear[]>();
    for (const p of planned) {
        if (p.type !== "linear") continue;
        const key = `${p.viewId}|${p.side}`;
        const list = groups.get(key) ?? [];
        list.push(p);
        groups.set(key, list);
    }
    const result = new Map<PlannedLinear, number>();
    for (const list of groups.values()) {
        list.sort((a, b) => lengthOf(a) - lengthOf(b));
        list.forEach((p, i) => result.set(p, i));
    }
    return result;
}

/** Paper room each view needs round it for its dimensions, and for a section's title on top. */
export function marginsOf(data: DrawingData, planned: Planned[]): Map<string, Margins> {
    const result = new Map<string, Margins>();
    const crowded = crowdedSides(data);
    for (const view of data.views) result.set(view.id, { up: 0, down: 0, left: 0, right: 0 });
    for (const [p, tier] of tiers(planned)) {
        const m = result.get(p.viewId);
        if (m !== undefined)
            m[p.side] = Math.max(m[p.side], firstTier(crowded, p) + TIER_STEP * tier + TEXT_ROOM);
    }
    for (const [id, sides] of crowded) {
        const m = result.get(id);
        if (m !== undefined) for (const s of sides) m[s] = Math.max(m[s], 16);
    }
    for (const view of data.views) {
        if ((view.section !== undefined && !view.section.unlabeled) || view.label)
            result.get(view.id)!.up += 9;
    }
    return result;
}

/**
 * Spaces the main view and the views projected from it so each one's dimensions fit
 * between them, picks the largest standard scale at which the whole fits the drawing area,
 * and centres it there.
 */
export function arrangeViews(
    data: DrawingData,
    margins: ReadonlyMap<string, Margins>,
    geometries: ReadonlyMap<string, ViewGeometry>,
) {
    const root = data.views.find((v) => v.parentId === undefined && orthographic(v));
    if (root === undefined) return;
    const area = drawingArea(data.sheet, data.titleBlock.kind);
    const m = (v: DrawingViewData) => margins.get(v.id) ?? ZERO_MARGINS;
    const childrenOf = (v: DrawingViewData) =>
        data.views.filter((c) => c.parentId === v.id && c.side !== undefined && orthographic(c));
    const layout = (scale: number) => {
        const positions = new Map<string, Point2>();
        const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
        // each view relative to its parent, its own neighbours relative to it, down the tree
        const place = (v: DrawingViewData, x: number, y: number, depth: number) => {
            positions.set(v.id, [x, y]);
            const [w, h] = halfSizeOf(geometries.get(v.id), scale);
            box.minX = Math.min(box.minX, x - w - m(v).left);
            box.maxX = Math.max(box.maxX, x + w + m(v).right);
            box.minY = Math.min(box.minY, y - h - m(v).down);
            box.maxY = Math.max(box.maxY, y + h + m(v).up);
            if (depth > 8) return;
            for (const c of childrenOf(v)) {
                const [cw, ch] = halfSizeOf(geometries.get(c.id), scale);
                let cx = x;
                let cy = y;
                if (c.side === "right")
                    cx = x + w + Math.max(VIEW_GAP, m(v).right + m(c).left + MARGIN_GAP) + cw;
                if (c.side === "left")
                    cx = x - w - Math.max(VIEW_GAP, m(v).left + m(c).right + MARGIN_GAP) - cw;
                if (c.side === "up") cy = y + h + Math.max(VIEW_GAP, m(v).up + m(c).down + MARGIN_GAP) + ch;
                if (c.side === "down") cy = y - h - Math.max(VIEW_GAP, m(v).down + m(c).up + MARGIN_GAP) - ch;
                place(c, cx, cy, depth + 1);
            }
        };
        place(root, 0, 0, 0);
        return { positions, box };
    };
    const roomW = area.maxX - area.minX - 10;
    const roomH = area.maxY - area.minY - 10;
    let scale = STANDARD_SCALES[STANDARD_SCALES.length - 1];
    let chosen = layout(scale);
    for (const s of STANDARD_SCALES) {
        const l = layout(s);
        if (l.box.maxX - l.box.minX <= roomW && l.box.maxY - l.box.minY <= roomH) {
            chosen = l;
            scale = s;
            break;
        }
    }
    const dx = (area.minX + area.maxX) / 2 - (chosen.box.minX + chosen.box.maxX) / 2;
    const dy = (area.minY + area.maxY) / 2 - (chosen.box.minY + chosen.box.maxY) / 2;
    for (const v of data.views) {
        const p = chosen.positions.get(v.id);
        if (p === undefined) continue;
        v.scale = scale;
        v.x = p[0] + dx;
        v.y = p[1] + dy;
    }
}

const ZERO_MARGINS: Margins = { up: 0, down: 0, left: 0, right: 0 };

function halfSizeOf(g: ViewGeometry | undefined, scale: number): [number, number] {
    const b = g?.bounds;
    if (b === undefined || !Number.isFinite(b.minX)) return [20, 15];
    return [((b.maxX - b.minX) * scale) / 2, ((b.maxY - b.minY) * scale) / 2];
}

function visibleLength(g: ViewGeometry | undefined): number {
    let total = 0;
    for (const line of g?.visible ?? []) {
        const p = line.points;
        for (let k = 2; k + 1 < p.length; k += 2) total += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
    }
    return total;
}

/**
 * ГОСТ 2.305 asks for as many views as the part needs: the opposite basic views (from the
 * right, from below, from behind) are added where they show more than the view they mirror
 * does — something on that side the standard views only see hidden.
 */
export function addRevealingViews(data: DrawingData, cache: ViewGeometryCache) {
    const root = data.views.find((v) => v.parentId === undefined && orthographic(v));
    if (root === undefined) return;
    const geometryOf = (v: DrawingViewData) => cache.geometryOf(v);
    const opposite: Record<ProjectionSide, ProjectionSide> = {
        up: "down",
        down: "up",
        left: "right",
        right: "left",
    };
    const candidates: { parent: DrawingViewData; side: ProjectionSide; mirrors: DrawingViewData }[] = [];
    for (const child of data.views.filter((v) => v.parentId === root.id && v.side !== undefined)) {
        const side = opposite[child.side!];
        if (!data.views.some((v) => v.parentId === root.id && v.side === side))
            candidates.push({ parent: root, side, mirrors: child });
        // the view from behind sits beyond the side view, on the same side
        if (child.side === "left" || child.side === "right")
            candidates.push({ parent: child, side: child.side, mirrors: root });
    }
    const added: DrawingViewData[] = [];
    for (const c of candidates) {
        const view = projectedView(data, c.parent, c.side, geometryOf);
        // compare with what the mirrored view sees uncut
        const plain = { ...c.mirrors, id: `${c.mirrors.id}~plain`, section: undefined };
        const seen = visibleLength(geometryOf(view));
        const mirrored = visibleLength(geometryOf(plain));
        if (seen > mirrored * 1.02 + 1e-6) {
            view.showHidden = false;
            added.push(view);
        }
    }
    data.views.push(...added);
}

/**
 * The isometric view, in the first corner of the drawing area its outline fits into clear of
 * the other views and their dimensions; taken off the sheet when no corner has the room.
 */
export function placeIsometric(
    data: DrawingData,
    margins: ReadonlyMap<string, Margins>,
    cache: ViewGeometryCache,
) {
    const iso = data.views.find((v) => v.orientation === "iso" && v.parentId === undefined);
    if (iso === undefined) return;
    const root = data.views.find((v) => v.parentId === undefined && orthographic(v));
    const main = root?.scale ?? iso.scale;
    const taken = data.views
        .filter((v) => v !== iso)
        .map((v) => {
            const [vw, vh] = halfSizeOf(cache.geometryOf(v), v.scale);
            const m = margins.get(v.id) ?? ZERO_MARGINS;
            return {
                minX: v.x - vw - m.left,
                maxX: v.x + vw + m.right,
                minY: v.y - vh - m.down,
                maxY: v.y + vh + m.up,
            };
        });
    const area = drawingArea(data.sheet, data.titleBlock.kind);
    taken.push(...reservedRects(data.sheet, data.titleBlock.kind));
    const pad = 8;
    // the main views' scale, or up to two standard steps smaller (ГОСТ 2.316: written over it)
    const scales = STANDARD_SCALES.filter((s) => s <= main + 1e-9).slice(0, 3);
    for (const scale of scales) {
        const [w, h] = halfSizeOf(cache.geometryOf(iso), scale);
        // room for the scale written over the view
        const top = scale === main ? 0 : 9;
        const corners: Point2[] = [
            [area.maxX - pad - w, area.maxY - pad - h - top],
            [area.minX + pad + w, area.maxY - pad - h - top],
            [area.maxX - pad - w, area.minY + pad + h],
            [area.minX + pad + w, area.minY + pad + h],
        ];
        const fits = ([x, y]: Point2) =>
            x - w >= area.minX &&
            x + w <= area.maxX &&
            y - h >= area.minY &&
            y + h + top <= area.maxY &&
            taken.every(
                (r) =>
                    x + w + pad <= r.minX ||
                    x - w - pad >= r.maxX ||
                    y + h + top + pad <= r.minY ||
                    y - h - pad >= r.maxY,
            );
        const spot = corners.find(fits);
        if (spot === undefined) continue;
        iso.scale = scale;
        [iso.x, iso.y] = spot;
        iso.label = scale === main ? undefined : `(${formatScale(scale)})`;
        return;
    }
    data.views = data.views.filter((v) => v !== iso);
}

/** Turns the plan into dimensions on paper, now that the views have their places and scale. */
export function placeDimensions(
    data: DrawingData,
    planned: Planned[],
    geometries: ReadonlyMap<string, ViewGeometry>,
): DrawingDimensionData[] {
    const tierOf = tiers(planned);
    const crowded = crowdedSides(data);
    const result: DrawingDimensionData[] = [];
    for (const p of planned) {
        const view = data.views.find((v) => v.id === p.viewId);
        const geometry = geometries.get(p.viewId);
        if (view === undefined || geometry === undefined) continue;
        const placement = placementOf(view, geometry);
        if (p.type === "radial") {
            result.push({
                id: newDrawingItemId("d"),
                kind: p.kind,
                viewId: p.viewId,
                center: p.center,
                radius: p.radius,
                angle: p.angle,
                prefix: p.prefix,
                auto: true,
            });
            continue;
        }
        const rect = sheetRect(placement);
        const distance = firstTier(crowded, p) + TIER_STEP * (tierOf.get(p) ?? 0);
        const [x1, y1] = toSheet(placement, p.a[0], p.a[1]);
        let offset: number;
        if (p.side === "up") offset = rect.maxY + distance - y1;
        else if (p.side === "down") offset = rect.minY - distance - y1;
        else if (p.side === "left") offset = x1 - (rect.minX - distance);
        else offset = x1 - (rect.maxX + distance);
        result.push({
            id: newDrawingItemId("d"),
            kind: p.kind,
            viewId: p.viewId,
            a: p.a,
            b: p.b,
            offset,
            prefix: p.prefix,
            auto: true,
        });
    }
    return result;
}

/**
 * Replaces the automatic dimensions of the drawing with a fresh set (dimensions placed by
 * hand stay), spacing the views to make room for them.
 */
const MAX_TIERS = 6;
const MAX_LINEAR = 18;

function tooBusy(planned: Planned[]): boolean {
    const linear = planned.filter((p): p is PlannedLinear => p.type === "linear");
    if (linear.length > MAX_LINEAR) return true;
    const counts = new Map<string, number>();
    for (const p of linear)
        counts.set(`${p.viewId}|${p.side}`, (counts.get(`${p.viewId}|${p.side}`) ?? 0) + 1);
    return [...counts.values()].some((n) => n > MAX_TIERS);
}

/**
 * The dimensions of one feature, clicked at `point` (model 2D) on a view — what the rules give
 * it, the way automatic dimensioning would place them, stacked outside the dimensions the view
 * already has:
 * - a hole seen as a circle: its Ø ("N отв." for a set) and its centre's position from the
 *   view's base edges (none along an axis of symmetry);
 * - a cylinder seen side-on (a hole in a section, a turned step): its Ø across and, for a blind
 *   hole, the depth from the face it opens on;
 * - an edge seen as a line: that face's position from the base, or the overall size when it is
 *   a base edge itself.
 * Nothing is placed twice; an empty list when nothing is near.
 */
export function featureDimensions(
    data: DrawingData,
    viewId: string,
    point: Point2,
    cache: ViewGeometryCache,
): DrawingDimensionData[] {
    const view = data.views.find((v) => v.id === viewId);
    if (view === undefined || !orthographic(view)) return [];
    const g = cache.geometryOf(view);
    const input = cache.inputFor(view.sourceId);
    if (g === undefined || input === undefined || !Number.isFinite(g.bounds.minX)) return [];
    const tolerance = modelTolerance(input);
    const t2 = Math.hypot(g.bounds.maxX - g.bounds.minX, g.bounds.maxY - g.bounds.minY) * 1e-3 + 1e-6;
    const reach = Math.max(t2 * 10, 3 / view.scale);
    const cylinders = cylindersOf(input, tolerance);
    const side = (k: number) => sideFor(occupiedSides(data).get(view.id), k);
    const lows: Point2 = [g.bounds.minX, g.bounds.minY];
    const highs: Point2 = [g.bounds.maxX, g.bounds.maxY];
    const symmetry = symmetryAxes(g);
    const planned: Planned[] = [];
    const linear = (k: number, a: Point2, b: Point2, prefix?: string): PlannedLinear => ({
        type: "linear",
        viewId,
        kind: k === 0 ? "horizontal" : "vertical",
        a,
        b,
        side: side(k),
        prefix,
    });
    const contourAt = (k: number, x: number) => {
        const s = side(k);
        return pointAt(g, k, x, s === "up" || s === "right", t2);
    };
    // the position of `x` along sheet axis k from the base edge
    const position = (k: number, x: number, at: Point2) => {
        if (Math.abs(x - lows[k]) <= t2) return;
        const onAxis = k === 0 ? symmetry.vertical : symmetry.horizontal;
        if (onAxis !== undefined && Math.abs(onAxis - x) <= t2 * 2) return;
        const from = contourAt(k, lows[k]);
        if (from !== undefined) planned.push(linear(k, from, at));
    };

    // 1. a circle facing the viewer, the innermost one the click is in or on
    const facing = cylinders
        .filter((c) => c.full && circleIn(view, c))
        .map((c) => ({ c, p: project2(view, c.point) }))
        .filter(({ c, p }) => view.showHidden || arcShows(g, p, c.radius))
        .filter(({ c, p }) => Math.hypot(point[0] - p[0], point[1] - p[1]) <= c.radius + reach)
        .sort((a, b) => a.c.radius - b.c.radius);
    if (facing.length > 0) {
        const { c, p } = facing[0];
        const set = cylinders.filter((x) => x.full && sameHole(x, c, tolerance));
        const prefix = c.concave && set.length > 1 ? `${set.length} отв. ` : undefined;
        planned.push({
            type: "radial",
            viewId,
            kind: "diameter",
            center: p,
            radius: c.radius,
            angle: leaderAngle(view, g, p, []),
            prefix,
        });
        position(0, p[0], p);
        position(1, p[1], p);
        return placeFeature(data, view, g, planned, cache);
    }

    // 2. a cylinder seen side-on: the click on its outline or inside it
    const across = cylinders
        .filter((c) => c.full && sideOn(view, c))
        .map((c) => {
            const a = project2(view, c.axis);
            const k = Math.abs(a[0]) > 0.999 ? 1 : Math.abs(a[1]) > 0.999 ? 0 : -1;
            return { c, k, p: project2(view, c.point) };
        })
        .filter(({ c, k, p }) => {
            if (k < 0) return false;
            const along = 1 - k;
            const ends = [c.lo, c.hi].map(
                (x) =>
                    project2(view, scaled(c.axis, x))[along] +
                    (p[along] - project2(view, scaled(c.axis, dot(c.point, c.axis)))[along]),
            );
            const inSpan =
                point[along] >= Math.min(...ends) - reach && point[along] <= Math.max(...ends) + reach;
            return (
                inSpan &&
                Math.abs(point[k] - p[k]) <= c.radius + reach &&
                lineAt(g.visible, k, p[k] - c.radius, t2)
            );
        })
        .sort((a, b) => a.c.radius - b.c.radius);
    if (across.length > 0) {
        const { c, k, p } = across[0];
        const along = 1 - k;
        const shift = p[along] - project2(view, scaled(c.axis, dot(c.point, c.axis)))[along];
        const ends = [c.lo, c.hi]
            .map((x) => project2(view, scaled(c.axis, x))[along] + shift)
            .sort((x, y) => x - y);
        const s = side(k);
        const at = s === "up" || s === "right" ? ends[1] : ends[0];
        const a: Point2 = k === 0 ? [p[0] - c.radius, at] : [at, p[1] - c.radius];
        const b: Point2 = k === 0 ? [p[0] + c.radius, at] : [at, p[1] + c.radius];
        planned.push(linear(k, a, b, "Ø"));
        if (c.concave) {
            // blind: one end on the part's outline (the opening), the other inside it
            const atEdge = ends.map(
                (x) => Math.abs(x - lows[along]) <= t2 * 2 || Math.abs(x - highs[along]) <= t2 * 2,
            );
            if (atEdge[0] !== atEdge[1]) {
                const opening = atEdge[0] ? ends[0] : ends[1];
                const bottom = atEdge[0] ? ends[1] : ends[0];
                const from = contourAt(along, opening);
                const to: Point2 = along === 0 ? [bottom, p[1]] : [p[0], bottom];
                if (from !== undefined) planned.push(linear(along, from, to));
            }
        }
        position(k, p[k], p);
        return placeFeature(data, view, g, planned, cache);
    }

    // 3. an edge seen as a straight line across a sheet axis
    let best: { k: number; x: number; d: number } | undefined;
    for (const line of g.visible) {
        const q = line.points;
        for (let i = 0; i + 3 < q.length; i += 2) {
            const [x1, y1, x2, y2] = [q[i], q[i + 1], q[i + 2], q[i + 3]];
            const d = pointSegmentDistance(point[0], point[1], x1, y1, x2, y2);
            if (d > reach || (best !== undefined && d >= best.d)) continue;
            if (Math.abs(x1 - x2) <= t2 && Math.abs(y1 - y2) > t2) best = { k: 0, x: x1, d };
            else if (Math.abs(y1 - y2) <= t2 && Math.abs(x1 - x2) > t2) best = { k: 1, x: y1, d };
        }
    }
    if (best !== undefined) {
        const { k, x } = best;
        const base = Math.abs(x - lows[k]) <= t2 || Math.abs(x - highs[k]) <= t2;
        const from = contourAt(k, lows[k]);
        const to = contourAt(k, base ? highs[k] : x);
        if (from !== undefined && to !== undefined) planned.push(linear(k, from, to));
        return placeFeature(data, view, g, planned, cache);
    }
    return [];
}

/** Places a feature's dimensions outside those its view already has, skipping duplicates. */
function placeFeature(
    data: DrawingData,
    view: DrawingViewData,
    g: ViewGeometry,
    planned: Planned[],
    cache: ViewGeometryCache,
): DrawingDimensionData[] {
    const placement = placementOf(view, g);
    const rect = sheetRect(placement);
    const existing = new Set(data.dimensions.map((d) => dimensionKey(data, d)));
    const crowded = crowdedSides(data);
    // how far out each side's dimension lines already run
    const used = new Map<Side, number>();
    for (const d of data.dimensions) {
        if (d.viewId !== view.id || isRadialDimension(d)) continue;
        const q = linearGeometry(placement, d).q1;
        const pairs: [Side, number][] =
            d.kind === "horizontal"
                ? [
                      ["up", q[1] - rect.maxY],
                      ["down", rect.minY - q[1]],
                  ]
                : [
                      ["left", rect.minX - q[0]],
                      ["right", q[0] - rect.maxX],
                  ];
        for (const [s, distance] of pairs)
            if (distance > 0) used.set(s, Math.max(used.get(s) ?? 0, distance));
    }
    const result: DrawingDimensionData[] = [];
    const linear = planned
        .filter((p): p is PlannedLinear => p.type === "linear")
        .sort((a, b) => lengthOf(a) - lengthOf(b));
    for (const p of planned) {
        if (p.type !== "radial") continue;
        const d: DrawingDimensionData = {
            id: newDrawingItemId("d"),
            kind: p.kind,
            viewId: view.id,
            center: p.center,
            radius: p.radius,
            angle: p.angle,
            prefix: p.prefix,
        };
        if (!existing.has(dimensionKey(data, d))) result.push(d);
    }
    for (const p of linear) {
        const probe: DrawingDimensionData = {
            id: "",
            kind: p.kind,
            viewId: view.id,
            a: p.a,
            b: p.b,
            offset: 0,
        };
        if (existing.has(dimensionKey(data, probe))) continue;
        const first = firstTier(crowded, p);
        const distance = Math.max(first, (used.get(p.side) ?? first - TIER_STEP) + TIER_STEP);
        used.set(p.side, distance);
        const [x1, y1] = toSheet(placement, p.a[0], p.a[1]);
        let offset: number;
        if (p.side === "up") offset = rect.maxY + distance - y1;
        else if (p.side === "down") offset = rect.minY - distance - y1;
        else if (p.side === "left") offset = x1 - (rect.minX - distance);
        else offset = x1 - (rect.maxX + distance);
        result.push({
            id: newDrawingItemId("d"),
            kind: p.kind,
            viewId: view.id,
            a: p.a,
            b: p.b,
            offset,
            prefix: p.prefix,
        });
    }
    void cache;
    return result;
}

/**
 * What a dimension measures, independent of the drawing's view ids: the view's direction and
 * whether it is cut, the kind, and the measured points. An automatic dimension the user
 * deleted, or one they changed (it stops being automatic), is matched by it.
 */
export function dimensionKey(data: DrawingData, d: DrawingDimensionData): string | undefined {
    const view = data.views.find((v) => v.id === d.viewId);
    if (view === undefined) return undefined;
    const r = (x: number) => (Math.round(x * 1000) / 1000).toString();
    const where = `${view.orientation}${view.section === undefined ? "" : "/cut"}`;
    if (isRadialDimension(d)) return `${where}|${d.kind}|${r(d.center[0])},${r(d.center[1])}|${r(d.radius)}`;
    return `${where}|${d.kind}|${r(d.a[0])},${r(d.a[1])}|${r(d.b[0])},${r(d.b[1])}`;
}

export function autoDimension(data: DrawingData, sourceId: string, cache: ViewGeometryCache) {
    const input = cache.inputFor(sourceId);
    data.dimensions = data.dimensions.filter((d) => !d.auto);
    if (input === undefined) return;
    const cylinders = cylindersOf(input);
    const own = { ...data, views: data.views.filter((v) => v.sourceId === sourceId) };
    const geometries = cache.all(own);
    let planned = planDimensions(own, input, geometries, cylinders);
    // more than a few rows on a side: the part is too busy to dimension by rules alone — the
    // sheet gets its overall sizes, the rest is clicked in feature by feature
    if (tooBusy(planned)) planned = planDimensions(own, input, geometries, cylinders, "basic");
    const margins = marginsOf(data, planned);
    arrangeViews(data, margins, geometries);
    placeIsometric(data, margins, cache);
    // the layout moved and rescaled the views: the dimensions are placed after it; one the
    // user deleted stays deleted, one they changed is kept as theirs instead
    const skip = new Set(data.suppressed ?? []);
    for (const d of data.dimensions) {
        const key = dimensionKey(data, d);
        if (key !== undefined) skip.add(key);
    }
    const placed = placeDimensions(data, planned, cache.all(data));
    data.dimensions.push(...placed.filter((d) => !skip.has(dimensionKey(data, d) ?? "")));
}

/**
 * The whole drawing of a source by the rules: the three standard views and those of the
 * other basic views that show something more, cuts where holes run across a view, centre
 * lines, dimensions, and an isometric view where the sheet has room — replacing every view.
 */
export function autoDrawing(data: DrawingData, sourceId: string, cache: ViewGeometryCache) {
    // dimensions made or changed by hand move over to the new view looking the same way
    const orientationOf = new Map(data.views.map((v) => [v.id, v.orientation]));
    const manual = data.dimensions
        .filter((d) => !d.auto)
        .map((d) => ({ d, orientation: orientationOf.get(d.viewId) }));
    data.views = [];
    data.dimensions = [];
    layoutStandardViews(data, sourceId, (v) => cache.geometryOf(v));
    const input = cache.inputFor(sourceId);
    if (input === undefined) return;
    addRevealingViews(data, cache);
    const root = data.views[0];
    data.views.push(newView(sourceId, "iso", root.scale, root.x, root.y));
    for (const { d, orientation } of manual) {
        const view = data.views.find((v) => v.orientation === orientation);
        if (view !== undefined) data.dimensions.push({ ...d, viewId: view.id });
    }
    autoSections(data, cylindersOf(input), modelTolerance(input));
    settleSectionLabels(data, cache.all(data));
    autoDimension(data, sourceId, cache);
}
