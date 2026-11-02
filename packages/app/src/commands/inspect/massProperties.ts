// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { BoundingBox, type IFace, type IShape, ShapeTypes, XYZ } from "@chili3d/core";

/** Densities in g/cm³ the mass dialog offers; PLA is the default (a printed part). */
export const DENSITY_PRESETS = {
    PLA: 1.24,
    PETG: 1.27,
    ABS: 1.04,
    aluminium: 2.7,
    steel: 7.85,
    brass: 8.5,
} as const;

export type DensityPreset = keyof typeof DENSITY_PRESETS;

export const DEFAULT_DENSITY = DENSITY_PRESETS.PLA;

/** What a closed triangle mesh encloses, read off signed tetrahedra against a reference point. */
export interface MeshMassData {
    /** Signed: positive when the triangles wind counter-clockwise seen from outside. */
    volume: number;
    area: number;
    /** Undefined when the mesh encloses no volume (an open sheet, a degenerate body). */
    centroid: XYZ | undefined;
}

/**
 * Volume, area and centroid of a triangle mesh. Each triangle spans a tetrahedron with a
 * reference point; their signed volumes sum to the enclosed volume and their volume-weighted
 * centroids to its centre — the reference point (the first vertex, to keep the products
 * small far from the origin) cancels out for a closed mesh.
 */
export function meshMassProperties(position: ArrayLike<number>, index: ArrayLike<number>): MeshMassData {
    const r = [position[0] ?? 0, position[1] ?? 0, position[2] ?? 0];
    let volume = 0;
    let area = 0;
    const moment = [0, 0, 0];
    for (let t = 0; t + 2 < index.length; t += 3) {
        const a = vertexAt(position, index[t], r);
        const b = vertexAt(position, index[t + 1], r);
        const c = vertexAt(position, index[t + 2], r);
        const cross = crossOf(sub(b, a), sub(c, a));
        area += Math.hypot(cross[0], cross[1], cross[2]) / 2;
        const v = dot(a, crossOf(b, c)) / 6;
        volume += v;
        for (let k = 0; k < 3; k++) moment[k] += (v * (a[k] + b[k] + c[k])) / 4;
    }
    const centroid =
        Math.abs(volume) > 1e-12
            ? new XYZ({
                  x: r[0] + moment[0] / volume,
                  y: r[1] + moment[1] / volume,
                  z: r[2] + moment[2] / volume,
              })
            : undefined;
    return { volume, area, centroid };
}

function vertexAt(position: ArrayLike<number>, i: number, r: number[]) {
    return [position[3 * i] - r[0], position[3 * i + 1] - r[1], position[3 * i + 2] - r[2]];
}

function sub(a: number[], b: number[]) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: number[], b: number[]) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function crossOf(a: number[], b: number[]) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** One body's mass properties, in millimetres; `mass` in grams. */
export interface BodyMassProperties {
    name: string;
    /** mm³; 0 for a body that encloses nothing (a face, a shell). */
    volume: number;
    /** mm² — the kernel's exact face areas. */
    area: number;
    box: BoundingBox;
    centroid: XYZ | undefined;
    /** g, at the density asked for. */
    mass: number;
}

/**
 * Mass properties of a shape already placed in world space. Volume and area come from the
 * kernel (exact on analytic surfaces); the kernel has no centre-of-mass query, so the centre
 * is the signed-tetrahedra centroid of its triangulation — exact for planar bodies and within
 * the mesh deflection otherwise. `density` is in g/cm³ (1 cm³ = 1000 mm³).
 */
export function bodyMassProperties(name: string, shape: IShape, density: number): BodyMassProperties {
    const volume = Math.abs(shape.volume());
    const area = (shape.findSubShapes(ShapeTypes.face) as IFace[]).reduce((sum, face) => {
        const value = face.area();
        face.dispose();
        return sum + value;
    }, 0);
    const faces = shape.mesh.faces;
    const centroid =
        volume > 1e-9 && faces ? meshMassProperties(faces.position, faces.index).centroid : undefined;
    return { name, volume, area, box: shape.boundingBox(), centroid, mass: (volume / 1000) * density };
}

/** The bodies taken together: volumes and masses add, the centre is volume-weighted. */
export function combineMassProperties(name: string, bodies: BodyMassProperties[]): BodyMassProperties {
    let volume = 0;
    let area = 0;
    let mass = 0;
    let box: BoundingBox | undefined;
    let weighted = XYZ.zero;
    let weight = 0;
    for (const body of bodies) {
        volume += body.volume;
        area += body.area;
        mass += body.mass;
        box = BoundingBox.combine(box, body.box);
        if (body.centroid) {
            weighted = weighted.add(body.centroid.multiply(body.mass || body.volume));
            weight += body.mass || body.volume;
        }
    }
    const centroid = weight > 0 ? weighted.multiply(1 / weight) : undefined;
    return { name, volume, area, mass, box: box ?? BoundingBox.zero, centroid };
}
