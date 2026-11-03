// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { CurveUtils, type IDocument, type IEdge, Result, ShapeNode, XYZ, type XYZLike } from "@chili3d/core";
import { type NeutralPlaneRef, planeRefNodeId } from "../features/feature";
import type { EdgeSourceRef, PointRef } from "../plane/planeDefinition";
import { resolvePlaneSourceInWorld } from "../plane/planeSource";
import { type FaceSourceRef, resolvePoint, withEdge, withFace } from "../plane/sourceRefs";
import type { DatumAxisValue } from "./datumContract";
import { faceNormalAt, revolutionAxisOfFace, spanAlong } from "./surfaceGeometry";

/** Fields every datum (axis or point) definition carries — see `PlaneDefinitionBase`. */
export interface DatumDefinitionBase {
    readonly anchors?: Readonly<Record<string, number>>;
    /**
     * A world point near what the datum was made from — where an unbounded result (the
     * intersection of two datum planes) is drawn.
     */
    readonly anchor?: XYZLike;
}

/**
 * How a construction axis is defined (Fusion's CONSTRUCT ▸ Axis). Every reference is
 * captured like a datum plane's — in the source node's LOCAL frame, anchored to its timeline
 * position — so the axis follows its geometry when the model rebuilds.
 */
export type AxisDefinition = (
    | {
          /** The axis of a cylindrical, conical, spherical, toroidal or revolved face. */
          readonly kind: "faceAxis";
          readonly face: FaceSourceRef;
      }
    | {
          /** Along a straight edge (or through a circular edge's centre, along its axis). */
          readonly kind: "edge";
          readonly edge: EdgeSourceRef;
          /** The captured direction, so a rebuild's flipped parameterization keeps the sense. */
          readonly direction?: XYZLike;
      }
    | { readonly kind: "twoPoints"; readonly points: readonly [PointRef, PointRef] }
    | {
          /** The line where two planes (or planar faces) meet. */
          readonly kind: "twoPlanes";
          readonly first: NeutralPlaneRef;
          readonly second: NeutralPlaneRef;
      }
    | {
          /** Perpendicular to a face, through the point's projection onto it. */
          readonly kind: "faceNormal";
          readonly face: FaceSourceRef;
          readonly point: PointRef;
      }
    | {
          /** Through a point, perpendicular to a plane. */
          readonly kind: "pointPlane";
          readonly point: PointRef;
          readonly plane: NeutralPlaneRef;
      }
) &
    DatumDefinitionBase & {
        /** Reverses the axis direction without moving it. */
        readonly flip?: boolean;
    };

/** The segment drawn when the definition has no geometry of its own to fit. */
export const DEFAULT_AXIS_LENGTH = 100;
const MIN_MARGIN = 2;
const MARGIN_RATIO = 0.1;

interface AxisLine {
    readonly point: XYZ;
    readonly direction: XYZ;
    /** The extent of the referenced geometry along the axis, measured from `point`. */
    readonly span?: { readonly min: number; readonly max: number };
}

/**
 * Resolves a definition against the document's current geometry, in WORLD coordinates. The
 * drawn segment is the referenced geometry's extent along the axis plus a margin, so the axis
 * reads as belonging to what it was made from.
 */
export function resolveAxisDefinition(
    definition: AxisDefinition,
    document: IDocument,
    visited?: ReadonlySet<string>,
): Result<DatumAxisValue> {
    let line: Result<AxisLine>;
    try {
        line = resolveLine(definition, document, visited);
    } catch (error) {
        return Result.err(`Axis definition could not be resolved: ${String(error)}`);
    }
    if (!line.isOk) return Result.err(line.error);
    return Result.ok(axisValue(line.value, definition.flip === true));
}

function resolveLine(
    definition: AxisDefinition,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<AxisLine> {
    const anchors = definition.anchors;
    switch (definition.kind) {
        case "faceAxis":
            return withFace(document, definition.face, anchors, "Axis", (face) => {
                const axis = revolutionAxisOfFace(face);
                if (!axis.isOk) return Result.err(axis.error);
                const { point, direction } = axis.value;
                return Result.ok({ point, direction, span: spanAlong(face, point, direction) });
            });
        case "edge":
            return edgeLine(definition, document, visited);
        case "twoPoints":
            return twoPointLine(definition, document, visited);
        case "twoPlanes":
            return twoPlaneLine(definition, document, visited);
        case "faceNormal":
            return faceNormalLine(definition, document, visited);
        case "pointPlane":
            return pointPlaneLine(definition, document, visited);
        default:
            return Result.err(`Unknown axis definition: ${String((definition as { kind?: string }).kind)}`);
    }
}

function edgeLine(
    definition: Extract<AxisDefinition, { kind: "edge" }>,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<AxisLine> {
    return withEdge(
        document,
        definition.edge,
        definition.anchors,
        "Axis",
        (edge, transform) => {
            const line = lineOfEdge(edge);
            if (!line.isOk || definition.direction === undefined) return line;
            const captured = transform.ofVector(new XYZ(definition.direction));
            return Result.ok(line.value.direction.dot(captured) < 0 ? reversed(line.value) : line.value);
        },
        visited,
    );
}

/** A straight edge as its own line (span = the edge), a circular one as its axis. */
function lineOfEdge(edge: IEdge): Result<AxisLine> {
    const basis = edge.curve.basisCurve;
    if (CurveUtils.isCircle(basis)) {
        const direction = basis.axis.normalize();
        if (direction === undefined) return Result.err("Circle axis is degenerate");
        return Result.ok({ point: basis.center, direction, span: undefined });
    }
    if (!CurveUtils.isLine(basis)) return Result.err("Axis requires a straight or circular edge");
    const start = edge.startPoint();
    const chord = edge.endPoint().sub(start);
    const direction = chord.normalize();
    if (direction === undefined) return Result.err("Axis edge is degenerate");
    return Result.ok({ point: start, direction, span: { min: 0, max: chord.length() } });
}

function reversed(line: AxisLine): AxisLine {
    const span = line.span === undefined ? undefined : { min: -line.span.max, max: -line.span.min };
    return { point: line.point, direction: line.direction.reverse(), span };
}

function twoPointLine(
    definition: Extract<AxisDefinition, { kind: "twoPoints" }>,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<AxisLine> {
    const first = resolvePoint(document, definition.points[0], definition.anchors, "Axis", visited);
    if (!first.isOk) return Result.err(first.error);
    const second = resolvePoint(document, definition.points[1], definition.anchors, "Axis", visited);
    if (!second.isOk) return Result.err(second.error);
    const chord = second.value.sub(first.value);
    const direction = chord.normalize();
    if (direction === undefined || chord.length() < 1e-9) return Result.err("The two points coincide");
    return Result.ok({ point: first.value, direction, span: { min: 0, max: chord.length() } });
}

function twoPlaneLine(
    definition: Extract<AxisDefinition, { kind: "twoPlanes" }>,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<AxisLine> {
    const options = { label: "Axis", visited };
    const first = resolvePlaneSourceInWorld(document, definition.first, definition.anchors, options);
    if (!first.isOk) return Result.err(first.error);
    const second = resolvePlaneSourceInWorld(document, definition.second, definition.anchors, options);
    if (!second.isOk) return Result.err(second.error);
    const line = planeIntersection(first.value, second.value, anchorOf(definition));
    if (!line.isOk) return line;
    const span = mergeSpans(
        faceSpan(document, definition.first, line.value),
        faceSpan(document, definition.second, line.value),
    );
    return Result.ok({ ...line.value, span });
}

/** The world anchor of a definition, or the origin. */
function anchorOf(definition: DatumDefinitionBase): XYZ {
    const anchor = definition.anchor;
    return anchor === undefined ? XYZ.zero : new XYZ(anchor);
}

/**
 * The line two planes meet in. Its point is the one nearest `near` (the pick), so the drawn
 * segment sits where the user was looking rather than at the world origin's foot.
 */
export function planeIntersection(
    first: { origin: XYZ; normal: XYZ },
    second: { origin: XYZ; normal: XYZ },
    near: XYZ,
): Result<AxisLine> {
    const direction = first.normal.cross(second.normal).normalize();
    if (direction === undefined || first.normal.cross(second.normal).length() < 1e-9) {
        return Result.err("The two planes are parallel");
    }
    // The three planes (the two, plus the one through `near` normal to the line) meet in one point.
    const point = threePlanePoint(
        [first.normal, first.normal.dot(first.origin)],
        [second.normal, second.normal.dot(second.origin)],
        [direction, direction.dot(near)],
    );
    if (point === undefined) return Result.err("The two planes are parallel");
    return Result.ok({ point, direction });
}

/** The point where three planes `n·x = d` meet, or undefined when two are parallel. */
export function threePlanePoint(
    first: readonly [XYZ, number],
    second: readonly [XYZ, number],
    third: readonly [XYZ, number],
): XYZ | undefined {
    const [n1, d1] = first;
    const [n2, d2] = second;
    const [n3, d3] = third;
    const c23 = n2.cross(n3);
    const det = n1.dot(c23);
    if (Math.abs(det) < 1e-9) return undefined;
    return c23
        .multiply(d1)
        .add(n3.cross(n1).multiply(d2))
        .add(n1.cross(n2).multiply(d3))
        .multiply(1 / det);
}

/**
 * The extent of a face ref's whole source node along the line, so an axis where two body
 * faces meet is drawn across the body. A datum plane names no geometry and has none.
 */
function faceSpan(
    document: IDocument,
    ref: NeutralPlaneRef,
    line: AxisLine,
): { min: number; max: number } | undefined {
    if (ref.kind !== "face") return undefined;
    const node = document.modelManager.findNode((candidate) => candidate.id === ref.ref.nodeId);
    if (!(node instanceof ShapeNode) || !node.shape.isOk) return undefined;
    const inverse = node.worldTransform().invert();
    if (inverse === undefined) return undefined;
    const direction = inverse.ofVector(line.direction).normalize();
    if (direction === undefined) return undefined;
    const span = spanAlong(node.shape.value, inverse.ofPoint(line.point), direction);
    // A scaled placement would stretch the parameter; the extent is a display hint only.
    return span;
}

function mergeSpans(
    first: { min: number; max: number } | undefined,
    second: { min: number; max: number } | undefined,
): { min: number; max: number } | undefined {
    if (first === undefined) return second;
    if (second === undefined) return first;
    return { min: Math.min(first.min, second.min), max: Math.max(first.max, second.max) };
}

function faceNormalLine(
    definition: Extract<AxisDefinition, { kind: "faceNormal" }>,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<AxisLine> {
    const point = resolvePoint(document, definition.point, definition.anchors, "Axis", visited);
    if (!point.isOk) return Result.err(point.error);
    return withFace(document, definition.face, definition.anchors, "Axis", (face) => {
        const foot = faceNormalAt(face, point.value);
        if (!foot.isOk) return Result.err(foot.error);
        const box = face.boundingBox();
        const size = new XYZ(box.max).distanceTo(new XYZ(box.min));
        const length = Math.max(DEFAULT_AXIS_LENGTH / 5, size / 2);
        return Result.ok({
            point: foot.value.point,
            direction: foot.value.normal,
            span: { min: 0, max: length },
        });
    });
}

function pointPlaneLine(
    definition: Extract<AxisDefinition, { kind: "pointPlane" }>,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<AxisLine> {
    const point = resolvePoint(document, definition.point, definition.anchors, "Axis", visited);
    if (!point.isOk) return Result.err(point.error);
    const plane = resolvePlaneSourceInWorld(document, definition.plane, definition.anchors, {
        label: "Axis",
        visited,
    });
    if (!plane.isOk) return Result.err(plane.error);
    const direction = plane.value.normal.normalize();
    if (direction === undefined) return Result.err("Plane normal is degenerate");
    // The segment runs from the plane to the point (the foot is at t = -height).
    const height = point.value.sub(plane.value.origin).dot(direction);
    const span =
        Math.abs(height) < 1e-6 ? undefined : { min: Math.min(0, -height), max: Math.max(0, -height) };
    return Result.ok({ point: point.value, direction, span });
}

/** The world axis plus the drawn segment: the span widened by a margin, or a default length. */
function axisValue(line: AxisLine, flip: boolean): DatumAxisValue {
    const oriented = flip ? reversed(line) : line;
    const span = oriented.span ?? { min: -DEFAULT_AXIS_LENGTH / 2, max: DEFAULT_AXIS_LENGTH / 2 };
    const length = span.max - span.min;
    const margin = Math.max(MIN_MARGIN, length * MARGIN_RATIO);
    const min = length < 1e-6 ? -DEFAULT_AXIS_LENGTH / 2 : span.min - margin;
    const max = length < 1e-6 ? DEFAULT_AXIS_LENGTH / 2 : span.max + margin;
    return {
        point: oriented.point,
        direction: oriented.direction,
        start: oriented.point.add(oriented.direction.multiply(min)),
        end: oriented.point.add(oriented.direction.multiply(max)),
    };
}

/** Every node an axis definition reads geometry from, for the node's change watches. */
export function axisDefinitionNodeIds(definition: AxisDefinition): Set<string> {
    const ids: (string | undefined)[] = [];
    switch (definition.kind) {
        case "faceAxis":
            ids.push(definition.face.nodeId);
            break;
        case "edge":
            ids.push(definition.edge.nodeId);
            break;
        case "twoPoints":
            ids.push(...definition.points.map((point) => point.nodeId));
            break;
        case "twoPlanes":
            ids.push(planeRefNodeId(definition.first), planeRefNodeId(definition.second));
            break;
        case "faceNormal":
            ids.push(definition.face.nodeId, definition.point.nodeId);
            break;
        case "pointPlane":
            ids.push(definition.point.nodeId, planeRefNodeId(definition.plane));
            break;
    }
    return new Set(ids.filter((id): id is string => id !== undefined));
}
