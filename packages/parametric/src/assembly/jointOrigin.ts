// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    BoundingBox,
    CurveUtils,
    type IDocument,
    type IEdge,
    type IFace,
    type INode,
    type IShape,
    type IVertex,
    ShapeNode,
    type ShapeType,
    ShapeTypes,
    XYZ,
    type XYZLike,
} from "@chili3d/core";
import { isCylinder, unwrapSurface } from "../commands/alignGeometry";
import { isBodyTrackingNode } from "../features/bodyTracking";
import { plainVec } from "../features/refGeometry";
import { worldAxisXVec } from "../sketch/planeRef";
import type { JointFrame } from "./jointMath";

/**
 * Where on the picked geometry a joint origin sits, the usual snap points:
 *
 * - `faceCenter` — a planar face's centre (orientation: the outward normal), a cylindrical face's
 *   axis at mid-height (orientation: the axis).
 * - `facePoint` — one of a face's key points: a vertex, a straight edge's midpoint or an arc's
 *   centre; oriented by the face, so a hole's centre on a plate keeps the plate's normal.
 * - `circleCenter` — a circular edge's centre, oriented along the circle's axis.
 * - `edgeMid` / `edgeStart` / `edgeEnd` — a point of a straight edge, oriented along the edge.
 * - `vertex` — a vertex, oriented along the shape's Z.
 */
export type JointSnap =
    | "faceCenter"
    | "facePoint"
    | "circleCenter"
    | "edgeMid"
    | "edgeStart"
    | "edgeEnd"
    | "vertex";

/**
 * A joint origin as stored: what was picked, how it snapped, and the fingerprint that finds it
 * again after the body rebuilds. `kind: "fixed"` is an origin with no geometry — a frame given
 * directly in the component's local space (the second side of an as-built joint).
 *
 * - `nodeId` — the shape node picked (or, for `fixed`, the component; "" for the root).
 * - `index` — the sub-shape's index at capture time, the last resort.
 * - `subId` — the tracked face/edge id of a parametric body, the precise path.
 * - `point` / `direction` — the snapped origin and its axis in the node's shape space: the
 *   geometric fingerprint, and the hint a `facePoint` re-snaps to.
 * - `frame` — the frame as last resolved (node shape space), used while nothing matches.
 */
export interface JointOriginRef {
    readonly nodeId: string;
    readonly kind: "face" | "edge" | "vertex" | "fixed";
    readonly snap?: JointSnap;
    readonly index?: number;
    readonly subId?: string;
    readonly point?: XYZLike;
    readonly direction?: XYZLike;
    readonly frame: JointFrame;
}

const KIND_TYPES: Record<"face" | "edge" | "vertex", ShapeType> = {
    face: ShapeTypes.face,
    edge: ShapeTypes.edge,
    vertex: ShapeTypes.vertex,
};

function frameOn(origin: XYZ, z: XYZ): JointFrame {
    const axis = z.normalize() ?? XYZ.unitZ;
    return { origin, z: axis, x: worldAxisXVec(axis) };
}

/** The face's key points a `facePoint` snaps to. */
function faceKeyPoints(face: IFace): XYZ[] {
    const points = (face.findSubShapes(ShapeTypes.vertex) as IVertex[]).map((v) => v.point());
    for (const edge of face.findSubShapes(ShapeTypes.edge) as IEdge[]) {
        const curve = edge.curve;
        const basis = curve.basisCurve;
        if (CurveUtils.isLine(basis)) {
            points.push(curve.value((curve.firstParameter() + curve.lastParameter()) / 2));
        } else if (CurveUtils.isCircle(basis)) {
            points.push(basis.center);
        }
    }
    return points;
}

interface FaceAxis {
    readonly center: XYZ;
    readonly z: XYZ;
    /** Puts a point onto the face's plane (planar) or axis (cylinder). */
    readonly project: (point: XYZ) => XYZ;
}

function faceAxis(face: IFace): FaceAxis {
    const surface = unwrapSurface(face.surface());
    try {
        const box = BoundingBox.center(face.boundingBox());
        if (isCylinder(surface)) {
            const origin = surface.location;
            const axis = surface.axis.normalize() ?? XYZ.unitZ;
            const project = (p: XYZ) => origin.add(axis.multiply(axis.dot(p.sub(origin))));
            return { center: project(box), z: axis, project };
        }
        const [point, normal] = face.normal(0, 0);
        const n = normal.normalize() ?? XYZ.unitZ;
        const project = (p: XYZ) => p.sub(n.multiply(n.dot(p.sub(point))));
        return { center: surface.isPlanar() ? project(box) : point, z: n, project };
    } finally {
        surface.dispose();
    }
}

function nearest(target: XYZ, candidates: XYZ[]): XYZ | undefined {
    let best: XYZ | undefined;
    for (const candidate of candidates) {
        if (best === undefined || candidate.distanceTo(target) < best.distanceTo(target)) best = candidate;
    }
    return best;
}

/**
 * The frame `snap` gives on `shape` (a face, edge or vertex, in the node's shape space); `hint`
 * picks the key point of a `facePoint`. Undefined when the snap does not apply to the shape.
 */
export function snapFrame(shape: IShape, snap: JointSnap, hint?: XYZLike): JointFrame | undefined {
    if (shape.shapeType === ShapeTypes.vertex) {
        return { origin: (shape as IVertex).point(), z: XYZ.unitZ, x: XYZ.unitX };
    }
    if (shape.shapeType === ShapeTypes.face) {
        const face = shape as IFace;
        const axis = faceAxis(face);
        if (snap !== "facePoint" || hint === undefined) return frameOn(axis.center, axis.z);
        const point = nearest(new XYZ(hint), faceKeyPoints(face)) ?? axis.center;
        return frameOn(axis.project(point), axis.z);
    }
    if (shape.shapeType !== ShapeTypes.edge) return undefined;
    const edge = shape as IEdge;
    const basis = edge.curve.basisCurve;
    if (CurveUtils.isCircle(basis)) return frameOn(basis.center, basis.axis);
    const [start, end] = edge.ends();
    const direction = end.sub(start);
    const mid = edge.pointAt((edge.firstParameter() + edge.lastParameter()) / 2);
    const z = direction.normalize() ?? XYZ.unitZ;
    if (snap === "edgeStart") return frameOn(start, z);
    if (snap === "edgeEnd") return frameOn(end, z);
    return frameOn(mid, z);
}

/** The snap a click at `hit` (shape space) lands on: the nearest of the shape's snap points. */
export function snapOfPick(shape: IShape, hit: XYZ | undefined): JointSnap {
    if (shape.shapeType === ShapeTypes.vertex) return "vertex";
    if (shape.shapeType === ShapeTypes.face) {
        if (hit === undefined) return "faceCenter";
        const axis = faceAxis(shape as IFace);
        const point = nearest(hit, faceKeyPoints(shape as IFace));
        if (point === undefined) return "faceCenter";
        return axis.project(point).distanceTo(hit) < axis.center.distanceTo(hit) ? "facePoint" : "faceCenter";
    }
    const edge = shape as IEdge;
    if (CurveUtils.isCircle(edge.curve.basisCurve)) return "circleCenter";
    if (hit === undefined || !CurveUtils.isLine(edge.curve.basisCurve)) return "edgeMid";
    const [start, end] = edge.ends();
    const mid = edge.pointAt((edge.firstParameter() + edge.lastParameter()) / 2);
    const d = [mid, start, end].map((p) => p.distanceTo(hit));
    const best = d.indexOf(Math.min(...d));
    return (["edgeMid", "edgeStart", "edgeEnd"] as const)[best];
}

function kindOf(shape: IShape): "face" | "edge" | "vertex" | undefined {
    if (shape.shapeType === ShapeTypes.face) return "face";
    if (shape.shapeType === ShapeTypes.edge) return "edge";
    if (shape.shapeType === ShapeTypes.vertex) return "vertex";
    return undefined;
}

function subIdOf(
    node: INode,
    kind: "face" | "edge" | "vertex",
    index: number | undefined,
): string | undefined {
    if (index === undefined || index < 0 || !isBodyTrackingNode(node)) return undefined;
    if (kind === "face") return node.faceIdAt(index);
    if (kind === "edge") return node.edgeIdAt(index);
    return undefined;
}

/**
 * Captures the joint origin picked on `shape` — a sub-shape of `node`'s shape, in the node's
 * shape space, `index` its index there — at `hit` (also shape space). Undefined for a pick that
 * is not a face, edge or vertex.
 */
export function captureJointOrigin(
    node: INode,
    shape: IShape,
    index: number | undefined,
    hit: XYZ | undefined,
): JointOriginRef | undefined {
    const kind = kindOf(shape);
    if (kind === undefined) return undefined;
    const snap = snapOfPick(shape, hit);
    const frame = snapFrame(shape, snap, hit);
    if (frame === undefined) return undefined;
    const subId = subIdOf(node, kind, index);
    return {
        nodeId: node.id,
        kind,
        snap,
        ...(index === undefined || index < 0 ? {} : { index }),
        ...(subId === undefined ? {} : { subId }),
        point: plainVec(new XYZ(frame.origin)),
        direction: plainVec(new XYZ(frame.z)),
        frame: plainFrame(frame),
    };
}

export function plainFrame(frame: JointFrame): JointFrame {
    return {
        origin: plainVec(new XYZ(frame.origin)),
        x: plainVec(new XYZ(frame.x)),
        z: plainVec(new XYZ(frame.z)),
    };
}

/** An origin with no geometry: `frame` in the local space of the component `componentId`. */
export function fixedJointOrigin(componentId: string, frame: JointFrame): JointOriginRef {
    return { nodeId: componentId, kind: "fixed", frame: plainFrame(frame) };
}

/** A resolved origin: its frame in the shape space of `node`, and whether the geometry was found. */
export interface ResolvedJointOrigin {
    readonly node: INode | undefined;
    readonly frame: JointFrame;
    readonly lost: boolean;
}

/**
 * Finds the joint origin on the node's current shape. The tracked id is tried first, then the
 * fingerprint (the same kind of sub-shape whose snapped origin lies closest to the stored one,
 * its axis parallel), then the stored index; when nothing is left the stored frame is kept and
 * the result says `lost`.
 */
export function resolveJointOrigin(document: IDocument, ref: JointOriginRef): ResolvedJointOrigin {
    const node = document.modelManager.findNode((n) => n.id === ref.nodeId);
    if (ref.kind === "fixed") return { node, frame: ref.frame, lost: false };
    if (!(node instanceof ShapeNode) || !node.shape.isOk) return { node, frame: ref.frame, lost: true };
    const candidates = node.shape.value.findSubShapes(KIND_TYPES[ref.kind]);
    const shape = matchById(node, ref, candidates) ?? matchByFingerprint(ref, candidates);
    const fallback = shape ?? (ref.index === undefined ? undefined : candidates[ref.index]);
    const frame =
        fallback === undefined ? undefined : snapFrame(fallback, ref.snap ?? "faceCenter", ref.point);
    if (frame === undefined) return { node, frame: ref.frame, lost: true };
    return { node, frame, lost: false };
}

function matchById(node: INode, ref: JointOriginRef, candidates: IShape[]): IShape | undefined {
    if (ref.subId === undefined || !isBodyTrackingNode(node)) return undefined;
    const index = ref.kind === "face" ? node.faceIndexById(ref.subId) : node.edgeIndexById(ref.subId);
    return index === undefined ? undefined : candidates[index];
}

function matchByFingerprint(ref: JointOriginRef, candidates: IShape[]): IShape | undefined {
    if (ref.point === undefined) return undefined;
    const point = new XYZ(ref.point);
    const direction = ref.direction === undefined ? undefined : new XYZ(ref.direction);
    let best: IShape | undefined;
    let bestScore = Infinity;
    for (const candidate of candidates) {
        const frame = snapFrame(candidate, ref.snap ?? "faceCenter", ref.point);
        if (frame === undefined) continue;
        const parallel = direction === undefined || Math.abs(new XYZ(frame.z).dot(direction)) > 1 - 1e-6;
        const score = new XYZ(frame.origin).distanceTo(point) + (parallel ? 0 : 1e6);
        if (score < bestScore) {
            best = candidate;
            bestScore = score;
        }
    }
    return best;
}
