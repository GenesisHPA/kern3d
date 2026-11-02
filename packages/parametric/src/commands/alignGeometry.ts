// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    BoundingBox,
    CurveUtils,
    type IEdge,
    type IFace,
    type IShape,
    type ISurface,
    type IVertex,
    Matrix4,
    Result,
    ShapeTypes,
    XYZ,
} from "@chili3d/core";

/**
 * What a picked piece of geometry means to an Align, in WORLD coordinates.
 *
 * - `plane`: a planar face (its outward normal, `oriented`) or a circular edge (the circle's
 *   axis, whose sign is arbitrary, so not `oriented`). `point` is the keypoint on it — the
 *   face centre / the picked point, or the circle's centre.
 * - `line`: a straight edge or a cylindrical face's axis; `direction` is unit, its sign arbitrary.
 * - `point`: a vertex, or any other geometry reduced to a point.
 */
export type AlignFrame =
    | { readonly kind: "plane"; readonly point: XYZ; readonly normal: XYZ; readonly oriented: boolean }
    | { readonly kind: "line"; readonly point: XYZ; readonly direction: XYZ }
    | { readonly kind: "point"; readonly point: XYZ };

/** One pick: the sub-shape in its owner's local space, the transform to world, the hit point (world). */
export interface AlignPick {
    readonly shape: IShape;
    readonly transform: Matrix4;
    readonly point?: XYZ;
}

export interface AlignOptions {
    /** Turn the source the other way round: normals the same way for faces, reversed for lines. */
    readonly flip: boolean;
    /** Extra rotation about the aligned normal / line, in radians. */
    readonly angle: number;
}

/**
 * The frame a pick aligns by. `snapToCenter` puts a planar face's keypoint at its centre (the
 * centre of its bounding box, projected onto the face's plane) and a cylinder's at mid-height
 * of its axis; otherwise the clicked point is used, projected onto the plane / axis.
 */
export function alignFrameOf(pick: AlignPick, snapToCenter: boolean): Result<AlignFrame> {
    switch (pick.shape.shapeType) {
        case ShapeTypes.vertex: {
            const point = pick.transform.ofPoint((pick.shape as IVertex).point());
            return Result.ok({ kind: "point", point });
        }
        case ShapeTypes.edge:
            return Result.ok(edgeFrame(pick.shape as IEdge, pick.transform, pick.point));
        case ShapeTypes.face:
            return faceFrame(pick.shape as IFace, pick.transform, pick.point, snapToCenter);
        default:
            return Result.err("Pick a face, an edge or a vertex");
    }
}

function edgeFrame(edge: IEdge, transform: Matrix4, hit: XYZ | undefined): AlignFrame {
    // The edge caches its curve (and the curve its basis) and frees them with itself.
    const basis = edge.curve.basisCurve;
    if (CurveUtils.isCircle(basis)) {
        return {
            kind: "plane",
            point: transform.ofPoint(basis.center),
            normal: worldDirection(transform, basis.axis),
            oriented: false,
        };
    }
    const [start, end] = edge.ends().map((p) => transform.ofPoint(p));
    const middle = transform.ofPoint(edge.pointAt((edge.firstParameter() + edge.lastParameter()) / 2));
    const point = hit === undefined ? middle : nearest(hit, [start, middle, end]);
    if (CurveUtils.isLine(basis)) {
        const direction = end.sub(start).normalize();
        if (direction !== undefined) return { kind: "line", point, direction };
    }
    return { kind: "point", point };
}

function faceFrame(
    face: IFace,
    transform: Matrix4,
    hit: XYZ | undefined,
    snapToCenter: boolean,
): Result<AlignFrame> {
    const surface = unwrapSurface(face.surface());
    try {
        if (surface.isPlanar()) {
            const [localPoint, localNormal] = face.normal(0, 0);
            const point = transform.ofPoint(localPoint);
            const normal = worldDirection(transform, localNormal);
            const anchor = snapToCenter || hit === undefined ? faceCenter(face, transform) : hit;
            const projected = anchor.sub(normal.multiply(normal.dot(anchor.sub(point))));
            return Result.ok({ kind: "plane", point: projected, normal, oriented: true });
        }
        if (isCylinder(surface)) {
            const origin = transform.ofPoint(surface.location);
            const direction = worldDirection(transform, surface.axis);
            const anchor = snapToCenter || hit === undefined ? faceCenter(face, transform) : hit;
            const point = origin.add(direction.multiply(direction.dot(anchor.sub(origin))));
            return Result.ok({ kind: "line", point, direction });
        }
        return Result.err("Only planar and cylindrical faces can be aligned");
    } finally {
        surface.dispose();
    }
}

/** A trimmed surface wraps the one whose type matters; the wrapper is disposed here. */
function unwrapSurface(surface: ISurface): ISurface {
    const trimmed = surface as ISurface & { basisSurface?: () => ISurface };
    if (typeof trimmed.basisSurface !== "function") return surface;
    const basis = trimmed.basisSurface();
    surface.dispose();
    return basis;
}

interface CylinderLike extends ISurface {
    readonly location: XYZ;
    readonly axis: XYZ;
    readonly radius: number;
}

/**
 * Core exposes no surface-type tag, so a cylinder is recognised by shape: an elementary
 * surface with a radius that is neither a cone (`semiAngle`) nor a sphere (`volume`).
 */
function isCylinder(surface: ISurface): surface is CylinderLike {
    const candidate = surface as Partial<CylinderLike> & { semiAngle?: number; volume?: unknown };
    return (
        typeof candidate.radius === "number" &&
        candidate.axis !== undefined &&
        candidate.semiAngle === undefined &&
        candidate.volume === undefined
    );
}

function faceCenter(face: IFace, transform: Matrix4): XYZ {
    return transform.ofPoint(BoundingBox.center(face.boundingBox()));
}

function worldDirection(transform: Matrix4, local: XYZ): XYZ {
    return transform.ofVector(local).normalize() ?? local;
}

function nearest(target: XYZ, candidates: XYZ[]): XYZ {
    let best = candidates[0];
    for (const candidate of candidates) {
        if (candidate.distanceTo(target) < best.distanceTo(target)) best = candidate;
    }
    return best;
}

/** The world-space move that brings `source` onto `target`. */
export function alignmentMatrix(source: AlignFrame, target: AlignFrame, options: AlignOptions): Matrix4 {
    let rotation = Matrix4.identity();
    let spinAxis: XYZ | undefined;
    if (source.kind === "plane" && target.kind === "plane") {
        // Two face normals are outward: flush means opposite. A circle's axis has no
        // meaningful sign, so it turns the shorter way instead.
        const flush = source.oriented && target.oriented;
        let wanted = flush ? target.normal.reverse() : sameSense(source.normal, target.normal);
        if (options.flip) wanted = wanted.reverse();
        rotation = rotationBetween(source.normal, wanted, source.point);
        spinAxis = target.normal;
    } else if (source.kind === "line" && target.kind === "line") {
        let wanted = sameSense(source.direction, target.direction);
        if (options.flip) wanted = wanted.reverse();
        rotation = rotationBetween(source.direction, wanted, source.point);
        spinAxis = target.direction;
    }
    const delta = target.point.sub(source.point);
    let result = rotation.multiply(Matrix4.fromTranslation(delta.x, delta.y, delta.z));
    if (spinAxis !== undefined && Math.abs(options.angle) > 1e-12) {
        result = result.multiply(Matrix4.fromAxisRad(target.point, spinAxis, options.angle));
    }
    return result;
}

/** `to` or its reverse, whichever is closer to `from`. */
function sameSense(from: XYZ, to: XYZ): XYZ {
    return from.dot(to) >= 0 ? to : to.reverse();
}

/**
 * The shortest rotation taking unit `from` onto unit `to`, about an axis through `pivot`.
 * Opposite vectors turn half a turn about any axis perpendicular to `from`.
 */
export function rotationBetween(from: XYZ, to: XYZ, pivot: XYZ): Matrix4 {
    const dot = Math.min(1, Math.max(-1, from.dot(to)));
    if (dot > 1 - 1e-12) return Matrix4.identity();
    let axis = from.cross(to).normalize();
    if (axis === undefined || dot < -1 + 1e-12) axis = perpendicular(from);
    return Matrix4.fromAxisRad(pivot, axis, Math.acos(dot));
}

function perpendicular(vector: XYZ): XYZ {
    const helper = Math.abs(vector.x) < 0.9 ? XYZ.unitX : XYZ.unitY;
    return vector.cross(helper).normalize()!;
}
