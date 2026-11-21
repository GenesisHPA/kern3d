// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { EMPTY_SCOPE, type IDocument, type IEdge, type IShape, Plane, ShapeTypes, XYZ } from "@chili3d/core";
import { captureEdgeRef, type EdgeRef } from "../features/edgeRef";
import type { ExtrudeFeatureData, FeatureData } from "../features/feature";
import { ParametricBodyNode } from "../parametricBodyNode";
import { ConstraintKind, type SketchData, type SketchPointRef } from "../sketch/sketchModel";
import { SketchNode } from "../sketch/sketchNode";
import { SketchSolver } from "../sketch/solver";
import type { Curve2D, Profile2D } from "./fit2d";
import { dot, scale, type Vec3, weldTriangles } from "./mesh";
import { type EdgeTreatment, type PlannedExtrude, planExtrusions } from "./plan";
import { sliceFrames } from "./slices";
import { trianglesOf } from "./verify";

/**
 * Measures a body against the part, as a share of the part's volume (lower is closer); given to
 * `buildModel` so a piece no feature of the main axis describes can be tried as features along
 * its own axis before it is taken from the part as a mesh piece.
 */
export type BodyJudge = (body: ParametricBodyNode) => number;

/** Most features a mesh piece may be rebuilt as along its own axis. */
const MAX_PIECE_FEATURES = 6;

const xyz = (v: Vec3) => new XYZ({ x: v[0], y: v[1], z: v[2] });

/** The sketch plane of a planned extrude: square to its axis at its base height. */
export function planeOf(plan: PlannedExtrude): Plane {
    return new Plane({
        origin: xyz(scale(plan.frame.axis, plan.base)),
        normal: xyz(plan.frame.axis),
        xvec: xyz(plan.frame.xvec),
    });
}

/**
 * The profiles as sketch data: lines, arcs and circles with what makes them editable as a sketch
 * — neighbours joined (coincident), straight walls horizontal or vertical, every round a radius
 * dimension (circles read Ø). The dimensions carry no value of their own: they take the
 * geometry's, so the sketch is exactly as fitted until a number is changed.
 */
export function sketchDataOf(plane: Plane, profiles: readonly Profile2D[], tol: number): SketchData {
    const solver = new SketchSolver(plane, undefined, EMPTY_SCOPE);
    try {
        for (const profile of profiles) {
            if (profile.kind === "circle") {
                const id = solver.addCircle(profile.c[0], profile.c[1], profile.r);
                solver.addConstraint({
                    kind: ConstraintKind.Radius,
                    refs: [{ entityId: id, pointIndex: 0 }],
                    display: "diameter",
                });
                continue;
            }
            const ends: { start: SketchPointRef; end: SketchPointRef }[] = [];
            for (const curve of profile.curves) ends.push(addCurve(solver, curve, tol));
            for (let i = 0; i < ends.length; i++) {
                solver.addConstraint({
                    kind: ConstraintKind.P2PCoincident,
                    refs: [ends[i].end, ends[(i + 1) % ends.length].start],
                });
            }
        }
        return solver.toData();
    } finally {
        solver.dispose();
    }
}

/** One curve into the solver; its ends in the profile's direction of travel. */
function addCurve(
    solver: SketchSolver,
    curve: Curve2D,
    tol: number,
): { start: SketchPointRef; end: SketchPointRef } {
    if (curve.kind === "line") {
        const id = solver.addLine(curve.a[0], curve.a[1], curve.b[0], curve.b[1]);
        const du = Math.abs(curve.b[0] - curve.a[0]);
        const dv = Math.abs(curve.b[1] - curve.a[1]);
        const refs = [
            { entityId: id, pointIndex: 0 },
            { entityId: id, pointIndex: 1 },
        ];
        if (dv <= tol * 1e-3 && du > tol) solver.addConstraint({ kind: ConstraintKind.Horizontal, refs });
        else if (du <= tol * 1e-3 && dv > tol) solver.addConstraint({ kind: ConstraintKind.Vertical, refs });
        return { start: refs[0], end: refs[1] };
    }
    // the solver's arcs run counter-clockwise from start to end
    const [s, e] = curve.ccw ? [curve.a, curve.b] : [curve.b, curve.a];
    const id = solver.addArc(curve.c[0], curve.c[1], s[0], s[1], e[0], e[1]);
    solver.addConstraint({ kind: ConstraintKind.Radius, refs: [{ entityId: id, pointIndex: 0 }] });
    const start = { entityId: id, pointIndex: 1 };
    const end = { entityId: id, pointIndex: 2 };
    return curve.ccw ? { start, end } : { start: end, end: start };
}

/** The nodes a rebuild made: the body and its (hidden) sketches. */
export interface BuiltModel {
    readonly body: ParametricBodyNode;
    readonly sketches: SketchNode[];
}

const ROLE_NAMES: Record<PlannedExtrude["role"], string> = {
    body: "Эскиз",
    hole: "Отверстие",
    add: "Добавление",
    remove: "Вырез",
};

/**
 * The planned extrudes as one parametric body in `document`: a sketch node per extrude (hidden,
 * named by what it makes) and one extrude feature each, in order.
 */
export function buildModel(
    document: IDocument,
    plans: readonly PlannedExtrude[],
    name: string,
    tol: number,
    reference?: IShape,
    judge?: BodyJudge,
): BuiltModel {
    const body = new ParametricBodyNode({ document, features: [] });
    body.name = name;
    document.modelManager.addNode(body);
    const model: BuiltModel = { body, sketches: [] };
    // one feature at a time: a taper the kernel refuses is redone straight, so one bad cone
    // does not take the whole body down
    for (const plan of plans) {
        if (
            plan.fromMesh &&
            reference !== undefined &&
            appendMeshPiece(model, plan, reference, document, tol, judge)
        )
            continue;
        appendExtrude(model, document, plan, tol);
        const failed = !body.shape.isOk || body.featureItems().at(-1)?.error !== undefined;
        if (!failed || plan.draft === undefined) continue;
        removeLast(model);
        appendExtrude(
            model,
            document,
            { ...plan, draft: undefined, profiles: plan.straight ?? plan.profiles },
            tol,
        );
    }
    return model;
}

/** Takes the last extrude (and its sketch) off the model again. */
export function removeLast(model: BuiltModel): void {
    model.body.setFeaturesEmitShapeChanged(model.body.features.slice(0, -1));
    const sketch = model.sketches.pop();
    sketch?.parent?.remove(sketch);
}

/** Appends one more planned extrude to a built model (a corrective piece). */
export function appendExtrude(
    model: BuiltModel,
    document: IDocument,
    plan: PlannedExtrude,
    tol: number,
): void {
    const plane = planeOf(plan);
    const sketch = new SketchNode({ document, plane, data: sketchDataOf(plane, plan.profiles, tol) });
    sketch.name = `${ROLE_NAMES[plan.role]} ${model.sketches.length + 1}`;
    document.modelManager.addNode(sketch);
    sketch.visible = false;
    model.sketches.push(sketch);
    const direction = plan.lean === undefined ? undefined : leanDirection(model, document, plan);
    model.body.setFeaturesEmitShapeChanged([
        ...model.body.features,
        {
            id: `rebuild-${model.sketches.length}`,
            type: "extrude",
            sketchId: sketch.id,
            depth: Number.parseFloat((direction?.depth ?? plan.depth).toFixed(6)),
            ...(direction ? { direction: direction.ref } : {}),
            ...(plan.draft ? { draftAngle: Number.parseFloat(plan.draft.toFixed(4)) } : {}),
            ...(model.body.features.length > 0 ? { operation: plan.operation ?? "fuse" } : {}),
        },
    ]);
}

function segmentDistance(
    p: readonly [number, number],
    a: readonly [number, number],
    b: readonly [number, number],
): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function onLoops(p: readonly [number, number], loops: EdgeTreatment["loops"], tol: number): boolean {
    for (const loop of loops) {
        for (let i = 0; i < loop.length; i++) {
            if (segmentDistance(p, loop[i], loop[(i + 1) % loop.length]) <= tol) return true;
        }
    }
    return false;
}

/**
 * The body's edges a treatment names: lying at its height (both ends and the middle) and along
 * its loops — the sharp edge the folded band left. Indexes into the body's current shape.
 */
export function treatmentEdges(model: BuiltModel, treatment: EdgeTreatment, tol: number): number[] {
    const shape = model.body.shape;
    if (!shape.isOk) return [];
    const { axis, xvec, yvec } = treatment.frame;
    const at = (p: { x: number; y: number; z: number }) => {
        const v: Vec3 = [p.x, p.y, p.z];
        return { h: dot(v, axis), uv: [dot(v, xvec), dot(v, yvec)] as [number, number] };
    };
    const reach = Math.max(tol * 10, treatment.size * 0.05);
    const indexes: number[] = [];
    (shape.value.findSubShapes(ShapeTypes.edge) as IEdge[]).forEach((edge, index) => {
        try {
            const mid = edge.pointAt((edge.firstParameter() + edge.lastParameter()) / 2);
            const points = [...edge.ends(), mid].map(at);
            const level = points.every((p) => Math.abs(p.h - treatment.height) <= reach);
            const along = points.every((p) => onLoops(p.uv, treatment.loops, reach));
            // and on a stretch that was rounded: the middle near one of the moved segments
            const rounded = treatment.moved.some((m) => segmentDistance(points[2].uv, m.a, m.b) <= reach);
            if (level && along && rounded) {
                indexes.push(index);
            }
        } catch {
            // an edge without a curve to sample is no part of the loop
        }
    });
    return indexes;
}

/**
 * Rounds or chamfers the edges a treatment names, as one feature. False — and nothing added —
 * when no edge matches or the kernel refuses the round.
 */
export function appendTreatment(model: BuiltModel, treatment: EdgeTreatment, tol: number): boolean {
    const indexes = treatmentEdges(model, treatment, tol);
    if (indexes.length === 0 || !model.body.shape.isOk) return false;
    const edges = model.body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    const refs = indexes.map((i) => {
        const id = model.body.edgeIdAt(i);
        return captureEdgeRef(edges[i], id, model.body.edgeIdIsShared(id));
    });
    const before = model.body.features;
    const id = `rebuild-edge-${before.length + 1}`;
    const feature: FeatureData =
        treatment.kind === "fillet"
            ? { id, type: "fillet", radius: treatment.size, edges: refs }
            : { id, type: "chamfer", distance: treatment.size, edges: refs };
    model.body.setFeaturesEmitShapeChanged([...before, feature]);
    if (model.body.shape.isOk && model.body.featureItems().at(-1)?.error === undefined) return true;
    model.body.setFeaturesEmitShapeChanged(before);
    return false;
}

/** What a piece rebuilt with true arcs may read further off than its mesh, as a share of the part. */
const PIECE_ARC_SLACK = 5e-4;

/**
 * A mesh piece planned along its own best axes as a few fused extrudes — a boss or rib in
 * another direction than the part's main one. Undefined when no axis gives a short plan.
 */
function planPiece(piece: IShape, tol: number): PlannedExtrude[] | undefined {
    const mesh = weldTriangles(trianglesOf(piece));
    if (mesh.areas.length === 0) return undefined;
    for (const frame of sliceFrames(mesh).slice(0, 2)) {
        const plans = planExtrusions(mesh, frame, tol, { holes: false, operation: "fuse", role: "add" });
        if (plans.length > 0 && plans.length <= MAX_PIECE_FEATURES && !plans.some((p) => p.fromMesh))
            return plans.map((p) => ({ ...p, operation: "fuse" as const }));
    }
    return undefined;
}

function cross3(a: Vec3, b: Vec3): Vec3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * An oblique extrude's direction: a hidden sketch holding one line from the profile's base
 * along the lean to its top. The extrude's `direction` names that line and sweeps along it,
 * `depth` being its length.
 */
function leanDirection(
    model: BuiltModel,
    document: IDocument,
    plan: PlannedExtrude,
): { ref: { nodeId: string; edge: EdgeRef }; depth: number } | undefined {
    const { axis, xvec, yvec } = plan.frame;
    const [du, dv] = plan.lean ?? [0, 0];
    const shift: Vec3 = [
        xvec[0] * du + yvec[0] * dv,
        xvec[1] * du + yvec[1] * dv,
        xvec[2] * du + yvec[2] * dv,
    ];
    const run: Vec3 = [
        axis[0] * plan.depth + shift[0],
        axis[1] * plan.depth + shift[1],
        axis[2] * plan.depth + shift[2],
    ];
    const length = Math.hypot(run[0], run[1], run[2]);
    const along = Math.hypot(shift[0], shift[1], shift[2]);
    if (!(length > 0) || !(along > 0)) return undefined;
    const origin = scale(axis, plan.base);
    const lean: Vec3 = [shift[0] / along, shift[1] / along, shift[2] / along];
    // the line's own plane holds the axis and the lean
    const plane = new Plane({ origin: xyz(origin), normal: xyz(cross3(axis, lean)), xvec: xyz(lean) });
    const end = new XYZ({ x: origin[0] + run[0], y: origin[1] + run[1], z: origin[2] + run[2] });
    const d = end.sub(plane.origin);
    const solver = new SketchSolver(plane, undefined, EMPTY_SCOPE);
    let data: SketchData;
    try {
        solver.addLine(0, 0, d.dot(plane.xvec), d.dot(plane.yvec));
        data = solver.toData();
    } finally {
        solver.dispose();
    }
    const sketch = new SketchNode({ document, plane, data });
    sketch.name = `Направление ${model.sketches.length}`;
    document.modelManager.addNode(sketch);
    sketch.visible = false;
    model.sketches.push(sketch);
    const edge: EdgeRef = {
        kind: "line",
        start: { x: origin[0], y: origin[1], z: origin[2] },
        end: { x: end.x, y: end.y, z: end.z },
    };
    return { ref: { nodeId: sketch.id, edge }, depth: length };
}

/**
 * The part's own piece for a slab no feature describes: the reference solid clipped to the
 * slab (a box over the slab's loops, between its two heights), kept as an imported piece fused
 * into the body. False — nothing added — when the clip or the fuse fails.
 */
function appendMeshPiece(
    model: BuiltModel,
    plan: PlannedExtrude,
    reference: IShape,
    document: IDocument,
    tol: number,
    judge?: BodyJudge,
): boolean {
    const { axis, xvec, yvec } = plan.frame;
    let minU = Number.POSITIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (const profile of plan.profiles) {
        const points =
            profile.kind === "circle"
                ? [
                      [profile.c[0] - profile.r, profile.c[1] - profile.r],
                      [profile.c[0] + profile.r, profile.c[1] + profile.r],
                  ]
                : profile.curves.flatMap((c) =>
                      c.kind === "arc"
                          ? [c.a, [c.c[0] - c.r, c.c[1] - c.r], [c.c[0] + c.r, c.c[1] + c.r]]
                          : [c.a],
                  );
        for (const [u, v] of points) {
            minU = Math.min(minU, u);
            minV = Math.min(minV, v);
            maxU = Math.max(maxU, u);
            maxV = Math.max(maxV, v);
        }
    }
    if (!Number.isFinite(minU)) return false;
    // a margin all round, so the clip never runs along the part's own walls
    const margin = Math.max(maxU - minU, maxV - minV) * 0.2 + 1;
    const origin = [0, 1, 2].map(
        (k) => axis[k] * plan.base + xvec[k] * (minU - margin) + yvec[k] * (minV - margin),
    );
    const plane = new Plane({
        origin: new XYZ({ x: origin[0], y: origin[1], z: origin[2] }),
        normal: xyz(axis),
        xvec: xyz(xvec),
    });
    const box = shapeFactory.box(plane, maxU - minU + 2 * margin, maxV - minV + 2 * margin, plan.depth);
    if (!box.isOk) return false;
    const piece = shapeFactory.booleanCommon([reference], [box.value]);
    box.value.dispose();
    if (!piece.isOk) return false;
    const planned = judge === undefined ? undefined : planPiece(piece.value, tol);
    const brep = shapeConverter.convertToBrep(piece.value);
    piece.value.dispose();
    if (!brep.isOk) return false;
    const before = model.body.features;
    const sketchesBefore = model.sketches.length;
    // the piece as features along its own axis, if that is no further from the part than the
    // mesh piece (a true arc where the STL had facets costs a little volume, never surface)
    let asFeatures: number | undefined;
    if (planned !== undefined && judge !== undefined) {
        for (const p of planned) appendExtrude(model, document, p, tol);
        if (model.body.shape.isOk && !model.body.featureItems().some((x) => x.error !== undefined))
            asFeatures = judge(model.body);
        model.body.setFeaturesEmitShapeChanged(before);
        for (const sketch of model.sketches.splice(sketchesBefore)) sketch.parent?.remove(sketch);
    }
    model.body.setFeaturesEmitShapeChanged([
        ...before,
        {
            id: `rebuild-mesh-${before.length + 1}`,
            type: "imported",
            brep: brep.value,
            ...(before.length > 0 ? { operation: "fuse" as const } : {}),
        },
    ]);
    const meshOk = model.body.shape.isOk && model.body.featureItems().at(-1)?.error === undefined;
    const asMesh = meshOk && asFeatures !== undefined ? judge?.(model.body) : undefined;
    if (
        planned !== undefined &&
        asFeatures !== undefined &&
        (!meshOk || asMesh === undefined || asFeatures <= asMesh + PIECE_ARC_SLACK)
    ) {
        model.body.setFeaturesEmitShapeChanged(before);
        for (const p of planned) appendExtrude(model, document, p, tol);
        if (model.body.shape.isOk && !model.body.featureItems().some((x) => x.error !== undefined))
            return true;
        model.body.setFeaturesEmitShapeChanged(before);
        for (const sketch of model.sketches.splice(sketchesBefore)) sketch.parent?.remove(sketch);
        return false;
    }
    if (meshOk) return true;
    model.body.setFeaturesEmitShapeChanged(before);
    return false;
}
