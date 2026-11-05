// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    CurveUtils,
    type IDocument,
    type IEdge,
    type IShape,
    type IVertex,
    Plane,
    Precision,
    Result,
    ShapeTypes,
    XYZ,
    type XYZLike,
} from "@chili3d/core";
import { faceNormalAt, perpendicularTo, revolutionAxisOfFace, rotateAbout } from "../datum/surfaceGeometry";
import { captureEdgeRef, type EdgeRef } from "../features/edgeRef";
import type { NeutralPlaneRef } from "../features/feature";
import { MATCH_TOLERANCE, plainVec } from "../features/refGeometry";
import type { VertexRef } from "../features/vertexRef";
import { worldAxisXVec } from "../sketch/planeRef";
import { resolvePlaneSourceInWorld } from "./planeSource";
import { type FaceSourceRef, resolvePoint, withEdge, withFace, withNearestCurve } from "./sourceRefs";

/**
 * A stable identity for a vertex on an edge: the edge's fingerprint plus which END the
 * vertex is, and both captured endpoint positions (so a rebuild that flips the edge's
 * parameterization still names the same physical end). A vertex usually has two or three
 * incident edges; all are kept, and the first that re-matches wins.
 */
export interface VertexAnchor {
    readonly edge: EdgeRef;
    /** 0 = the edge's start, 1 = its end. */
    readonly end: 0 | 1;
    /** Both endpoints as captured, in the source node's local frame. */
    readonly ends: readonly [XYZLike, XYZLike];
}

/**
 * A vertex a plane definition runs through. `vertex` is the positional fallback in the
 * source node's LOCAL frame; `incident` is the topology-based identity that survives an
 * upstream parameter edit moving the vertex. Without an incident edge (or when it is
 * lost), resolution falls back to the positional match.
 */
export interface PointRef {
    readonly nodeId: string;
    readonly vertex: VertexRef;
    readonly incident?: readonly VertexAnchor[];
}

/**
 * The incident edges that name `vertex`, captured from `shape` (the source node's LOCAL
 * shape). `edgeIdAt` supplies a parametric body's tracked edge ids; other nodes fall back
 * to the geometric fingerprint. Up to four anchors are kept — a solid corner has two or
 * three, and one surviving edge is enough.
 */
export function captureVertexAnchors(
    shape: IShape,
    vertex: IVertex,
    edgeIdAt?: (index: number) => string | undefined,
): VertexAnchor[] | undefined {
    let point: XYZ;
    try {
        point = vertex.point();
    } catch {
        return undefined;
    }
    const edges = shape.findSubShapes(ShapeTypes.edge) as IEdge[];
    const anchors: VertexAnchor[] = [];
    for (const [index, edge] of edges.entries()) {
        let start: XYZ;
        let end: XYZ;
        try {
            start = edge.startPoint();
            end = edge.endPoint();
        } catch {
            continue;
        }
        const atStart = start.distanceTo(point) <= MATCH_TOLERANCE;
        const atEnd = end.distanceTo(point) <= MATCH_TOLERANCE;
        if (!atStart && !atEnd) continue;
        try {
            anchors.push({
                edge: captureEdgeRef(edge, edgeIdAt?.(index)),
                end: atStart ? 0 : 1,
                ends: [plainVec(start), plainVec(end)],
            });
        } catch {
            // A degenerate edge cannot name a vertex.
        }
        if (anchors.length >= 4) break;
    }
    return anchors.length === 0 ? undefined : anchors;
}

/** An edge a plane definition takes its direction/curve from, captured in world coordinates. */
export interface EdgeSourceRef {
    readonly nodeId: string;
    readonly edge: EdgeRef;
}

/** Fields every definition carries: the timeline positions its refs were captured at. */
interface PlaneDefinitionBase {
    /**
     * For each source node that is a parametric body, the feature-list index its geometry
     * was captured against. Resolution reads the node's shape AT that position, so a
     * feature added afterwards neither drags the datum plane nor creates a rebuild cycle.
     */
    readonly anchors?: Readonly<Record<string, number>>;
    /** Reverses the constructed plane's normal without moving it. */
    readonly flip?: boolean;
    /**
     * A point of the plane near what it was made from (a face click, a picked point, a
     * line's start). The display square is drawn around it when no sketch is bound — the
     * plane's frame origin is the world origin's projection and can be far away.
     */
    readonly anchor?: XYZLike;
}

/**
 * How a user-created datum plane is defined. Every geometric reference is captured in
 * world coordinates; a rebuild re-matches it on the source node's current geometry (at
 * its captured timeline anchor).
 */
export type PlaneDefinition =
    | ({
          readonly kind: "offset";
          readonly source: NeutralPlaneRef;
          readonly distance: number;
          /** Offset to the other side of the source plane (Onshape's opposite direction). */
          readonly reverse?: boolean;
      } & PlaneDefinitionBase)
    | ({
          readonly kind: "planePoint";
          readonly source: NeutralPlaneRef;
          readonly point: PointRef;
      } & PlaneDefinitionBase)
    | ({
          readonly kind: "lineAngle";
          readonly line: EdgeSourceRef;
          readonly reference: NeutralPlaneRef;
          readonly angle: number;
          /** The captured line direction, so a rebuild's flipped parameterization keeps the angle's sense. */
          readonly direction?: XYZLike;
      } & PlaneDefinitionBase)
    | ({
          readonly kind: "pointNormal";
          readonly axis: EdgeSourceRef;
          readonly point: PointRef;
          /** The captured axis direction, so a flipped edge parameterization keeps the normal's sign. */
          readonly direction?: XYZLike;
      } & PlaneDefinitionBase)
    | ({
          readonly kind: "threePoint";
          readonly points: readonly [PointRef, PointRef, PointRef];
      } & PlaneDefinitionBase)
    | ({
          readonly kind: "midPlane";
          readonly first: NeutralPlaneRef;
          readonly second: NeutralPlaneRef;
      } & PlaneDefinitionBase)
    | ({
          readonly kind: "curvePoint";
          readonly curve: EdgeSourceRef;
          /** Selects the nearest point on the curve; the plane passes through that point. */
          readonly point: PointRef;
          /** The captured tangent, so a rebuild's flipped curve direction does not flip the normal. */
          readonly tangent?: XYZLike;
      } & PlaneDefinitionBase)
    | ({
          readonly kind: "tangent";
          /** A cylindrical/conical (any axis-of-revolution) face the plane touches. */
          readonly face: FaceSourceRef;
          /**
           * Where on the face the pick landed, in the face source's LOCAL frame: the line of
           * contact at angle 0. A rebuild that moves the face carries the point with it.
           */
          readonly at: XYZLike;
          /** Rotation of the line of contact about the face's axis, in degrees. */
          readonly angle: number;
      } & PlaneDefinitionBase);

/**
 * The plane's frame from the plane ALONE: its origin and normal determine the in-plane
 * X axis (world-up rule), exactly as a sketch on a flat face does. This is what keeps a
 * construction plane's frame still when a pick order, an edge parameterization or a
 * source plane's own arbitrary X axis changes underneath it.
 */
function canonicalFrame(origin: XYZ, normal: XYZ): Plane {
    const n = normal.normalize();
    if (n === undefined) throw new Error("Plane normal is degenerate");
    return new Plane({ origin, normal: n, xvec: worldAxisXVec(n) });
}

/** `flip` reverses the plane's normal; the frame is then rebuilt from the new normal. */
function applyFlip(plane: Plane, flip: boolean | undefined): Plane {
    if (flip !== true) return plane;
    return canonicalFrame(plane.origin, plane.normal.reverse());
}

/** A plane through `point` whose normal is `normal`, with a stable, Z-up in-plane X axis. */
function planeAtPoint(point: XYZ, normal: XYZ): Result<Plane> {
    const n = normal.normalize();
    if (n === undefined) return Result.err("Plane normal is degenerate");
    return Result.ok(canonicalFrame(point, n));
}

/**
 * Resolves a definition against the document's current geometry. The returned plane is in
 * world coordinates; `PlaneNode` maps it into its own frame before building the display
 * rectangle.
 */
export function resolvePlaneDefinition(
    definition: PlaneDefinition,
    document: IDocument,
    visited?: ReadonlySet<string>,
): Result<Plane> {
    // Kernel queries (a degenerate edge's `curve`, a null face normal, ...) throw JS Errors
    // by design; a datum plane must fail as a value, never tear down the caller's rebuild.
    try {
        switch (definition.kind) {
            case "offset":
                return offsetDefinition(definition, document, visited);
            case "planePoint":
                return planePointDefinition(definition, document, visited);
            case "lineAngle":
                return lineAngleDefinition(definition, document, visited);
            case "pointNormal":
                return pointNormalDefinition(definition, document, visited);
            case "threePoint":
                return threePointDefinition(definition, document, visited);
            case "midPlane":
                return midPlaneDefinition(definition, document, visited);
            case "curvePoint":
                return curvePointDefinition(definition, document, visited);
            case "tangent":
                return tangentDefinition(definition, document);
            default:
                return Result.err(
                    `Unknown plane definition: ${String((definition as { kind?: string }).kind)}`,
                );
        }
    } catch (error) {
        return Result.err(`Plane definition could not be resolved: ${String(error)}`);
    }
}

function sourcePlane(
    document: IDocument,
    ref: NeutralPlaneRef,
    anchors: PlaneDefinitionBase["anchors"],
    label: string,
    visited: ReadonlySet<string> | undefined,
): Result<Plane> {
    return resolvePlaneSourceInWorld(document, ref, anchors, { label, visited });
}

function offsetDefinition(
    definition: Extract<PlaneDefinition, { kind: "offset" }>,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<Plane> {
    if (!Number.isFinite(definition.distance)) {
        return Result.err("Plane offset distance is not a finite number");
    }
    const source = sourcePlane(document, definition.source, definition.anchors, "Plane", visited);
    if (!source.isOk) return source;
    const distance = definition.reverse === true ? -definition.distance : definition.distance;
    const offsetted = source.value.offsetAlongNormal(distance);
    return Result.ok(applyFlip(canonicalFrame(offsetted.origin, offsetted.normal), definition.flip));
}

function planePointDefinition(
    definition: Extract<PlaneDefinition, { kind: "planePoint" }>,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<Plane> {
    const source = sourcePlane(document, definition.source, definition.anchors, "Plane", visited);
    if (!source.isOk) return source;
    const point = resolvePoint(document, definition.point, definition.anchors, "Plane", visited);
    if (!point.isOk) return Result.err(point.error);
    return Result.ok(applyFlip(canonicalFrame(point.value, source.value.normal), definition.flip));
}

function pointNormalDefinition(
    definition: Extract<PlaneDefinition, { kind: "pointNormal" }>,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<Plane> {
    const point = resolvePoint(document, definition.point, definition.anchors, "Plane", visited);
    if (!point.isOk) return Result.err(point.error);
    const axis = withEdge(
        document,
        definition.axis,
        definition.anchors,
        "Plane",
        (edge, transform) => {
            const resolved = axisOfEdge(edge);
            if (!resolved.isOk || definition.direction === undefined) return resolved;
            // The captured direction lives in the source's LOCAL frame, like the edge ref.
            const captured = transform.ofVector(new XYZ(definition.direction));
            return Result.ok(resolved.value.dot(captured) < 0 ? resolved.value.reverse() : resolved.value);
        },
        visited,
    );
    if (!axis.isOk) return Result.err(axis.error);
    const plane = planeAtPoint(point.value, axis.value);
    return plane.isOk ? Result.ok(applyFlip(plane.value, definition.flip)) : plane;
}

function lineAngleDefinition(
    definition: Extract<PlaneDefinition, { kind: "lineAngle" }>,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<Plane> {
    if (!Number.isFinite(definition.angle)) {
        return Result.err("Plane angle is not a finite number");
    }
    const line = withEdge(
        document,
        definition.line,
        definition.anchors,
        "Plane",
        (edge, transform) => {
            if (!isLineEdge(edge)) return Result.err("Line angle requires a straight edge");
            let start = edge.startPoint();
            let end = edge.endPoint();
            let direction = end.sub(start);
            // The captured direction is in the source's LOCAL frame; a rebuild may return the
            // same geometric edge with a flipped parameterization. Aligning the direction must
            // also move the origin to what was the captured start, or the plane origin jumps
            // to the other end of the line.
            const captured =
                definition.direction === undefined
                    ? undefined
                    : transform.ofVector(new XYZ(definition.direction));
            if (captured !== undefined && direction.dot(captured) < 0) {
                [start, end] = [end, start];
                direction = direction.reverse();
            }
            return Result.ok({ point: start, direction });
        },
        visited,
    );
    if (!line.isOk) return Result.err(line.error);
    const reference = sourcePlane(document, definition.reference, definition.anchors, "Plane", visited);
    if (!reference.isOk) return Result.err(reference.error);
    return lineAnglePlane(
        line.value.point,
        line.value.direction,
        reference.value,
        definition.angle,
        undefined,
        definition.flip,
    );
}

function threePointDefinition(
    definition: Extract<PlaneDefinition, { kind: "threePoint" }>,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<Plane> {
    const points: XYZ[] = [];
    for (const ref of definition.points) {
        const point = resolvePoint(document, ref, definition.anchors, "Plane", visited);
        if (!point.isOk) return Result.err(point.error);
        points.push(point.value);
    }
    return threePointPlane(points[0], points[1], points[2], definition.flip);
}

function midPlaneDefinition(
    definition: Extract<PlaneDefinition, { kind: "midPlane" }>,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<Plane> {
    const first = sourcePlane(document, definition.first, definition.anchors, "Plane", visited);
    if (!first.isOk) return first;
    const second = sourcePlane(document, definition.second, definition.anchors, "Plane", visited);
    if (!second.isOk) return second;
    return midPlaneOf(first.value, second.value, definition.flip);
}

function curvePointDefinition(
    definition: Extract<PlaneDefinition, { kind: "curvePoint" }>,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<Plane> {
    const point = resolvePoint(document, definition.point, definition.anchors, "Plane", visited);
    if (!point.isOk) return Result.err(point.error);
    const tangent = withNearestCurve(
        document,
        definition.curve,
        definition.anchors,
        point.value,
        "Plane",
        (edge) => {
            const nearest = edge.curve.nearestFromPoint(point.value);
            const derivative = edge.curve.d1(nearest.parameter);
            const direction = derivative.vec.normalize();
            return direction === undefined
                ? Result.err("Curve tangent is degenerate")
                : Result.ok({ direction, origin: nearest.point });
        },
        visited,
    );
    if (!tangent.isOk) return Result.err(tangent.error);
    // The picked point selects WHERE along the curve; the plane passes through that curve
    // point, so an off-curve pick cannot build geometry unrelated to the curve.
    return curvePointPlane(
        tangent.value.origin,
        tangent.value.direction,
        definition.tangent,
        definition.flip,
    );
}

/**
 * A plane tangent to an axis-of-revolution face (Tangent Plane). The stored pick
 * point is rotated about the face's axis by `angle` and projected back onto the surface;
 * the plane touches the face there, its normal pointing away from the axis.
 */
function tangentDefinition(
    definition: Extract<PlaneDefinition, { kind: "tangent" }>,
    document: IDocument,
): Result<Plane> {
    if (!Number.isFinite(definition.angle)) return Result.err("Plane angle is not a finite number");
    return withFace(document, definition.face, definition.anchors, "Plane", (face, transform) => {
        const axis = revolutionAxisOfFace(face);
        if (!axis.isOk) return Result.err("Tangent plane requires a cylindrical or conical face");
        const at = transform.ofPoint(new XYZ(definition.at));
        const radians = (definition.angle * Math.PI) / 180;
        const rotated = rotateAbout(at, axis.value.point, axis.value.direction, radians);
        const touch = faceNormalAt(face, rotated);
        if (!touch.isOk) return Result.err(touch.error);
        const radial = perpendicularTo(touch.value.point.sub(axis.value.point), axis.value.direction);
        const normal = radial.dot(touch.value.normal) < 0 ? touch.value.normal.reverse() : touch.value.normal;
        const plane = planeAtPoint(touch.value.point, normal);
        return plane.isOk ? Result.ok(applyFlip(plane.value, definition.flip)) : plane;
    });
}

// ---------------------------------------------------------------------------------------
// Pure math. Exported so the construction rules can be unit-tested without a document.
// ---------------------------------------------------------------------------------------

export function lineAnglePlane(
    linePoint: XYZ,
    lineDirection: XYZ,
    reference: Plane,
    angleDegrees: number,
    capturedDirection: XYZLike | undefined,
    flip: boolean | undefined,
): Result<Plane> {
    let direction = lineDirection.normalize();
    if (direction === undefined) return Result.err("Line direction is degenerate");
    if (capturedDirection !== undefined && direction.dot(new XYZ(capturedDirection)) < 0) {
        direction = direction.reverse();
    }
    const referenceNormal = reference.normal.normalize();
    if (referenceNormal === undefined) return Result.err("Reference plane normal is degenerate");
    const perpendicular = referenceNormal.sub(direction.multiply(referenceNormal.dot(direction))).normalize();
    if (perpendicular === undefined) {
        return Result.err("Line is parallel to the reference plane normal");
    }
    const normal = perpendicular.rotate(direction, (angleDegrees * Math.PI) / 180);
    if (normal === undefined) return Result.err("Plane normal is degenerate");
    return Result.ok(applyFlip(canonicalFrame(linePoint, normal), flip));
}

export function threePointPlane(
    first: XYZ,
    second: XYZ,
    third: XYZ,
    flip: boolean | undefined,
): Result<Plane> {
    const x = second.sub(first).normalize();
    const normal = second.sub(first).cross(third.sub(first)).normalize();
    if (x === undefined || normal === undefined) {
        return Result.err("Three points are collinear");
    }
    return Result.ok(applyFlip(canonicalFrame(first, normal), flip));
}

export function midPlaneOf(first: Plane, second: Plane, flip: boolean | undefined): Result<Plane> {
    const dot = first.normal.dot(second.normal);
    if (Math.abs(Math.abs(dot) - 1) <= 1e-6) return parallelMidPlane(first, second, flip);
    return bisectorPlane(first, second, dot, flip);
}

function parallelMidPlane(first: Plane, second: Plane, flip: boolean | undefined): Result<Plane> {
    const normal = first.normal;
    const firstOffset = normal.dot(first.origin);
    const secondOffset = normal.dot(second.origin);
    if (Math.abs(secondOffset - firstOffset) <= Precision.Distance) {
        return Result.err("The two planes are coincident");
    }
    const origin = first.origin.add(normal.multiply((secondOffset - firstOffset) / 2));
    return Result.ok(applyFlip(canonicalFrame(origin, normal), flip));
}

/**
 * One of the two bisectors of intersecting planes: the normals add (or, with `flip`,
 * subtract); the frame is then rebuilt from the resulting normal, so it depends on the
 * plane alone. Onshape's control for this case is "Flip alignment", which switches WHICH
 * bisector is built — not the normal direction of one of them.
 */
function bisectorPlane(first: Plane, second: Plane, dot: number, flip: boolean | undefined): Result<Plane> {
    const secondNormal = dot < 0 ? second.normal.reverse() : second.normal;
    const combined = flip === true ? first.normal.sub(secondNormal) : first.normal.add(secondNormal);
    const normal = combined.normalize();
    const line = first.normal.cross(second.normal).normalize();
    if (normal === undefined || line === undefined) return Result.err("The two planes do not intersect");
    const denominator = 1 - dot * dot;
    const firstOffset = first.normal.dot(first.origin);
    const secondOffset = second.normal.dot(second.origin);
    const origin = first.normal
        .multiply((firstOffset - secondOffset * dot) / denominator)
        .add(second.normal.multiply((secondOffset - firstOffset * dot) / denominator));
    return Result.ok(canonicalFrame(origin, normal));
}

export function curvePointPlane(
    point: XYZ,
    tangent: XYZ,
    capturedTangent: XYZLike | undefined,
    flip: boolean | undefined,
): Result<Plane> {
    let normal = tangent.normalize();
    if (normal === undefined) return Result.err("Curve tangent is degenerate");
    if (capturedTangent !== undefined && normal.dot(new XYZ(capturedTangent)) < 0) {
        normal = normal.reverse();
    }
    const plane = planeAtPoint(point, normal);
    return plane.isOk ? Result.ok(applyFlip(plane.value, flip)) : plane;
}

function isLineEdge(edge: IEdge): boolean {
    return CurveUtils.isLine(edge.curve.basisCurve);
}

/** Axis direction of a straight edge or the axis of a circular edge. */
function axisOfEdge(edge: IEdge): Result<XYZ> {
    const basis = edge.curve.basisCurve;
    if (CurveUtils.isCircle(basis)) return Result.ok(basis.axis);
    if (CurveUtils.isLine(basis)) return Result.ok(edge.endPoint().sub(edge.startPoint()));
    return Result.err("Point normal requires a straight or circular edge");
}
