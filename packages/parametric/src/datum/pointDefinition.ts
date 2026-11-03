// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { CurveUtils, type IDocument, type IEdge, Result, XYZ, type XYZLike } from "@chili3d/core";
import { type NeutralPlaneRef, planeRefNodeId } from "../features/feature";
import type { EdgeSourceRef, PointRef } from "../plane/planeDefinition";
import { resolvePlaneSourceInWorld } from "../plane/planeSource";
import { type FaceSourceRef, resolvePoint, withEdge, withFace } from "../plane/sourceRefs";
import { type DatumDefinitionBase, threePlanePoint } from "./axisDefinition";
import { revolutionAxisOfFace } from "./surfaceGeometry";

/**
 * How a construction point is defined (Fusion's CONSTRUCT ▸ Point). References are captured
 * like a datum plane's, so the point follows its geometry when the model rebuilds.
 */
export type PointDefinition = (
    | { readonly kind: "vertex"; readonly point: PointRef }
    | {
          /** The centre of a circular/elliptical edge, or of a spherical/toroidal face. */
          readonly kind: "center";
          readonly edge?: EdgeSourceRef;
          readonly face?: FaceSourceRef;
      }
    | {
          /** Where an edge crosses a plane; a straight edge counts as its whole line. */
          readonly kind: "edgePlane";
          readonly edge: EdgeSourceRef;
          readonly plane: NeutralPlaneRef;
      }
    | {
          readonly kind: "threePlanes";
          readonly planes: readonly [NeutralPlaneRef, NeutralPlaneRef, NeutralPlaneRef];
      }
    | {
          /** A point along an edge at a fraction of its length, measured from its captured start. */
          readonly kind: "onEdge";
          readonly edge: EdgeSourceRef;
          /** 0 = the edge's start, 1 = its end. */
          readonly ratio: number;
          /**
           * The edge's start as captured, in the source's LOCAL frame: a rebuild that flips
           * the edge's parameterization still measures from the same physical end.
           */
          readonly start?: XYZLike;
      }
) &
    DatumDefinitionBase;

/** Resolves a definition against the document's current geometry, in WORLD coordinates. */
export function resolvePointDefinition(
    definition: PointDefinition,
    document: IDocument,
    visited?: ReadonlySet<string>,
): Result<XYZ> {
    try {
        return resolve(definition, document, visited);
    } catch (error) {
        return Result.err(`Point definition could not be resolved: ${String(error)}`);
    }
}

function resolve(definition: PointDefinition, document: IDocument, visited: ReadonlySet<string> | undefined) {
    const anchors = definition.anchors;
    switch (definition.kind) {
        case "vertex":
            return resolvePoint(document, definition.point, anchors, "Point", visited);
        case "center":
            return centerPoint(definition, document, visited);
        case "edgePlane":
            return edgePlanePoint(definition, document, visited);
        case "threePlanes":
            return threePlanesPoint(definition, document, visited);
        case "onEdge":
            return onEdgePoint(definition, document, visited);
        default:
            return Result.err(`Unknown point definition: ${String((definition as { kind?: string }).kind)}`);
    }
}

function centerPoint(
    definition: Extract<PointDefinition, { kind: "center" }>,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<XYZ> {
    if (definition.edge !== undefined) {
        return withEdge(
            document,
            definition.edge,
            definition.anchors,
            "Point",
            (edge) => {
                const basis = edge.curve.basisCurve;
                const center = CurveUtils.isConic(basis) ? (basis as { center?: XYZ }).center : undefined;
                return center === undefined
                    ? Result.err("Centre point requires a circular or elliptical edge")
                    : Result.ok(new XYZ(center));
            },
            visited,
        );
    }
    if (definition.face !== undefined) {
        return withFace(document, definition.face, definition.anchors, "Point", (face) => {
            const axis = revolutionAxisOfFace(face);
            if (!axis.isOk || (axis.value.kind !== "sphere" && axis.value.kind !== "torus")) {
                return Result.err("Centre point requires a spherical or toroidal face");
            }
            return Result.ok(axis.value.point);
        });
    }
    return Result.err("Centre point has no reference");
}

function edgePlanePoint(
    definition: Extract<PointDefinition, { kind: "edgePlane" }>,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<XYZ> {
    const plane = resolvePlaneSourceInWorld(document, definition.plane, definition.anchors, {
        label: "Point",
        visited,
    });
    if (!plane.isOk) return Result.err(plane.error);
    const near = definition.anchor === undefined ? undefined : new XYZ(definition.anchor);
    return withEdge(
        document,
        definition.edge,
        definition.anchors,
        "Point",
        (edge) => edgePlaneCrossing(edge, plane.value.origin, plane.value.normal, near),
        visited,
    );
}

/**
 * Where `edge` crosses the plane: analytic for a straight edge (taken as its whole line, the
 * way Fusion extends it), sampled-and-bisected along any other curve. Several crossings pick
 * the one nearest `near` (the pick), else the first along the edge.
 */
export function edgePlaneCrossing(edge: IEdge, origin: XYZ, normal: XYZ, near: XYZ | undefined): Result<XYZ> {
    const n = normal.normalize();
    if (n === undefined) return Result.err("Plane normal is degenerate");
    const height = (point: XYZ) => point.sub(origin).dot(n);
    if (CurveUtils.isLine(edge.curve.basisCurve)) {
        const start = edge.startPoint();
        const direction = edge.endPoint().sub(start);
        const rate = direction.dot(n);
        if (Math.abs(rate) < 1e-12) return Result.err("The edge is parallel to the plane");
        return Result.ok(start.add(direction.multiply(-height(start) / rate)));
    }
    const crossings = sampledCrossings(edge, height);
    if (crossings.length === 0) return Result.err("The edge does not cross the plane");
    if (near === undefined) return Result.ok(crossings[0]);
    return Result.ok(crossings.reduce((best, p) => (p.distanceTo(near) < best.distanceTo(near) ? p : best)));
}

const CROSSING_SAMPLES = 64;

function sampledCrossings(edge: IEdge, height: (point: XYZ) => number): XYZ[] {
    const first = edge.firstParameter();
    const last = edge.lastParameter();
    const at = (t: number) => edge.pointAt(t);
    const found: XYZ[] = [];
    let t0 = first;
    let h0 = height(at(t0));
    for (let i = 1; i <= CROSSING_SAMPLES; i++) {
        const t1 = first + ((last - first) * i) / CROSSING_SAMPLES;
        const h1 = height(at(t1));
        if (Math.abs(h0) < 1e-9) found.push(at(t0));
        else if (h0 * h1 < 0) found.push(at(bisect(at, height, t0, t1, h0)));
        t0 = t1;
        h0 = h1;
    }
    if (Math.abs(h0) < 1e-9) found.push(at(t0));
    return found;
}

function bisect(
    at: (t: number) => XYZ,
    height: (p: XYZ) => number,
    a: number,
    b: number,
    ha: number,
): number {
    let lo = a;
    let hi = b;
    let hLo = ha;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        const hMid = height(at(mid));
        if (Math.abs(hMid) < 1e-12) return mid;
        if (hLo * hMid < 0) hi = mid;
        else {
            lo = mid;
            hLo = hMid;
        }
    }
    return (lo + hi) / 2;
}

function threePlanesPoint(
    definition: Extract<PointDefinition, { kind: "threePlanes" }>,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<XYZ> {
    const rows: [XYZ, number][] = [];
    for (const ref of definition.planes) {
        const plane = resolvePlaneSourceInWorld(document, ref, definition.anchors, {
            label: "Point",
            visited,
        });
        if (!plane.isOk) return Result.err(plane.error);
        rows.push([plane.value.normal, plane.value.normal.dot(plane.value.origin)]);
    }
    const point = threePlanePoint(rows[0], rows[1], rows[2]);
    return point === undefined ? Result.err("The three planes do not meet in one point") : Result.ok(point);
}

function onEdgePoint(
    definition: Extract<PointDefinition, { kind: "onEdge" }>,
    document: IDocument,
    visited: ReadonlySet<string> | undefined,
): Result<XYZ> {
    if (!Number.isFinite(definition.ratio)) return Result.err("Point ratio is not a finite number");
    return withEdge(
        document,
        definition.edge,
        definition.anchors,
        "Point",
        (edge, transform) => {
            const captured =
                definition.start === undefined ? undefined : transform.ofPoint(new XYZ(definition.start));
            const flipped =
                captured !== undefined &&
                edge.endPoint().distanceTo(captured) < edge.startPoint().distanceTo(captured);
            const ratio = flipped ? 1 - definition.ratio : definition.ratio;
            return Result.ok(pointAtLengthRatio(edge, ratio));
        },
        visited,
    );
}

const LENGTH_SAMPLES = 128;

/**
 * The point at `ratio` of the edge's arc length. A ratio outside [0, 1] is clamped. The
 * length is integrated off a fine chord polyline, then interpolated in parameter space —
 * exact for a line or circle, whose speed is constant.
 */
export function pointAtLengthRatio(edge: IEdge, ratio: number): XYZ {
    const clamped = Math.min(1, Math.max(0, ratio));
    const first = edge.firstParameter();
    const last = edge.lastParameter();
    const params: number[] = [];
    const lengths: number[] = [0];
    let previous = edge.pointAt(first);
    params.push(first);
    for (let i = 1; i <= LENGTH_SAMPLES; i++) {
        const t = first + ((last - first) * i) / LENGTH_SAMPLES;
        const point = edge.pointAt(t);
        lengths.push(lengths[i - 1] + point.distanceTo(previous));
        params.push(t);
        previous = point;
    }
    const target = clamped * lengths[LENGTH_SAMPLES];
    for (let i = 1; i <= LENGTH_SAMPLES; i++) {
        if (lengths[i] < target && i < LENGTH_SAMPLES) continue;
        const piece = lengths[i] - lengths[i - 1];
        const f = piece < 1e-15 ? 0 : (target - lengths[i - 1]) / piece;
        return edge.pointAt(params[i - 1] + (params[i] - params[i - 1]) * f);
    }
    return edge.pointAt(last);
}

/** Every node a point definition reads geometry from, for the node's change watches. */
export function pointDefinitionNodeIds(definition: PointDefinition): Set<string> {
    const ids: (string | undefined)[] = [];
    switch (definition.kind) {
        case "vertex":
            ids.push(definition.point.nodeId);
            break;
        case "center":
            ids.push(definition.edge?.nodeId, definition.face?.nodeId);
            break;
        case "edgePlane":
            ids.push(definition.edge.nodeId, planeRefNodeId(definition.plane));
            break;
        case "threePlanes":
            ids.push(...definition.planes.map(planeRefNodeId));
            break;
        case "onEdge":
            ids.push(definition.edge.nodeId);
            break;
    }
    return new Set(ids.filter((id): id is string => id !== undefined));
}
