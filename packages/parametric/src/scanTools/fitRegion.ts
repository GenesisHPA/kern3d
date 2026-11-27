// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { cross, dot, normalOf, sub, type TriMesh, type Vec3, vertex } from "../stlRebuild/mesh";
import { symmetricEigen } from "../stlRebuild/regions";
import {
    axisPoint,
    fitPlane,
    type Primitive,
    primitiveDistance,
    refine,
    revolutionAbout,
    revolutionAxes,
    sphereThrough,
    surfaceNormal,
} from "../stlRebuild/segment";
import { seededRandom } from "./random";

/** A fitted primitive — anything but freeform. */
export type FittedPrimitive = Exclude<Primitive, { kind: "free" }>;

/** The smooth region around a clicked spot, fitted to one primitive. */
export interface RegionFit {
    readonly primitive: FittedPrimitive;
    /** The region's triangles (indexes into the mesh). */
    readonly triangles: number[];
    readonly area: number;
    /** RMS and largest distance of the region's vertices from the primitive, mm. */
    readonly rms: number;
    readonly max: number;
    /** The region's centre (vertex mean), on or near the primitive. */
    readonly centroid: Vec3;
    /** The material's outward side, averaged over the region (a plane's outside). */
    readonly outward: Vec3;
    /**
     * For a cylinder or cone: the region's extent along the axis, measured from the axis point
     * (`point` / `apex`); and whether the material lies outside the surface (a hole: the mesh's
     * normals point at the axis) rather than inside it (a boss, a shaft).
     */
    readonly span?: { readonly min: number; readonly max: number };
    readonly concave?: boolean;
}

/** Neighbouring facets bent by more than this are no longer one smooth region. */
const BEND = (35 * Math.PI) / 180;
/** Triangles gathered round the click to hypothesise from. */
const PATCH = 600;
/** Simpler kinds win a near tie in area: a plane before a cylinder before a sphere… */
const RANK: Record<FittedPrimitive["kind"], number> = { plane: 0, cylinder: 1, sphere: 2, cone: 3, torus: 4 };

/** Triangles sharing an edge, per triangle. */
export function triangleNeighbours(mesh: TriMesh): Int32Array[] {
    const t = mesh.triangles;
    const n = t.length / 3;
    const nv = mesh.positions.length / 3;
    const edges = new Map<number, number>();
    const out: number[][] = Array.from({ length: n }, () => []);
    for (let k = 0; k < n; k++) {
        for (let e = 0; e < 3; e++) {
            const a = t[3 * k + e];
            const b = t[3 * k + ((e + 1) % 3)];
            const key = a < b ? a * nv + b : b * nv + a;
            const other = edges.get(key);
            if (other === undefined) edges.set(key, k);
            else {
                out[k].push(other);
                out[other].push(k);
            }
        }
    }
    return out.map((list) => Int32Array.from(list));
}

function centroidOf(mesh: TriMesh, k: number): Vec3 {
    const t = mesh.triangles;
    const a = vertex(mesh, t[3 * k]);
    const b = vertex(mesh, t[3 * k + 1]);
    const c = vertex(mesh, t[3 * k + 2]);
    return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

/** Up to `limit` triangles round the seed, nearest first, across gentle bends only. */
function patchAround(mesh: TriMesh, seed: number, adjacency: Int32Array[], limit: number): number[] {
    const origin = centroidOf(mesh, seed);
    const taken = new Set<number>([seed]);
    const patch: number[] = [];
    // a frontier kept sorted by distance: patches are small, a sorted array is enough
    const frontier: { k: number; d: number }[] = [{ k: seed, d: 0 }];
    const cosBend = Math.cos(BEND);
    while (frontier.length > 0 && patch.length < limit) {
        const { k } = frontier.shift()!;
        patch.push(k);
        const nk = normalOf(mesh, k);
        for (const m of adjacency[k]) {
            if (taken.has(m) || dot(nk, normalOf(mesh, m)) < cosBend) continue;
            taken.add(m);
            const c = centroidOf(mesh, m);
            const d = Math.hypot(c[0] - origin[0], c[1] - origin[1], c[2] - origin[2]);
            let i = frontier.length;
            while (i > 0 && frontier[i - 1].d > d) i--;
            frontier.splice(i, 0, { k: m, d });
        }
    }
    return patch;
}

function verticesOf(mesh: TriMesh, triangles: readonly number[], limit = 4000): Vec3[] {
    const ids = new Set<number>();
    for (const k of triangles) for (let e = 0; e < 3; e++) ids.add(mesh.triangles[3 * k + e]);
    const all = [...ids];
    const step = Math.max(1, Math.floor(all.length / limit));
    const out: Vec3[] = [];
    for (let i = 0; i < all.length; i += step) out.push(vertex(mesh, all[i]));
    return out;
}

/** The plane most vertices lie on within `tol` (RANSAC), refitted by least squares on them. */
export function ransacPlane(
    points: readonly Vec3[],
    tol: number,
    iterations = 200,
    seed = 1,
): Primitive | undefined {
    if (points.length < 3) return undefined;
    const random = seededRandom(seed);
    let best: Vec3[] = [];
    for (let i = 0; i < iterations; i++) {
        const a = points[Math.floor(random() * points.length)];
        const b = points[Math.floor(random() * points.length)];
        const c = points[Math.floor(random() * points.length)];
        const n = cross(sub(b, a), sub(c, a));
        const l = Math.hypot(n[0], n[1], n[2]);
        if (!(l > 1e-12)) continue;
        const unit: Vec3 = [n[0] / l, n[1] / l, n[2] / l];
        const d = dot(unit, a);
        const inliers = points.filter((p) => Math.abs(dot(unit, p) - d) <= tol);
        if (inliers.length > best.length) best = inliers;
        if (best.length === points.length) break;
    }
    return best.length >= 3 ? fitPlane(best) : undefined;
}

/** The candidate primitives for a patch: a plane, a sphere, surfaces of revolution about the normals' axes. */
function hypotheses(mesh: TriMesh, patch: readonly number[], tol: number): FittedPrimitive[] {
    const points = verticesOf(mesh, patch);
    const normals = patch.map((k) => normalOf(mesh, k));
    const centres = patch.map((k) => centroidOf(mesh, k));
    const out: FittedPrimitive[] = [];
    const plane = ransacPlane(points, tol);
    if (plane !== undefined && plane.kind !== "free") out.push(plane);
    const sphere = sphereThrough(points);
    if (sphere !== undefined && sphere.kind !== "free") out.push(refine(sphere, points) as FittedPrimitive);
    // the axis the normals are square to (a cylinder's), and the lines they all meet
    const m = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ];
    for (const n of normals) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += n[i] * n[j];
    const axes: Vec3[] = [symmetricEigen(m).vectors[0], ...revolutionAxes(normals, centres)];
    for (const a of axes) {
        const c = axisPoint(a, centres, normals);
        if (c === undefined) continue;
        const prim = revolutionAbout(a, c, points, tol);
        if (prim === undefined || prim.kind === "free" || prim.kind === "plane") continue;
        out.push(refine(prim, points) as FittedPrimitive);
    }
    return out;
}

/** The triangles reachable from the seed whose vertices lie on the primitive and whose facets face its way. */
function grow(
    mesh: TriMesh,
    seed: number,
    prim: FittedPrimitive,
    tol: number,
    adjacency: Int32Array[],
): number[] {
    const t = mesh.triangles;
    const on = (k: number) => {
        let sum = 0;
        for (let e = 0; e < 3; e++) {
            const d = Math.abs(primitiveDistance(prim, vertex(mesh, t[3 * k + e])));
            if (d > tol * 2.5) return false;
            sum += d;
        }
        if (sum / 3 > tol) return false;
        const facing = Math.abs(dot(normalOf(mesh, k), surfaceNormal(prim, centroidOf(mesh, k))));
        return facing >= Math.cos(BEND);
    };
    const region = [seed];
    const taken = new Uint8Array(t.length / 3);
    taken[seed] = 1;
    for (let i = 0; i < region.length; i++) {
        for (const m of adjacency[region[i]]) {
            if (taken[m]) continue;
            taken[m] = 1;
            if (on(m)) region.push(m);
        }
    }
    return region;
}

function areaOf(mesh: TriMesh, triangles: readonly number[]): number {
    let a = 0;
    for (const k of triangles) a += mesh.areas[k];
    return a;
}

/** Refits the primitive on the region's vertices. */
function refit(mesh: TriMesh, prim: FittedPrimitive, region: readonly number[]): FittedPrimitive {
    const points = verticesOf(mesh, region, 3000);
    if (prim.kind === "plane") {
        const plane = fitPlane(points);
        // keep the normal's sense
        return dot(plane.normal, prim.normal) < 0
            ? { kind: "plane", normal: [-plane.normal[0], -plane.normal[1], -plane.normal[2]], d: -plane.d }
            : plane;
    }
    return refine(prim, points, 20) as FittedPrimitive;
}

/**
 * The smooth region round `seed` (a triangle) fitted to a plane, cylinder, cone, sphere or
 * torus: candidates hypothesised from the patch round the click (RANSAC for the plane, the
 * normals' axis for the surfaces of revolution), each grown over the neighbours on it within
 * `tol` — the largest wins, a simpler kind on a near tie — then refitted on its region by least
 * squares and grown once more. Undefined when nothing fits even the clicked triangle.
 */
export function fitRegionAt(
    mesh: TriMesh,
    seed: number,
    tol: number,
    adjacency: Int32Array[] = triangleNeighbours(mesh),
): RegionFit | undefined {
    if (seed < 0 || seed >= mesh.areas.length) return undefined;
    const patch = patchAround(mesh, seed, adjacency, PATCH);
    let best: { prim: FittedPrimitive; region: number[]; area: number } | undefined;
    for (const prim of hypotheses(mesh, patch, tol)) {
        const region = grow(mesh, seed, prim, tol, adjacency);
        const area = areaOf(mesh, region);
        if (
            best === undefined ||
            area > best.area * 1.03 ||
            (area >= best.area * 0.97 && RANK[prim.kind] < RANK[best.prim.kind])
        )
            best = { prim, region, area };
    }
    if (best === undefined) return undefined;
    const prim = refit(mesh, best.prim, best.region);
    const region = grow(mesh, seed, prim, tol, adjacency);
    return describe(mesh, prim, region);
}

function describe(mesh: TriMesh, prim: FittedPrimitive, region: number[]): RegionFit {
    const points = verticesOf(mesh, region, 20000);
    let sq = 0;
    let max = 0;
    const c: [number, number, number] = [0, 0, 0];
    for (const p of points) {
        const d = primitiveDistance(prim, p);
        sq += d * d;
        max = Math.max(max, Math.abs(d));
        for (let k = 0; k < 3; k++) c[k] += p[k] / points.length;
    }
    const outward: [number, number, number] = [0, 0, 0];
    let facing = 0;
    for (const k of region) {
        const n = normalOf(mesh, k);
        for (let e = 0; e < 3; e++) outward[e] += n[e] * mesh.areas[k];
        facing += dot(n, surfaceNormal(prim, centroidOf(mesh, k))) * mesh.areas[k];
    }
    const l = Math.hypot(outward[0], outward[1], outward[2]) || 1;
    const fit: RegionFit = {
        primitive: prim,
        triangles: region,
        area: areaOf(mesh, region),
        rms: Math.sqrt(sq / Math.max(points.length, 1)),
        max,
        centroid: c,
        outward: [outward[0] / l, outward[1] / l, outward[2] / l],
    };
    if (prim.kind !== "cylinder" && prim.kind !== "cone") return fit;
    const base = prim.kind === "cylinder" ? prim.point : prim.apex;
    let min = Number.POSITIVE_INFINITY;
    let top = Number.NEGATIVE_INFINITY;
    for (const p of points) {
        const h = dot(sub(p, base), prim.axis);
        min = Math.min(min, h);
        top = Math.max(top, h);
    }
    return { ...fit, span: { min, max: top }, concave: facing < 0 };
}

/**
 * The triangle a ray first hits (Möller–Trumbore over every triangle — a click, not a loop),
 * with the distance along the ray; undefined when it misses the mesh.
 */
export function rayHit(
    mesh: TriMesh,
    origin: Vec3,
    direction: Vec3,
): { triangle: number; t: number } | undefined {
    const tri = mesh.triangles;
    const p = mesh.positions;
    let best: { triangle: number; t: number } | undefined;
    for (let k = 0; k < tri.length / 3; k++) {
        const a = 3 * tri[3 * k];
        const b = 3 * tri[3 * k + 1];
        const c = 3 * tri[3 * k + 2];
        const e1: Vec3 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
        const e2: Vec3 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
        const h = cross(direction, e2);
        const det = dot(e1, h);
        if (Math.abs(det) < 1e-14) continue;
        const s: Vec3 = [origin[0] - p[a], origin[1] - p[a + 1], origin[2] - p[a + 2]];
        const u = dot(s, h) / det;
        if (u < 0 || u > 1) continue;
        const q = cross(s, e1);
        const v = dot(direction, q) / det;
        if (v < 0 || u + v > 1) continue;
        const t = dot(e2, q) / det;
        if (t > 0 && (best === undefined || t < best.t)) best = { triangle: k, t };
    }
    return best;
}
