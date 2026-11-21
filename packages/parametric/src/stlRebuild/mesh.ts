// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Plain-array geometry for rebuilding an STL as features: a welded triangle mesh and the small
 * vector helpers the analysis runs on. No kernel objects here — the analysis is pure arithmetic,
 * so it runs (and is tested) on any triangle soup.
 */

export type Vec3 = readonly [number, number, number];

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export function normalize(a: Vec3): Vec3 {
    const l = length(a);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/** A triangle mesh with shared vertices. */
export interface TriMesh {
    /** xyz per vertex. */
    readonly positions: Float64Array;
    /** Three vertex indices per triangle. */
    readonly triangles: Uint32Array;
    /** Unit normal per triangle (xyz). */
    readonly normals: Float64Array;
    /** Area per triangle. */
    readonly areas: Float64Array;
    /** Bounding box diagonal. */
    readonly size: number;
}

export function vertex(mesh: TriMesh, i: number): Vec3 {
    return [mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]];
}

export function normalOf(mesh: TriMesh, t: number): Vec3 {
    return [mesh.normals[3 * t], mesh.normals[3 * t + 1], mesh.normals[3 * t + 2]];
}

/**
 * A triangle soup (9 numbers per triangle) welded into a mesh: vertices closer than `weld`
 * (default: 1e-6 of the size) become one, and triangles that collapse are dropped. The soup's
 * winding is kept, so the normals point out of a closed STL.
 */
export function weldTriangles(soup: ArrayLike<number>, weld?: number): TriMesh {
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < soup.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], soup[i + k]);
            max[k] = Math.max(max[k], soup[i + k]);
        }
    }
    if (!Number.isFinite(min[0])) {
        min = [0, 0, 0];
        max = [0, 0, 0];
    }
    const size = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const tol = weld ?? Math.max(size * 1e-6, 1e-9);
    const index = new Map<string, number>();
    const positions: number[] = [];
    const ids: number[] = [];
    const keyOf = (x: number, y: number, z: number) =>
        `${Math.round(x / tol)},${Math.round(y / tol)},${Math.round(z / tol)}`;
    for (let i = 0; i + 2 < soup.length; i += 3) {
        const key = keyOf(soup[i], soup[i + 1], soup[i + 2]);
        let id = index.get(key);
        if (id === undefined) {
            id = positions.length / 3;
            index.set(key, id);
            positions.push(soup[i], soup[i + 1], soup[i + 2]);
        }
        ids.push(id);
    }
    const triangles: number[] = [];
    const normals: number[] = [];
    const areas: number[] = [];
    const p = (i: number): Vec3 => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
    for (let t = 0; t + 2 < ids.length; t += 3) {
        const [a, b, c] = [ids[t], ids[t + 1], ids[t + 2]];
        if (a === b || b === c || a === c) continue;
        const n = cross(sub(p(b), p(a)), sub(p(c), p(a)));
        const doubleArea = length(n);
        if (!(doubleArea > 0)) continue;
        triangles.push(a, b, c);
        normals.push(n[0] / doubleArea, n[1] / doubleArea, n[2] / doubleArea);
        areas.push(doubleArea / 2);
    }
    return {
        positions: Float64Array.from(positions),
        triangles: Uint32Array.from(triangles),
        normals: Float64Array.from(normals),
        areas: Float64Array.from(areas),
        size,
    };
}

/** The mesh's signed volume (positive for outward normals). */
export function meshVolume(mesh: TriMesh): number {
    let v = 0;
    const t = mesh.triangles;
    for (let i = 0; i < t.length; i += 3) {
        v += dot(vertex(mesh, t[i]), cross(vertex(mesh, t[i + 1]), vertex(mesh, t[i + 2]))) / 6;
    }
    return v;
}

/** A unit vector perpendicular to `n`. */
export function anyPerpendicular(n: Vec3): Vec3 {
    const ref: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return normalize(cross(n, ref));
}
