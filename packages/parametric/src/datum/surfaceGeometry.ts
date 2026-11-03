// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IEdge,
    type IFace,
    type IShape,
    type ISurface,
    Result,
    ShapeTypes,
    type XYZ,
} from "@chili3d/core";

/** The kinds of surface that have an axis of their own (what a "through face axis" accepts). */
export type RevolutionKind = "cylinder" | "cone" | "sphere" | "torus" | "revolution";

export interface RevolutionAxis {
    readonly kind: RevolutionKind;
    /** A point on the axis — the surface's location (a sphere's/torus's centre). */
    readonly point: XYZ;
    readonly direction: XYZ;
}

/**
 * Which revolution surface `surface` is, read structurally — `ISurface` carries no type tag
 * and parametric must not import the wasm classes. The checks follow the members each
 * interface adds (`threadGeometry.ts` reads a cylinder the same way).
 */
function classify(surface: ISurface): RevolutionAxis | undefined {
    const candidate = surface as unknown as Partial<
        Record<
            | "referencePlane"
            | "direction"
            | "plane"
            | "axis"
            | "location"
            | "semiAngle"
            | "majorRadius"
            | "radius"
            | "area",
            unknown
        >
    >;
    if (typeof candidate.referencePlane === "function" && typeof candidate.direction === "function") {
        const revolution = surface as unknown as { location: XYZ; direction(): XYZ };
        return { kind: "revolution", point: revolution.location, direction: revolution.direction() };
    }
    if (candidate.plane !== undefined) return undefined;
    if (candidate.axis === undefined || candidate.location === undefined) return undefined;
    const elementary = surface as unknown as { axis: XYZ; location: XYZ };
    const frame = { point: elementary.location, direction: elementary.axis };
    if (candidate.semiAngle !== undefined) return { kind: "cone", ...frame };
    if (candidate.majorRadius !== undefined) return { kind: "torus", ...frame };
    if (typeof candidate.radius === "number" && candidate.area !== undefined)
        return { kind: "sphere", ...frame };
    if (typeof candidate.radius === "number") return { kind: "cylinder", ...frame };
    return undefined;
}

/** A trimmed surface's basis, unwrapped once (a face's surface is often one). */
function revolutionOf(surface: ISurface): RevolutionAxis | undefined {
    const direct = classify(surface);
    if (direct !== undefined) return direct;
    const trimmed = surface as Partial<{ basisSurface(): ISurface }>;
    if (typeof trimmed.basisSurface !== "function") return undefined;
    const basis = trimmed.basisSurface();
    try {
        return classify(basis);
    } finally {
        basis.dispose();
    }
}

/** The axis of a cylindrical, conical, spherical, toroidal or revolved face. */
export function revolutionAxisOfFace(face: IFace): Result<RevolutionAxis> {
    const surface = face.surface();
    try {
        const axis = revolutionOf(surface);
        const direction = axis?.direction.normalize();
        if (axis === undefined || direction === undefined) {
            return Result.err("The face has no axis (pick a cylinder, cone, sphere or torus)");
        }
        return Result.ok({ ...axis, direction });
    } finally {
        surface.dispose();
    }
}

/** Whether `shape` is a face with an axis — the pick filter of the axis/tangent commands. */
export function isRevolutionFace(shape: IShape): boolean {
    if (shape.shapeType !== ShapeTypes.face) return false;
    try {
        return revolutionAxisOfFace(shape as IFace).isOk;
    } catch {
        return false;
    }
}

/**
 * The face's foot of `point` and the face's (orientation-aware) normal there. The point is
 * projected onto the surface first, so a click a hair off the face still lands on it.
 */
export function faceNormalAt(face: IFace, point: XYZ): Result<{ point: XYZ; normal: XYZ }> {
    const surface = face.surface();
    try {
        const nearest = surface.nearestPoint(point);
        if (nearest === undefined) return Result.err("The point cannot be projected onto the face");
        const uv = surface.parameter(nearest[0], 1e-3);
        if (uv === undefined) return Result.err("The point cannot be projected onto the face");
        const [foot, normal] = face.normal(uv.u, uv.v);
        const unit = normal.normalize();
        if (unit === undefined) return Result.err("The face normal is degenerate there");
        return Result.ok({ point: foot, normal: unit });
    } finally {
        surface.dispose();
    }
}

/**
 * The extent of `shape` along the line `origin + t·direction`, sampled off its edges — what a
 * datum axis's drawn segment is fitted to. Undefined when the shape has no edges.
 */
export function spanAlong(
    shape: IShape,
    origin: XYZ,
    direction: XYZ,
): { min: number; max: number } | undefined {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const edge of shape.findSubShapes(ShapeTypes.edge) as IEdge[]) {
        try {
            const first = edge.firstParameter();
            const last = edge.lastParameter();
            for (let i = 0; i <= 8; i++) {
                const t = edge
                    .pointAt(first + ((last - first) * i) / 8)
                    .sub(origin)
                    .dot(direction);
                min = Math.min(min, t);
                max = Math.max(max, t);
            }
        } catch {
            // A degenerate edge (a cone's apex) has nothing to contribute.
        }
    }
    return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : undefined;
}

/** `point` rotated about the axis through `origin` along unit `direction` by `radians`. */
export function rotateAbout(point: XYZ, origin: XYZ, direction: XYZ, radians: number): XYZ {
    const relative = point.sub(origin);
    const rotated = relative.rotate(direction, radians);
    return rotated === undefined ? point : origin.add(rotated);
}

/** The component of `vector` perpendicular to unit `axis`. */
export function perpendicularTo(vector: XYZ, axis: XYZ): XYZ {
    return vector.sub(axis.multiply(vector.dot(axis)));
}
