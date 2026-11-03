// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    type IEdge,
    type IFace,
    type IShape,
    Matrix4,
    Result,
    ShapeTypes,
    type XYZ,
} from "@chili3d/core";
import { isDatumAxisNode, isDatumPointNode } from "../datum/datumContract";
import { matchEdgeIndexes, matchEdgesAnchored } from "../features/edgeMatcher";
import { captureProfileRef, captureRegionFingerprint, type ProfileRef } from "../features/profileRef";
import { distance } from "../features/refGeometry";
import { matchSourceFaceIndexes } from "../features/sourceFaceMatcher";
import { matchVertex } from "../features/vertexRef";
import { shapeSourceOf } from "../sketch/shapeSource";
import {
    ROLLED_BACK_SOURCE,
    resolveTimelineSource,
    SOURCE_UNAVAILABLE,
    type TimelineSource,
} from "../sketch/sourceTimeline";
import type { EdgeSourceRef, PointRef, VertexAnchor } from "./planeDefinition";

/**
 * Re-finding the vertices, edges and faces a construction definition (a datum plane, axis or
 * point) was built from, on the source node's current geometry at its captured timeline anchor.
 *
 * A ref may also name another datum node: a datum POINT stands in for a vertex and a datum
 * AXIS for a straight edge. Those resolve through the node's own definition rather than a
 * fingerprint match — the datum moves when its definition re-resolves, and a fingerprint
 * captured on its old position would never match again.
 */

/** The feature-list index each parametric source was captured at (see `PlaneDefinitionBase.anchors`). */
export type SourceAnchors = Readonly<Record<string, number>> | undefined;

/**
 * A face a construction definition reads its surface from (a cylinder's axis, a tangent
 * plane's surface): the source-face fingerprint press-pull uses, in the node's LOCAL frame.
 */
export interface FaceSourceRef {
    readonly nodeId: string;
    readonly face: ProfileRef;
}

/**
 * A face as a `FaceSourceRef`'s fingerprint. A face bounded by a degenerate edge (a sphere's
 * poles, a cone's apex) has no edge fingerprint to take; it is named by its tracked id and its
 * region (centre + area) alone, which is what the matcher falls back to anyway.
 */
export function captureFaceSource(face: IFace, faceId?: string, splitPiece?: boolean): ProfileRef {
    try {
        return captureProfileRef(face, faceId, splitPiece);
    } catch {
        return { edges: [], id: faceId, splitPiece, ...captureRegionFingerprint(face) };
    }
}

export interface ResolvedSourceShape {
    /** The source node's own shape; every stored point/edge ref lives in this frame. */
    readonly local: IShape;
    /** The source node's world placement, applied only after a ref has been matched. */
    readonly transform: Matrix4;
    readonly edgeIds?: readonly (string | undefined)[];
    readonly faceIds?: readonly (string | undefined)[];
}

/**
 * The world-space shape of `nodeId`, read at `anchor` when the node is a parametric body.
 * A transformed copy is owned by the caller and disposed after use.
 */
export function resolveSourceShape(
    document: IDocument,
    nodeId: string,
    anchors: SourceAnchors,
    label: string,
): Result<ResolvedSourceShape> {
    try {
        const source = resolveTimelineSource(document, nodeId, anchors?.[nodeId]);
        if (source === ROLLED_BACK_SOURCE) return Result.err(`${label} source is rolled back`);
        if (source === SOURCE_UNAVAILABLE) return Result.err(`${label} source not found`);
        const base = shapeSourceOf(document, source.node, source.shape);
        return Result.ok({
            local: base.shape,
            transform: base.transform,
            edgeIds: edgeIdsOf(source),
            faceIds: faceIdsOf(source),
        });
    } catch (error) {
        return Result.err(`${label} source could not be read: ${String(error)}`);
    }
}

function edgeIdsOf(source: TimelineSource): readonly (string | undefined)[] | undefined {
    if (source.standIn) return source.edgeIds;
    const tracking = source.node as unknown as { edgeIdAt?: (index: number) => string | undefined };
    if (tracking.edgeIdAt === undefined) return undefined;
    const edgeIdAt = tracking.edgeIdAt.bind(tracking);
    const edges = source.shape.findSubShapes(ShapeTypes.edge) as IEdge[];
    return edges.map((_, index) => edgeIdAt(index));
}

function faceIdsOf(source: TimelineSource): readonly (string | undefined)[] | undefined {
    if (source.standIn) return source.faceIds;
    const tracking = source.node as unknown as { faceIdAt?: (index: number) => string | undefined };
    if (tracking.faceIdAt === undefined) return undefined;
    const faceIdAt = tracking.faceIdAt.bind(tracking);
    const faces = source.shape.findSubShapes(ShapeTypes.face) as IFace[];
    return faces.map((_, index) => faceIdAt(index));
}

function findNode(document: IDocument, nodeId: string) {
    return document.modelManager.findNode((candidate) => candidate.id === nodeId);
}

/**
 * The world point a `PointRef` names. `visited` is the datum resolution stack — a datum point
 * that (indirectly) names itself reports an error instead of recursing.
 */
export function resolvePoint(
    document: IDocument,
    ref: PointRef,
    anchors: SourceAnchors,
    label: string,
    visited?: ReadonlySet<string>,
): Result<XYZ> {
    const datum = findNode(document, ref.nodeId);
    if (isDatumPointNode(datum)) {
        if (visited?.has(datum.id) === true) return Result.err(`${label} point reference is cyclic`);
        const point = datum.worldPoint(visited);
        return point === undefined
            ? Result.err(`${label} point reference is not available`)
            : Result.ok(point);
    }
    const source = resolveSourceShape(document, ref.nodeId, anchors, label);
    if (!source.isOk) return Result.err(source.error);
    try {
        // Topology first: an incident edge's tracked id names the vertex across upstream
        // parameter edits. The positional match is the fallback for an edge-less vertex
        // (or a lost edge) and for documents saved before the incidence was captured.
        const anchored = resolveIncidentPoint(source.value, ref.incident);
        if (anchored !== undefined) return Result.ok(source.value.transform.ofPoint(anchored));
        const vertex = matchVertex(source.value.local, ref.vertex);
        return vertex === undefined
            ? Result.err(`${label} point not found after rebuild`)
            : Result.ok(source.value.transform.ofPoint(vertex.point()));
    } catch (error) {
        return Result.err(`${label} point could not be read: ${String(error)}`);
    }
}

/**
 * A datum axis as a temporary world edge, so every edge consumer reads it like a straight
 * edge of a body. Undefined when `nodeId` is not a datum axis; an error when it is one that
 * cannot resolve.
 */
function datumAxisEdge(
    document: IDocument,
    nodeId: string,
    label: string,
    visited: ReadonlySet<string> | undefined,
): Result<IEdge> | undefined {
    const datum = findNode(document, nodeId);
    if (!isDatumAxisNode(datum)) return undefined;
    if (visited?.has(datum.id) === true) return Result.err(`${label} axis reference is cyclic`);
    const axis = datum.worldAxis(visited);
    if (axis === undefined) return Result.err(`${label} axis reference is not available`);
    const edge = shapeFactory.line(axis.start, axis.end);
    return edge.isOk ? Result.ok(edge.value) : Result.err(edge.error);
}

export function withEdge<T>(
    document: IDocument,
    ref: EdgeSourceRef,
    anchors: SourceAnchors,
    label: string,
    use: (edge: IEdge, transform: Matrix4) => Result<T>,
    visited?: ReadonlySet<string>,
): Result<T> {
    const datum = datumAxisEdge(document, ref.nodeId, label, visited);
    if (datum !== undefined) return withOwnedEdge(datum, label, (edge) => use(edge, Matrix4.identity()));
    const source = resolveSourceShape(document, ref.nodeId, anchors, label);
    if (!source.isOk) return Result.err(source.error);
    try {
        // The ref lives in the source's LOCAL frame, so a moved source still matches by
        // id/fingerprint; only the matched edge is carried into world coordinates.
        const indexes = matchEdgeIndexesIn(source.value.local, source.value.edgeIds, ref);
        if (!indexes.isOk) return Result.err(`${label} edge not found after rebuild`);
        const edges = source.value.local.findSubShapes(ShapeTypes.edge) as IEdge[];
        const worldEdge = worldEdgeOf(edges[indexes.value[0]], source.value.transform);
        try {
            return use(worldEdge, source.value.transform);
        } catch (error) {
            return Result.err(`${label} edge could not be read: ${String(error)}`);
        } finally {
            if (worldEdge !== edges[indexes.value[0]]) worldEdge.dispose();
        }
    } catch (error) {
        return Result.err(`${label} edge could not be read: ${String(error)}`);
    }
}

function withOwnedEdge<T>(edge: Result<IEdge>, label: string, use: (edge: IEdge) => Result<T>): Result<T> {
    if (!edge.isOk) return Result.err(edge.error);
    try {
        return use(edge.value);
    } catch (error) {
        return Result.err(`${label} edge could not be read: ${String(error)}`);
    } finally {
        edge.value.dispose();
    }
}

/** The source's edge in world coordinates (itself when the source sits at identity). */
function worldEdgeOf(edge: IEdge, transform: Matrix4): IEdge {
    return transform.equals(Matrix4.identity()) ? edge : (edge.transformedMul(transform) as IEdge);
}

/**
 * A curve ref may have been split into several pieces sharing one tracked id. The caller
 * that needs a point on the curve (curve-point) must search ALL of them; taking the first
 * would measure against a piece the picked point is not on.
 */
export function withNearestCurve<T>(
    document: IDocument,
    ref: EdgeSourceRef,
    anchors: SourceAnchors,
    point: XYZ,
    label: string,
    use: (edge: IEdge) => Result<T>,
    visited?: ReadonlySet<string>,
): Result<T> {
    const datum = datumAxisEdge(document, ref.nodeId, label, visited);
    if (datum !== undefined) return withOwnedEdge(datum, label, use);
    const source = resolveSourceShape(document, ref.nodeId, anchors, label);
    if (!source.isOk) return Result.err(source.error);
    const owned: IEdge[] = [];
    try {
        const indexes = matchEdgeIndexesIn(source.value.local, source.value.edgeIds, ref);
        if (!indexes.isOk) return Result.err(`${label} curve not found after rebuild`);
        const edges = source.value.local.findSubShapes(ShapeTypes.edge) as IEdge[];
        let nearest: { edge: IEdge; distance: number } | undefined;
        for (const index of indexes.value) {
            const edge = worldEdgeOf(edges[index], source.value.transform);
            if (edge !== edges[index]) owned.push(edge);
            const candidate = edge.curve.nearestFromPoint(point);
            if (nearest === undefined || candidate.distance < nearest.distance) {
                nearest = { edge, distance: candidate.distance };
            }
        }
        if (nearest === undefined) return Result.err(`${label} curve not found after rebuild`);
        return use(nearest.edge);
    } catch (error) {
        return Result.err(`${label} curve could not be read: ${String(error)}`);
    } finally {
        for (const edge of owned) edge.dispose();
    }
}

/**
 * The face a `FaceSourceRef` names, in WORLD coordinates: the tracked face id first, the
 * geometric fingerprint second (`matchSourceFaceIndexes`, the press-pull contract). `use`
 * also gets the source's world transform, for any extra point stored in the LOCAL frame.
 */
export function withFace<T>(
    document: IDocument,
    ref: FaceSourceRef,
    anchors: SourceAnchors,
    label: string,
    use: (face: IFace, transform: Matrix4) => Result<T>,
): Result<T> {
    const source = resolveSourceShape(document, ref.nodeId, anchors, label);
    if (!source.isOk) return Result.err(source.error);
    try {
        const faces = source.value.local.findSubShapes(ShapeTypes.face) as IFace[];
        const matched = matchSourceFaceIndexes(faces, source.value.faceIds, [ref.face]);
        if (!matched.isOk || matched.value.indexes.length === 0) {
            return Result.err(`${label} face not found after rebuild`);
        }
        const local = faces[matched.value.indexes[0]];
        const transform = source.value.transform;
        const identity = transform.equals(Matrix4.identity());
        const world = identity ? local : (local.transformedMul(transform) as IFace);
        try {
            return use(world, transform);
        } finally {
            if (!identity) world.dispose();
        }
    } catch (error) {
        return Result.err(`${label} face could not be read: ${String(error)}`);
    }
}

/** Edge matching inside one shape: tracked ids first, the geometric fingerprint second. */
function matchEdgeIndexesIn(
    shape: IShape,
    edgeIds: readonly (string | undefined)[] | undefined,
    ref: EdgeSourceRef,
): Result<number[]> {
    if (edgeIds !== undefined) {
        const anchored = matchEdgesAnchored(shape, [ref.edge], edgeIds);
        if (anchored.isOk) return Result.ok(anchored.value.indexes);
    }
    const matched = matchEdgeIndexes(shape, [ref.edge]);
    return matched.isOk ? Result.ok(matched.value) : Result.err(matched.error);
}

/**
 * The vertex named by an incident edge. The stored endpoints decide which physical end
 * is the vertex even when a rebuild flipped the edge's parameterization; a split edge's
 * pieces are searched for the endpoint nearest the captured one.
 */
function resolveIncidentPoint(
    source: ResolvedSourceShape,
    incident: readonly VertexAnchor[] | undefined,
): XYZ | undefined {
    if (incident === undefined) return undefined;
    const edges = source.local.findSubShapes(ShapeTypes.edge) as IEdge[];
    for (const anchor of incident) {
        const indexes = matchEdgeIndexesIn(source.local, source.edgeIds, { nodeId: "", edge: anchor.edge });
        if (!indexes.isOk || indexes.value.length === 0) continue;
        if (indexes.value.length === 1) {
            return endpointNear(edges[indexes.value[0]], anchor);
        }
        const captured = anchor.ends[anchor.end];
        let best: XYZ | undefined;
        let bestDistance = Infinity;
        for (const index of indexes.value) {
            for (const point of [edges[index].startPoint(), edges[index].endPoint()]) {
                const candidate = distance(point, captured);
                if (candidate < bestDistance) {
                    best = point;
                    bestDistance = candidate;
                }
            }
        }
        if (best !== undefined) return best;
    }
    return undefined;
}

function endpointNear(edge: IEdge, anchor: VertexAnchor): XYZ {
    const start = edge.startPoint();
    const end = edge.endPoint();
    const [capturedStart, capturedEnd] = anchor.ends;
    const direct = distance(start, capturedStart) + distance(end, capturedEnd);
    const flipped = distance(start, capturedEnd) + distance(end, capturedStart);
    const chosen = direct <= flipped ? anchor.end : anchor.end === 0 ? 1 : 0;
    return chosen === 0 ? start : end;
}
