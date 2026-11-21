// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { EMPTY_SCOPE, type IDocument, type IEdge, Plane, ShapeTypes, XYZ } from "@chili3d/core";
import { captureEdgeRef } from "../features/edgeRef";
import type { ExtrudeFeatureData, FeatureData } from "../features/feature";
import { ParametricBodyNode } from "../parametricBodyNode";
import { ConstraintKind, type SketchData, type SketchPointRef } from "../sketch/sketchModel";
import { SketchNode } from "../sketch/sketchNode";
import { SketchSolver } from "../sketch/solver";
import type { Curve2D, Profile2D } from "./fit2d";
import { dot, scale, type Vec3 } from "./mesh";
import type { EdgeTreatment, PlannedExtrude } from "./plan";

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
): BuiltModel {
    const body = new ParametricBodyNode({ document, features: [] });
    body.name = name;
    document.modelManager.addNode(body);
    const model: BuiltModel = { body, sketches: [] };
    // one feature at a time: a taper the kernel refuses is redone straight, so one bad cone
    // does not take the whole body down
    for (const plan of plans) {
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
    model.body.setFeaturesEmitShapeChanged([
        ...model.body.features,
        {
            id: `rebuild-${model.sketches.length}`,
            type: "extrude",
            sketchId: sketch.id,
            depth: Number.parseFloat(plan.depth.toFixed(6)),
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
