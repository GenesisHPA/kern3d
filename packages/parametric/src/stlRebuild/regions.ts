// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { dot, normalize, normalOf, type TriMesh, type Vec3 } from "./mesh";

/**
 * The mesh's smooth regions and the extrusion axis each curved one implies — the idea of
 * Point2Cyl / Point2Primitive without the learning: a part's side faces are parallel to the
 * axis they were extruded along, so a region whose normals all lie in one plane (a hole, a
 * boss, a rounded wall) names its own axis, square to that plane. A part with features in
 * several directions then offers each of them as an axis to slice along, not only the three
 * its largest flat faces suggest.
 */

/** Neighbouring facets bent by less than this belong to one smooth region. */
const SMOOTH_COS = Math.cos((25 * Math.PI) / 180);
/** Normals all within ~0.5° of one another: a flat region, which names no axis of its own. */
const FLAT_COS = Math.cos((0.5 * Math.PI) / 180);
/** Normals this close to a plane (smallest / largest spread) make the region a ruled side. */
const RULED = 0.02;
/** Axes within ~1° are one. */
const SAME_AXIS = Math.cos((1 * Math.PI) / 180);
/** An axis within ~2° of a world axis or of a flat face's normal is taken as that one. */
const SNAP = Math.cos((2 * Math.PI) / 180);

/** Triangles of the mesh grouped into smooth regions (neighbours across edges bent < 25°). */
export function smoothRegions(mesh: TriMesh): number[][] {
    const count = mesh.areas.length;
    const t = mesh.triangles;
    // each undirected edge's triangles, keyed by its two vertex ids
    const edges = new Map<number, number[]>();
    const nv = mesh.positions.length / 3;
    const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
    for (let k = 0; k < count; k++) {
        for (let e = 0; e < 3; e++) {
            const id = key(t[3 * k + e], t[3 * k + ((e + 1) % 3)]);
            const list = edges.get(id);
            if (list === undefined) edges.set(id, [k]);
            else list.push(k);
        }
    }
    const region = new Int32Array(count).fill(-1);
    const regions: number[][] = [];
    for (let seed = 0; seed < count; seed++) {
        if (region[seed] >= 0) continue;
        const members = [seed];
        region[seed] = regions.length;
        for (let i = 0; i < members.length; i++) {
            const k = members[i];
            const n = normalOf(mesh, k);
            for (let e = 0; e < 3; e++) {
                const neighbours = edges.get(key(t[3 * k + e], t[3 * k + ((e + 1) % 3)]));
                // an edge shared by more than two facets is no smooth surface
                if (neighbours === undefined || neighbours.length !== 2) continue;
                const other = neighbours[0] === k ? neighbours[1] : neighbours[0];
                if (region[other] >= 0) continue;
                if (dot(n, normalOf(mesh, other)) < SMOOTH_COS) continue;
                region[other] = regions.length;
                members.push(other);
            }
        }
        regions.push(members);
    }
    return regions;
}

/** Eigenvalues and eigenvectors of a symmetric 3×3 matrix (Jacobi), smallest value first. */
export function symmetricEigen(m: number[][]): { values: number[]; vectors: Vec3[] } {
    const a = m.map((row) => [...row]);
    const v = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
    ];
    for (let sweep = 0; sweep < 50; sweep++) {
        let off = 0;
        for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
        if (off < 1e-30) break;
        for (let p = 0; p < 3; p++) {
            for (let q = p + 1; q < 3; q++) {
                if (Math.abs(a[p][q]) < 1e-300) continue;
                const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
                const tt = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(tt * tt + 1);
                const s = tt * c;
                for (let k = 0; k < 3; k++) {
                    const akp = a[k][p];
                    const akq = a[k][q];
                    a[k][p] = c * akp - s * akq;
                    a[k][q] = s * akp + c * akq;
                }
                for (let k = 0; k < 3; k++) {
                    const apk = a[p][k];
                    const aqk = a[q][k];
                    a[p][k] = c * apk - s * aqk;
                    a[q][k] = s * apk + c * aqk;
                }
                for (let k = 0; k < 3; k++) {
                    const vkp = v[k][p];
                    const vkq = v[k][q];
                    v[k][p] = c * vkp - s * vkq;
                    v[k][q] = s * vkp + c * vkq;
                }
            }
        }
    }
    const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
    return {
        values: order.map((i) => a[i][i]),
        vectors: order.map((i) => normalize([v[0][i], v[1][i], v[2][i]])),
    };
}

/** The axis a curved region's sides are parallel to, or undefined for a flat or doubly curved one. */
export function regionAxis(
    mesh: TriMesh,
    triangles: readonly number[],
): { axis: Vec3; area: number } | undefined {
    const m = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ];
    let area = 0;
    const first = normalOf(mesh, triangles[0]);
    let flat = true;
    for (const k of triangles) {
        const n = normalOf(mesh, k);
        const w = mesh.areas[k];
        area += w;
        if (flat && dot(n, first) < FLAT_COS) flat = false;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += w * n[i] * n[j];
    }
    if (flat || area <= 0) return undefined;
    const { values, vectors } = symmetricEigen(m);
    // the normals span a plane (two large values, one near zero): a ruled side, axis square to it
    if (!(values[2] > 0) || values[0] / values[2] > RULED) return undefined;
    return { axis: vectors[0], area };
}

const WORLD: Vec3[] = [
    [0, 0, 1],
    [0, 1, 0],
    [1, 0, 0],
];

/**
 * The extrusion axes the mesh's curved regions name, largest region area first: each snapped to
 * a world axis or one of `flats` (the large flat directions) when within ~2°, axes within ~1°
 * merged. Regions smaller than `minShare` of the surface are left out (a fillet's facets).
 */
export function regionAxes(mesh: TriMesh, flats: readonly Vec3[] = [], minShare = 0.01): Vec3[] {
    const total = mesh.areas.reduce((a, b) => a + b, 0);
    const found: { axis: Vec3; area: number }[] = [];
    for (const triangles of smoothRegions(mesh)) {
        const r = regionAxis(mesh, triangles);
        if (r === undefined || r.area < total * minShare) continue;
        let axis = r.axis;
        const snap = [...WORLD, ...flats].find((d) => Math.abs(dot(d, axis)) >= SNAP);
        if (snap !== undefined) axis = snap;
        const same = found.find((f) => Math.abs(dot(f.axis, axis)) >= SAME_AXIS);
        if (same !== undefined) same.area += r.area;
        else found.push({ axis, area: r.area });
    }
    return found.sort((a, b) => b.area - a.area).map((f) => f.axis);
}
