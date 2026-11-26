// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { cross, dot, normalize, normalOf, sub, type TriMesh, type Vec3, vertex } from "./mesh";
import { symmetricEigen } from "./regions";

/**
 * The mesh as the faces a CAD model is made of: planes, cylinders, cones, spheres and tori, each
 * fitted to the STL's VERTICES — a CAD exporter puts them on the true surface, where a facet's
 * centre lies a chord short of it — and what fits none of them left as freeform.
 *
 * 1. Coplanar neighbours (every vertex within the tolerance of the seed's plane) make planar
 *    clusters: a flat face, or one facet strip of a curved one.
 * 2. Clusters meeting at a gentle bend (a tessellated surface turns by a step of under ~40°) are
 *    the candidates for a curved face. From each such pair (a cylinder: its axis is the two
 *    normals' cross product) or triple (any surface of revolution: the axis from the normals,
 *    the profile in (height, radius) a line — cylinder, cone — or a circle — sphere, torus) a
 *    primitive is hypothesised, grown over the neighbours whose vertices all lie on it, refitted
 *    by least squares as it grows; the largest grown face wins, its clusters are taken, repeat.
 * 3. What is left is planes — or, where small facets meet at gentle bends and no primitive
 *    took them, a freeform region.
 */

export type Primitive =
    | { readonly kind: "plane"; readonly normal: Vec3; readonly d: number }
    | { readonly kind: "cylinder"; readonly axis: Vec3; readonly point: Vec3; readonly radius: number }
    /** `axis` points from the apex into the cone; `angle` is the half-angle, radians. */
    | { readonly kind: "cone"; readonly axis: Vec3; readonly apex: Vec3; readonly angle: number }
    | { readonly kind: "sphere"; readonly center: Vec3; readonly radius: number }
    | {
          readonly kind: "torus";
          readonly axis: Vec3;
          readonly center: Vec3;
          readonly major: number;
          readonly minor: number;
      }
    | { readonly kind: "free" };

export interface Border {
    /** The neighbouring segment. */
    readonly other: number;
    /** Length of the shared edges, mm. */
    length: number;
    /** Length-weighted mean angle between the facets across the border, radians. */
    angle: number;
    /** Share of the border (by length) that is convex — the material's edge, not a corner into it. */
    convex: number;
}

export interface Segment {
    readonly id: number;
    readonly triangles: number[];
    readonly area: number;
    readonly primitive: Primitive;
    /** Largest distance of the segment's vertices from the primitive, mm (0 for freeform). */
    readonly error: number;
    readonly borders: Border[];
}

/** Neighbouring planar clusters bent by more than this are no facets of one smooth surface. */
const SMOOTH = (40 * Math.PI) / 180;
/** A cluster spanning more than this of its primitive's turn is a face, not a facet strip. */
const MAX_SWEEP = (40 * Math.PI) / 180;

/** Signed distance of `p` from the primitive (outside the material's side is not implied). */
export function primitiveDistance(prim: Primitive, p: Vec3): number {
    switch (prim.kind) {
        case "plane":
            return dot(prim.normal, p) - prim.d;
        case "cylinder": {
            const d = sub(p, prim.point);
            const h = dot(d, prim.axis);
            return (
                Math.hypot(d[0] - h * prim.axis[0], d[1] - h * prim.axis[1], d[2] - h * prim.axis[2]) -
                prim.radius
            );
        }
        case "cone": {
            const d = sub(p, prim.apex);
            const h = dot(d, prim.axis);
            const rho = Math.hypot(d[0] - h * prim.axis[0], d[1] - h * prim.axis[1], d[2] - h * prim.axis[2]);
            return rho * Math.cos(prim.angle) - h * Math.sin(prim.angle);
        }
        case "sphere":
            return (
                Math.hypot(p[0] - prim.center[0], p[1] - prim.center[1], p[2] - prim.center[2]) - prim.radius
            );
        case "torus": {
            const d = sub(p, prim.center);
            const h = dot(d, prim.axis);
            const rho = Math.hypot(d[0] - h * prim.axis[0], d[1] - h * prim.axis[1], d[2] - h * prim.axis[2]);
            return Math.hypot(rho - prim.major, h) - prim.minor;
        }
        case "free":
            return 0;
    }
}

/** Two unit vectors square to `a` and to each other. */
function basis(a: Vec3): [Vec3, Vec3] {
    const e1 = normalize(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
    return [e1, cross(a, e1)];
}

/** Kåsa circle through 2D points, with its largest radial residual. */
function circle2(
    points: readonly (readonly [number, number])[],
): { c: [number, number]; r: number } | undefined {
    const n = points.length;
    if (n < 3) return undefined;
    let mx = 0;
    let my = 0;
    for (const [x, y] of points) {
        mx += x;
        my += y;
    }
    mx /= n;
    my /= n;
    let suu = 0;
    let svv = 0;
    let suv = 0;
    let suuu = 0;
    let svvv = 0;
    let suvv = 0;
    let svuu = 0;
    for (const [x, y] of points) {
        const u = x - mx;
        const v = y - my;
        suu += u * u;
        svv += v * v;
        suv += u * v;
        suuu += u * u * u;
        svvv += v * v * v;
        suvv += u * v * v;
        svuu += v * u * u;
    }
    const det = suu * svv - suv * suv;
    if (!(Math.abs(det) > 1e-18 * (suu + svv) ** 2) || !(suu + svv > 0)) return undefined;
    const bu = (suuu + suvv) / 2;
    const bv = (svvv + svuu) / 2;
    const uc = (bu * svv - bv * suv) / det;
    const vc = (bv * suu - bu * suv) / det;
    const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
    return Number.isFinite(r) ? { c: [uc + mx, vc + my], r } : undefined;
}

/** Solves the small dense system `m x = b` (Gauss, partial pivoting); undefined when singular. */
function solve(m: number[][], b: number[]): number[] | undefined {
    const n = b.length;
    const a = m.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
        if (!(Math.abs(a[p][c]) > 1e-300)) return undefined;
        [a[c], a[p]] = [a[p], a[c]];
        for (let r = c + 1; r < n; r++) {
            const f = a[r][c] / a[c][c];
            for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
        }
    }
    const x = new Array<number>(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
        let s = a[r][n];
        for (let k = r + 1; k < n; k++) s -= a[r][k] * x[k];
        x[r] = s / a[r][r];
    }
    return x.every(Number.isFinite) ? x : undefined;
}

/** Largest |distance| of the points from the primitive. */
function maxDistance(prim: Primitive, points: readonly Vec3[]): number {
    let worst = 0;
    for (const p of points) worst = Math.max(worst, Math.abs(primitiveDistance(prim, p)));
    return worst;
}

/** At most `limit` of the points, evenly picked (fits stay cheap on a big face). */
function sample(points: readonly Vec3[], limit = 240): Vec3[] {
    if (points.length <= limit) return [...points];
    const out: Vec3[] = [];
    const step = points.length / limit;
    for (let i = 0; i < limit; i++) out.push(points[Math.floor(i * step)]);
    return out;
}

/**
 * The primitive of the same kind nearest the points, by Levenberg–Marquardt on their distances
 * (numeric derivatives; the axis moves in the plane square to the starting one).
 */
export function refine(start: Primitive, points: readonly Vec3[], iterations = 12): Primitive {
    if (start.kind === "plane" || start.kind === "free") return start;
    const pts = sample(points);
    if (pts.length < 4) return start;
    const axis0: Vec3 = start.kind === "sphere" ? [0, 0, 1] : start.axis;
    const [e1, e2] = basis(axis0);
    const make = (x: readonly number[]): Primitive => {
        const a = normalize([
            axis0[0] + x[0] * e1[0] + x[1] * e2[0],
            axis0[1] + x[0] * e1[1] + x[1] * e2[1],
            axis0[2] + x[0] * e1[2] + x[1] * e2[2],
        ]);
        switch (start.kind) {
            case "cylinder":
                return {
                    kind: "cylinder",
                    axis: a,
                    point: [
                        start.point[0] + x[2] * e1[0] + x[3] * e2[0],
                        start.point[1] + x[2] * e1[1] + x[3] * e2[1],
                        start.point[2] + x[2] * e1[2] + x[3] * e2[2],
                    ],
                    radius: start.radius + x[4],
                };
            case "cone":
                return {
                    kind: "cone",
                    axis: a,
                    apex: [start.apex[0] + x[2], start.apex[1] + x[3], start.apex[2] + x[4]],
                    angle: start.angle + x[5],
                };
            case "sphere":
                return {
                    kind: "sphere",
                    center: [start.center[0] + x[2], start.center[1] + x[3], start.center[2] + x[4]],
                    radius: start.radius + x[5],
                };
            case "torus":
                return {
                    kind: "torus",
                    axis: a,
                    center: [start.center[0] + x[2], start.center[1] + x[3], start.center[2] + x[4]],
                    major: start.major + x[5],
                    minor: start.minor + x[6],
                };
        }
    };
    const n = start.kind === "cylinder" ? 5 : start.kind === "torus" ? 7 : 6;
    // the sphere has no axis: its two axis parameters stay at zero
    const free = (k: number) => !(start.kind === "sphere" && k < 2);
    let x = new Array<number>(n).fill(0);
    const cost = (prim: Primitive) => pts.reduce((s, p) => s + primitiveDistance(prim, p) ** 2, 0);
    let current = cost(make(x));
    let lambda = 1e-3;
    for (let it = 0; it < iterations; it++) {
        const base = make(x);
        const r0 = pts.map((p) => primitiveDistance(base, p));
        const jac: number[][] = pts.map(() => new Array<number>(n).fill(0));
        for (let k = 0; k < n; k++) {
            if (!free(k)) continue;
            const h = 1e-7 * (1 + Math.abs(x[k]));
            const y = [...x];
            y[k] += h;
            const moved = make(y);
            pts.forEach((p, i) => {
                jac[i][k] = (primitiveDistance(moved, p) - r0[i]) / h;
            });
        }
        const jtj: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
        const jtr = new Array<number>(n).fill(0);
        for (let i = 0; i < pts.length; i++) {
            for (let a = 0; a < n; a++) {
                jtr[a] += jac[i][a] * r0[i];
                for (let b = 0; b < n; b++) jtj[a][b] += jac[i][a] * jac[i][b];
            }
        }
        let improved = false;
        for (let tries = 0; tries < 6 && !improved; tries++) {
            const m = jtj.map((row, a) =>
                row.map((v, b) => (a === b ? v * (1 + lambda) + (free(a) ? 1e-12 : 1) : v)),
            );
            const step = solve(
                m,
                jtr.map((v) => -v),
            );
            if (step === undefined) break;
            const y = x.map((v, k) => v + step[k]);
            const c = cost(make(y));
            if (c < current) {
                x = y;
                current = c;
                lambda = Math.max(lambda / 10, 1e-9);
                improved = true;
            } else {
                lambda *= 10;
            }
        }
        if (!improved) break;
    }
    const out = make(x);
    // a radius driven through zero is no surface
    if ((out.kind === "cylinder" || out.kind === "sphere") && !(out.radius > 0)) return start;
    if (out.kind === "torus" && !(out.minor > 0)) return start;
    if (out.kind === "cone" && !(out.angle > 0 && out.angle < Math.PI / 2)) return start;
    return out;
}

/** Least-squares plane through the points. */
export function fitPlane(points: readonly Vec3[]): Primitive & { kind: "plane" } {
    const m = [0, 0, 0];
    for (const p of points) for (let k = 0; k < 3; k++) m[k] += p[k] / points.length;
    const cov = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ];
    for (const p of points) {
        const d = [p[0] - m[0], p[1] - m[1], p[2] - m[2]];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j];
    }
    const normal = symmetricEigen(cov).vectors[0];
    return { kind: "plane", normal, d: dot(normal, m as unknown as Vec3) };
}

/** A cylinder along `axis` through the points: their projections fitted with a circle. */
export function cylinderAlong(axis: Vec3, points: readonly Vec3[]): Primitive | undefined {
    const [e1, e2] = basis(axis);
    const c = circle2(points.map((p) => [dot(p, e1), dot(p, e2)] as [number, number]));
    if (c === undefined) return undefined;
    return {
        kind: "cylinder",
        axis,
        point: [
            e1[0] * c.c[0] + e2[0] * c.c[1],
            e1[1] * c.c[0] + e2[1] * c.c[1],
            e1[2] * c.c[0] + e2[2] * c.c[1],
        ],
        radius: c.r,
    };
}

/**
 * The point of the axis along `a` the normal lines (through `points`, along `normals`) meet
 * best — every normal of a surface of revolution meets its axis.
 */
function axisPoint(a: Vec3, points: readonly Vec3[], normals: readonly Vec3[]): Vec3 | undefined {
    const [e1, e2] = basis(a);
    let m11 = 0;
    let m12 = 0;
    let m22 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < points.length; i++) {
        const q = cross(a, normals[i]);
        if (dot(q, q) < 1e-8) continue;
        const q1 = dot(q, e1);
        const q2 = dot(q, e2);
        const r = dot(q, points[i]);
        m11 += q1 * q1;
        m12 += q1 * q2;
        m22 += q2 * q2;
        b1 += q1 * r;
        b2 += q2 * r;
    }
    const det = m11 * m22 - m12 * m12;
    if (!(Math.abs(det) > 1e-12 * (m11 + m22) ** 2)) return undefined;
    const s = (b1 * m22 - b2 * m12) / det;
    const t = (m11 * b2 - m12 * b1) / det;
    return [e1[0] * s + e2[0] * t, e1[1] * s + e2[1] * t, e1[2] * s + e2[2] * t];
}

/**
 * A surface of revolution about the axis through `c` along `a` fitted to the points: their
 * (height, radius) a line (cylinder, cone) or a circle (sphere, torus), whichever fits closer.
 */
function revolutionAbout(a: Vec3, c: Vec3, points: readonly Vec3[], tol: number): Primitive | undefined {
    const hr = points.map((p) => {
        const d = sub(p, c);
        const h = dot(d, a);
        return [h, Math.hypot(d[0] - h * a[0], d[1] - h * a[1], d[2] - h * a[2])] as [number, number];
    });
    const candidates: Primitive[] = [];
    // a line ρ = ρ0 + k·h by least squares
    {
        const n = hr.length;
        const mh = hr.reduce((s, x) => s + x[0], 0) / n;
        const mr = hr.reduce((s, x) => s + x[1], 0) / n;
        let shh = 0;
        let shr = 0;
        for (const [h, r] of hr) {
            shh += (h - mh) ** 2;
            shr += (h - mh) * (r - mr);
        }
        const k = shh > 1e-18 ? shr / shh : 0;
        if (Math.abs(k) < 1e-3 || shh <= 1e-18) {
            if (mr > tol) candidates.push({ kind: "cylinder", axis: a, point: c, radius: mr });
        } else {
            const h0 = mh - mr / k;
            const apex: Vec3 = [c[0] + a[0] * h0, c[1] + a[1] * h0, c[2] + a[2] * h0];
            const axis: Vec3 = k > 0 ? a : [-a[0], -a[1], -a[2]];
            candidates.push({ kind: "cone", axis, apex, angle: Math.atan(Math.abs(k)) });
        }
    }
    const circ = circle2(hr);
    if (circ !== undefined) {
        const center: Vec3 = [c[0] + a[0] * circ.c[0], c[1] + a[1] * circ.c[0], c[2] + a[2] * circ.c[0]];
        if (Math.abs(circ.c[1]) <= tol) candidates.push({ kind: "sphere", center, radius: circ.r });
        else if (circ.c[1] > 0 && circ.r < 1e4 * tol)
            candidates.push({ kind: "torus", axis: a, center, major: circ.c[1], minor: circ.r });
    }
    let best: Primitive | undefined;
    let bestError = Number.POSITIVE_INFINITY;
    for (const p of candidates) {
        const e = maxDistance(p, points);
        if (e < bestError) {
            bestError = e;
            best = p;
        }
    }
    return best;
}

interface Cluster {
    readonly triangles: number[];
    readonly vertices: number[];
    normal: Vec3;
    area: number;
    centroid: Vec3;
    /** Neighbouring cluster → shared edge length, angle-weighted length and convex length. */
    readonly next: Map<number, { length: number; angle: number; convex: number }>;
}

/** A primitive grown over clusters. */
interface Grown {
    readonly prim: Primitive;
    readonly clusters: number[];
    readonly area: number;
    readonly error: number;
}

/** The mesh's faces (see the module comment); `tol` is the fit tolerance, mm. */
export function segmentMesh(mesh: TriMesh, tol: number): Segment[] {
    const count = mesh.areas.length;
    const t = mesh.triangles;
    const nv = mesh.positions.length / 3;
    const fitTol = Math.max(tol, mesh.size * 1e-6);
    // each undirected edge's triangles
    const edges = new Map<number, number[]>();
    const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
    for (let k = 0; k < count; k++) {
        for (let e = 0; e < 3; e++) {
            const id = key(t[3 * k + e], t[3 * k + ((e + 1) % 3)]);
            const list = edges.get(id);
            if (list === undefined) edges.set(id, [k]);
            else list.push(k);
        }
    }
    const neighboursOf = (k: number): number[] => {
        const out: number[] = [];
        for (let e = 0; e < 3; e++) {
            const list = edges.get(key(t[3 * k + e], t[3 * k + ((e + 1) % 3)]));
            if (list === undefined || list.length !== 2) continue;
            out.push(list[0] === k ? list[1] : list[0]);
        }
        return out;
    };

    // ---- 1. planar clusters, largest seed first -----------------------------------------------
    const clusterOf = new Int32Array(count).fill(-1);
    const clusters: Cluster[] = [];
    const order = [...mesh.areas.keys()].sort((a, b) => mesh.areas[b] - mesh.areas[a]);
    for (const seed of order) {
        if (clusterOf[seed] >= 0) continue;
        const n = normalOf(mesh, seed);
        const d = dot(n, vertex(mesh, t[3 * seed]));
        const id = clusters.length;
        const members = [seed];
        clusterOf[seed] = id;
        for (let i = 0; i < members.length; i++) {
            for (const other of neighboursOf(members[i])) {
                if (clusterOf[other] >= 0) continue;
                if (dot(normalOf(mesh, other), n) < 0.5) continue;
                let on = true;
                for (let j = 0; j < 3 && on; j++)
                    on = Math.abs(dot(n, vertex(mesh, t[3 * other + j])) - d) <= fitTol;
                if (!on) continue;
                clusterOf[other] = id;
                members.push(other);
            }
        }
        const vertices = [...new Set(members.flatMap((k) => [t[3 * k], t[3 * k + 1], t[3 * k + 2]]))];
        let area = 0;
        const sum = [0, 0, 0];
        const cen = [0, 0, 0];
        for (const k of members) {
            const w = mesh.areas[k];
            area += w;
            const nk = normalOf(mesh, k);
            for (let j = 0; j < 3; j++) {
                sum[j] += nk[j] * w;
                cen[j] +=
                    ((mesh.positions[3 * t[3 * k] + j] +
                        mesh.positions[3 * t[3 * k + 1] + j] +
                        mesh.positions[3 * t[3 * k + 2] + j]) /
                        3) *
                    w;
            }
        }
        clusters.push({
            triangles: members,
            vertices,
            normal: normalize(sum as unknown as Vec3),
            area,
            centroid: [cen[0] / area, cen[1] / area, cen[2] / area],
            next: new Map(),
        });
    }
    // borders between clusters: length, bend and convexity
    for (const [id, list] of edges) {
        if (list.length !== 2) continue;
        const [k1, k2] = list;
        const c1 = clusterOf[k1];
        const c2 = clusterOf[k2];
        if (c1 === c2) continue;
        const a = Math.floor(id / nv);
        const b = id - a * nv;
        const pa = vertex(mesh, a);
        const length = Math.hypot(...sub(vertex(mesh, b), pa));
        const n1 = normalOf(mesh, k1);
        const n2 = normalOf(mesh, k2);
        const angle = Math.acos(Math.max(-1, Math.min(1, dot(n1, n2))));
        // convex: the far vertex of the second facet lies behind the first one's plane
        let far = t[3 * k2];
        for (let j = 0; j < 3; j++) if (t[3 * k2 + j] !== a && t[3 * k2 + j] !== b) far = t[3 * k2 + j];
        const convex = dot(n1, sub(vertex(mesh, far), pa)) < 0 ? length : 0;
        for (const [x, y] of [
            [c1, c2],
            [c2, c1],
        ]) {
            const entry = clusters[x].next.get(y);
            if (entry === undefined) clusters[x].next.set(y, { length, angle: angle * length, convex });
            else {
                entry.length += length;
                entry.angle += angle * length;
                entry.convex += convex;
            }
        }
    }
    const bend = (a: number, b: number) => {
        const e = clusters[a].next.get(b);
        return e === undefined ? Math.PI : e.angle / Math.max(e.length, 1e-12);
    };
    const smooth = (a: number, b: number) => bend(a, b) <= SMOOTH;

    // ---- 2. curved primitives grown from gently bent pairs and triples ------------------------
    const taken = new Int32Array(clusters.length).fill(-1);
    const pointsOf = (ids: readonly number[]): Vec3[] => {
        const seen = new Set<number>();
        const out: Vec3[] = [];
        for (const c of ids)
            for (const v of clusters[c].vertices) {
                if (seen.has(v)) continue;
                seen.add(v);
                out.push(vertex(mesh, v));
            }
        return out;
    };
    /** Whether every cluster of the set is a narrow facet strip of the primitive, not a face of its own. */
    const narrow = (prim: Primitive, ids: readonly number[]) => {
        if (prim.kind === "plane" || prim.kind === "free") return false;
        for (const c of ids) {
            // the turn of the surface's normal across the cluster: its vertices' normals' spread
            // (twice the largest turn from the cluster's own normal)
            const mean = clusters[c].normal;
            let worst = 0;
            for (const v of clusters[c].vertices) {
                const n = surfaceNormal(prim, vertex(mesh, v));
                worst = Math.max(worst, Math.acos(Math.min(1, Math.abs(dot(n, mean)))));
            }
            if (2 * worst > MAX_SWEEP) return false;
        }
        return true;
    };
    const fits = (prim: Primitive, c: number) => {
        for (const v of clusters[c].vertices)
            if (Math.abs(primitiveDistance(prim, vertex(mesh, v))) > fitTol) return false;
        return true;
    };
    /** The primitive grown from `seed` over gently bent neighbours that lie on it, refitted as it grows. */
    const grow = (start: Primitive, seed: readonly number[]): Grown | undefined => {
        let prim = start;
        const inSet = new Set(seed);
        const members = [...seed];
        let refitAt = members.length * 2;
        for (let i = 0; i < members.length; i++) {
            for (const other of clusters[members[i]].next.keys()) {
                if (inSet.has(other) || taken[other] >= 0 || !smooth(members[i], other)) continue;
                if (!fits(prim, other)) continue;
                inSet.add(other);
                members.push(other);
                if (members.length >= refitAt) {
                    const points = pointsOf(members);
                    const next = refine(prim, points, 6);
                    if (maxDistance(next, points) <= fitTol) prim = next;
                    refitAt = members.length * 2;
                }
            }
        }
        // two strips fit some cylinder whatever they are (a face and a facet beside it): three at least
        if (members.length < 3) return undefined;
        const points = pointsOf(members);
        const error = maxDistance(prim, points);
        if (error > fitTol || !narrow(prim, members)) return undefined;
        return { prim, clusters: members, area: members.reduce((s, c) => s + clusters[c].area, 0), error };
    };
    /** Hypotheses from a gently bent pair (and the pair's next gentle neighbour). */
    const hypotheses = (i: number, j: number): Primitive[] => {
        const out: Primitive[] = [];
        const ni = clusters[i].normal;
        const nj = clusters[j].normal;
        const ax = cross(ni, nj);
        const seedPoints = pointsOf([i, j]);
        if (Math.hypot(...ax) > Math.sin((0.2 * Math.PI) / 180)) {
            const cyl = cylinderAlong(normalize(ax), seedPoints);
            if (cyl !== undefined && maxDistance(cyl, seedPoints) <= fitTol) out.push(cyl);
        }
        // the pair's gentle neighbourhood, nearest first: any surface of revolution through it
        const near = [i, j];
        const seen = new Set(near);
        for (let q = 0; q < near.length && near.length < 16; q++) {
            for (const other of clusters[near[q]].next.keys()) {
                if (seen.has(other) || taken[other] >= 0 || !smooth(near[q], other)) continue;
                seen.add(other);
                near.push(other);
                if (near.length >= 16) break;
            }
        }
        for (const size of [...new Set([near.length, 8, 5, 3])].filter((x) => x >= 3 && x <= near.length)) {
            const ids = near.slice(0, size);
            const points = pointsOf(ids);
            const normals = ids.map((c) => clusters[c].normal);
            const centres = ids.map((c) => clusters[c].centroid);
            const found: Primitive[] = [];
            for (const a of revolutionAxes(normals, centres)) {
                const c = axisPoint(a, centres, normals);
                if (c === undefined) continue;
                const prim = revolutionAbout(a, c, points, fitTol);
                if (prim === undefined) continue;
                const refined = refine(prim, points);
                if (maxDistance(refined, points) <= fitTol) found.push(refined);
            }
            const sphere = sphereThrough(points);
            if (sphere !== undefined && maxDistance(sphere, points) <= fitTol) found.push(sphere);
            out.push(...found);
            if (found.length > 0) break;
        }
        return out;
    };
    const seeds: { i: number; j: number; length: number }[] = [];
    clusters.forEach((c, i) => {
        for (const [j, e] of c.next) if (i < j && smooth(i, j)) seeds.push({ i, j, length: e.length });
    });
    seeds.sort((a, b) => b.length - a.length);
    const grownList: Grown[] = [];
    for (const { i, j } of seeds) {
        if (taken[i] >= 0 || taken[j] >= 0) continue;
        let winner: Grown | undefined;
        for (const h of hypotheses(i, j)) {
            const g = grow(h, [i, j]);
            if (g !== undefined && (winner === undefined || g.area > winner.area)) winner = g;
        }
        if (winner === undefined) continue;
        const points = pointsOf(winner.clusters);
        const prim = refine(winner.prim, points);
        const error = maxDistance(prim, points);
        const kept = error <= winner.error ? { ...winner, prim, error } : winner;
        for (const c of kept.clusters) taken[c] = grownList.length;
        grownList.push(kept);
    }

    // ---- 3. the rest: planes, and freeform where small facets meet at gentle bends -------------
    const segmentOf = new Int32Array(clusters.length).fill(-1);
    const segments: { clusters: number[]; prim: Primitive; error: number }[] = [];
    for (const g of grownList) {
        const id = segments.length;
        for (const c of g.clusters) segmentOf[c] = id;
        segments.push({ clusters: g.clusters, prim: g.prim, error: g.error });
    }
    /** A leftover facet: tiny, or bent gently from its neighbours on most of its border. */
    const facetLike = (c: number) => {
        let gentle = 0;
        let all = 0;
        for (const [o, e] of clusters[c].next) {
            all += e.length;
            if (smooth(c, o) && bend(c, o) > (1 * Math.PI) / 180) gentle += e.length;
        }
        return all > 0 && gentle >= all * 0.5 && clusters[c].triangles.length <= 2;
    };
    for (let c = 0; c < clusters.length; c++) {
        if (segmentOf[c] >= 0 || !facetLike(c)) continue;
        // a freeform region: the connected gentle facets no primitive took
        const id = segments.length;
        const members = [c];
        segmentOf[c] = id;
        for (let i = 0; i < members.length; i++) {
            for (const o of clusters[members[i]].next.keys()) {
                if (segmentOf[o] >= 0 || !smooth(members[i], o) || !facetLike(o)) continue;
                segmentOf[o] = id;
                members.push(o);
            }
        }
        if (members.length >= 3) segments.push({ clusters: members, prim: { kind: "free" }, error: 0 });
        else {
            for (const m of members) segmentOf[m] = -1;
            // taken as planes below; keep the loop from seeding them again
            for (const m of members) segmentOf[m] = -2;
        }
    }
    for (let c = 0; c < clusters.length; c++) {
        if (segmentOf[c] >= 0) continue;
        const points = pointsOf([c]);
        const plane = points.length >= 3 ? fitPlane(points) : undefined;
        const prim: Primitive =
            plane !== undefined
                ? dot(plane.normal, clusters[c].normal) < 0
                    ? {
                          kind: "plane",
                          normal: [-plane.normal[0], -plane.normal[1], -plane.normal[2]],
                          d: -plane.d,
                      }
                    : plane
                : {
                      kind: "plane",
                      normal: clusters[c].normal,
                      d: dot(clusters[c].normal, clusters[c].centroid),
                  };
        segmentOf[c] = segments.length;
        segments.push({ clusters: [c], prim, error: maxDistance(prim, points) });
    }
    // borders between segments
    const out: Segment[] = segments.map((s, id) => ({
        id,
        triangles: s.clusters.flatMap((c) => clusters[c].triangles),
        area: s.clusters.reduce((a, c) => a + clusters[c].area, 0),
        primitive: s.prim,
        error: s.error,
        borders: [],
    }));
    const borders = new Map<number, Border>();
    clusters.forEach((cl, c) => {
        const a = segmentOf[c];
        for (const [o, e] of cl.next) {
            const b = segmentOf[o];
            if (a === b) continue;
            const k = a * segments.length + b;
            const entry = borders.get(k);
            if (entry === undefined) {
                const border: Border = { other: b, length: e.length, angle: e.angle, convex: e.convex };
                borders.set(k, border);
                out[a].borders.push(border);
            } else {
                entry.length += e.length;
                entry.angle += e.angle;
                entry.convex += e.convex;
            }
        }
    });
    for (const s of out)
        for (const b of s.borders) {
            b.angle /= Math.max(b.length, 1e-12);
            b.convex /= Math.max(b.length, 1e-12);
        }
    return out;
}

/**
 * Candidate axes of a surface of revolution through planar facets (normals through their
 * centres): the direction the normals make one angle with (a cylinder's, a cone's), and the line
 * every normal line meets (any surface of revolution — a torus's), by Plücker coordinates: the
 * line (a, m) meets (d, p × d) when a·(p × d) + d·m = 0, a homogeneous system in (a, m).
 */
export function revolutionAxes(normals: readonly Vec3[], centres: readonly Vec3[]): Vec3[] {
    const out: Vec3[] = [];
    const n = normals.length;
    const mean = [0, 0, 0];
    for (const v of normals) for (let k = 0; k < 3; k++) mean[k] += v[k] / n;
    const cov = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ];
    for (const v of normals) {
        const d = [v[0] - mean[0], v[1] - mean[1], v[2] - mean[2]];
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a][b] += d[a] * d[b];
    }
    out.push(symmetricEigen(cov).vectors[0]);
    if (n >= 5) {
        const m = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
        for (let i = 0; i < n; i++) {
            const moment = cross(centres[i], normals[i]);
            const row = [...moment, ...normals[i]];
            for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) m[a][b] += row[a] * row[b];
        }
        const v = jacobiEigen(m).vectors[0];
        const a: Vec3 = [v[0], v[1], v[2]];
        if (Math.hypot(...a) > 1e-6) out.push(normalize(a));
    }
    return out;
}

/** Eigenvalues and vectors of a symmetric n × n matrix (cyclic Jacobi), smallest first. */
export function jacobiEigen(m: readonly (readonly number[])[]): { values: number[]; vectors: number[][] } {
    const n = m.length;
    const a = m.map((row) => [...row]);
    const v: number[][] = Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
    );
    for (let sweep = 0; sweep < 60; sweep++) {
        let off = 0;
        let diag = 0;
        for (let p = 0; p < n; p++) {
            diag += a[p][p] * a[p][p];
            for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
        }
        if (off <= 1e-30 * Math.max(diag, 1e-300)) break;
        for (let p = 0; p < n; p++) {
            for (let q = p + 1; q < n; q++) {
                if (Math.abs(a[p][q]) < 1e-300) continue;
                const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;
                for (let k = 0; k < n; k++) {
                    const akp = a[k][p];
                    const akq = a[k][q];
                    a[k][p] = c * akp - s * akq;
                    a[k][q] = s * akp + c * akq;
                }
                for (let k = 0; k < n; k++) {
                    const apk = a[p][k];
                    const aqk = a[q][k];
                    a[p][k] = c * apk - s * aqk;
                    a[q][k] = s * apk + c * aqk;
                }
                for (let k = 0; k < n; k++) {
                    const vkp = v[k][p];
                    const vkq = v[k][q];
                    v[k][p] = c * vkp - s * vkq;
                    v[k][q] = s * vkp + c * vkq;
                }
            }
        }
    }
    const order = [...Array(n).keys()].sort((i, j) => a[i][i] - a[j][j]);
    return { values: order.map((i) => a[i][i]), vectors: order.map((i) => v.map((row) => row[i])) };
}

/** Algebraic sphere through the points (|p|² = 2c·p + k), or undefined when degenerate. */
export function sphereThrough(points: readonly Vec3[]): Primitive | undefined {
    if (points.length < 4) return undefined;
    const m = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    const b = [0, 0, 0, 0];
    const o = points[0];
    for (const q of points) {
        const p = sub(q, o);
        const row = [2 * p[0], 2 * p[1], 2 * p[2], 1];
        const rhs = dot(p, p);
        for (let i = 0; i < 4; i++) {
            b[i] += row[i] * rhs;
            for (let j = 0; j < 4; j++) m[i][j] += row[i] * row[j];
        }
    }
    const x = solve(m, b);
    if (x === undefined) return undefined;
    const r2 = x[3] + x[0] * x[0] + x[1] * x[1] + x[2] * x[2];
    if (!(r2 > 0)) return undefined;
    return { kind: "sphere", center: [x[0] + o[0], x[1] + o[1], x[2] + o[2]], radius: Math.sqrt(r2) };
}

/** The primitive's unit normal at (or nearest) `p`, away from its axis or centre (sign is not the material's). */
export function surfaceNormal(prim: Primitive, p: Vec3): Vec3 {
    switch (prim.kind) {
        case "plane":
            return prim.normal;
        case "cylinder": {
            const d = sub(p, prim.point);
            const h = dot(d, prim.axis);
            return normalize([d[0] - h * prim.axis[0], d[1] - h * prim.axis[1], d[2] - h * prim.axis[2]]);
        }
        case "cone": {
            const d = sub(p, prim.apex);
            const h = dot(d, prim.axis);
            const radial = normalize([
                d[0] - h * prim.axis[0],
                d[1] - h * prim.axis[1],
                d[2] - h * prim.axis[2],
            ]);
            const c = Math.cos(prim.angle);
            const s = Math.sin(prim.angle);
            return normalize([
                radial[0] * c - prim.axis[0] * s,
                radial[1] * c - prim.axis[1] * s,
                radial[2] * c - prim.axis[2] * s,
            ]);
        }
        case "sphere":
            return normalize(sub(p, prim.center));
        case "torus": {
            const d = sub(p, prim.center);
            const h = dot(d, prim.axis);
            const radial = normalize([
                d[0] - h * prim.axis[0],
                d[1] - h * prim.axis[1],
                d[2] - h * prim.axis[2],
            ]);
            const ring: Vec3 = [
                prim.center[0] + radial[0] * prim.major,
                prim.center[1] + radial[1] * prim.major,
                prim.center[2] + radial[2] * prim.major,
            ];
            return normalize(sub(p, ring));
        }
        case "free":
            return [0, 0, 1];
    }
}

/** A one-line description of a segment, for the diagnostics. */
export function describeSegment(s: Segment): string {
    const p = s.primitive;
    const f = (x: number) => x.toFixed(3);
    const v = (x: Vec3) => `(${x.map((y) => y.toFixed(2)).join(",")})`;
    const kind =
        p.kind === "plane"
            ? `plane n${v(p.normal)}`
            : p.kind === "cylinder"
              ? `cylinder r${f(p.radius)} axis${v(p.axis)} at${v(p.point)}`
              : p.kind === "cone"
                ? `cone ${((p.angle * 180) / Math.PI).toFixed(2)}° axis${v(p.axis)} apex${v(p.apex)}`
                : p.kind === "sphere"
                  ? `sphere r${f(p.radius)} at${v(p.center)}`
                  : p.kind === "torus"
                    ? `torus R${f(p.major)} r${f(p.minor)} axis${v(p.axis)} at${v(p.center)}`
                    : "free";
    return `#${s.id} ${kind} area ${s.area.toFixed(1)} tris ${s.triangles.length} err ${s.error.toExponential(1)}`;
}
