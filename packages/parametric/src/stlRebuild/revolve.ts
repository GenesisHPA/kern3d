// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { fitProfile, type Profile2D } from "./fit2d";
import { cross, dot, normalize, normalOf, sub, type TriMesh, type Vec3, vertex } from "./mesh";
import { regionAxes, smoothRegions } from "./regions";
import { type Loop2D, type SliceFrame, sectionAt } from "./slices";

/**
 * Pieces that are surfaces of revolution — a cylinder, a cone, a sphere, a torus about one axis:
 * a fillet ring round a boss, a countersink, a dome, a knob. Every normal of such a surface
 * meets the axis, so the axis is found by least squares (`(a × n)·(p − c) = 0` for each facet),
 * and the piece is its half-section through the axis revolved a full turn — analytic faces the
 * kernel builds itself, where a mesh piece keeps a face per facet.
 */

export interface RevolvePlan {
    /** A point on the axis and its direction. */
    readonly point: Vec3;
    readonly direction: Vec3;
    /** The sketch frame: its plane holds the axis (`xvec` along it), `axis` is the plane's normal. */
    readonly frame: SliceFrame;
    /** The plane's height along `frame.axis`. */
    readonly base: number;
    /** The half-section's profiles in (u along the axis, v away from it). */
    readonly profiles: Profile2D[];
}

/**
 * The point of the axis along `a` that the facets' normal lines meet best, and how far off
 * they pass it (area-weighted RMS, mm). Undefined when too few facets lean off the axis.
 */
export function axisThrough(mesh: TriMesh, a: Vec3): { point: Vec3; rms: number } | undefined {
    // in a basis square to a: c = s·e1 + t·e2, residual q·p − q·c with q = a × n (q ⟂ a)
    const e1 = normalize(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
    const e2 = cross(a, e1);
    let m11 = 0;
    let m12 = 0;
    let m22 = 0;
    let b1 = 0;
    let b2 = 0;
    let weight = 0;
    const rows: { q1: number; q2: number; r: number; w: number }[] = [];
    for (const { point: p, normal: n, weight: w } of surfaceNormals(mesh)) {
        const q = cross(a, n);
        if (dot(q, q) < 1e-6) continue; // a cap square to the axis says nothing of where it is
        const q1 = dot(q, e1);
        const q2 = dot(q, e2);
        const r = dot(q, p);
        m11 += w * q1 * q1;
        m12 += w * q1 * q2;
        m22 += w * q2 * q2;
        b1 += w * q1 * r;
        b2 += w * q2 * r;
        weight += w;
        rows.push({ q1, q2, r, w });
    }
    const det = m11 * m22 - m12 * m12;
    if (rows.length < 8 || !(Math.abs(det) > 1e-12 * (m11 + m22) ** 2)) return undefined;
    const s = (b1 * m22 - b2 * m12) / det;
    const u = (m11 * b2 - m12 * b1) / det;
    let sum = 0;
    for (const row of rows) {
        const e = row.r - row.q1 * s - row.q2 * u;
        sum += row.w * e * e;
    }
    return {
        point: [e1[0] * s + e2[0] * u, e1[1] * s + e2[1] * u, e1[2] * s + e2[2] * u],
        rms: Math.sqrt(sum / weight),
    };
}

/**
 * The surface's normals at the mesh's vertices — which lie on the true surface — each averaged
 * over the facets round it in one smooth region: a facet's own normal is turned half a step from
 * the vertex's meridian, and its line misses the axis by that much; the average of the facets on
 * both sides lies in the meridian plane. A vertex on a sharp edge gives one normal per side.
 */
function surfaceNormals(mesh: TriMesh): { point: Vec3; normal: Vec3; weight: number }[] {
    const regions = smoothRegions(mesh);
    const regionOf = new Int32Array(mesh.areas.length);
    regions.forEach((members, r) => {
        for (const k of members) regionOf[k] = r;
    });
    const sums = new Map<number, [number, number, number, number]>();
    const t = mesh.triangles;
    const stride = regions.length;
    for (let k = 0; k < mesh.areas.length; k++) {
        const n = normalOf(mesh, k);
        for (let c = 0; c < 3; c++) {
            // weighted by the facet's angle at the vertex: a quad split by a diagonal puts two
            // facets on one side of a vertex and one on the other, but a right angle on each
            const v = vertex(mesh, t[3 * k + c]);
            const e1 = normalize(sub(vertex(mesh, t[3 * k + ((c + 1) % 3)]), v));
            const e2 = normalize(sub(vertex(mesh, t[3 * k + ((c + 2) % 3)]), v));
            const w = Math.acos(Math.max(-1, Math.min(1, dot(e1, e2))));
            const id = t[3 * k + c] * stride + regionOf[k];
            const sum = sums.get(id);
            if (sum === undefined) sums.set(id, [n[0] * w, n[1] * w, n[2] * w, w]);
            else {
                sum[0] += n[0] * w;
                sum[1] += n[1] * w;
                sum[2] += n[2] * w;
                sum[3] += w;
            }
        }
    }
    const out: { point: Vec3; normal: Vec3; weight: number }[] = [];
    for (const [id, [x, y, z, w]] of sums) {
        const normal = normalize([x, y, z]);
        if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) continue;
        out.push({ point: vertex(mesh, Math.floor(id / stride)), normal, weight: w });
    }
    return out;
}

/** A polygon clipped to v ≥ v0 (Sutherland–Hodgman), still a closed loop. */
export function clipHalf(loop: Loop2D, v0: number): Loop2D {
    const out: Loop2D = [];
    for (let i = 0; i < loop.length; i++) {
        const p = loop[i];
        const q = loop[(i + 1) % loop.length];
        const pin = p[1] >= v0;
        const qin = q[1] >= v0;
        if (pin) out.push(p);
        if (pin !== qin) {
            const f = (v0 - p[1]) / (q[1] - p[1]);
            out.push([p[0] + f * (q[0] - p[0]), v0]);
        }
    }
    return out;
}

const WORLD: Vec3[] = [
    [0, 0, 1],
    [0, 1, 0],
    [1, 0, 0],
];

/**
 * The piece as a revolve, or undefined when it is not a surface of revolution about any of the
 * candidate axes (`hints` first, then the axes its own curved regions name, then the world's)
 * within `tol` (RMS of the normals' miss of the axis).
 */
export function planRevolve(
    mesh: TriMesh,
    tol: number,
    hints: readonly Vec3[] = [],
): RevolvePlan | undefined {
    const candidates: Vec3[] = [];
    for (const d of [...hints, ...regionAxes(mesh), ...WORLD]) {
        if (!candidates.some((c) => Math.abs(dot(c, d)) > 0.9999)) candidates.push(d);
    }
    let best: { direction: Vec3; point: Vec3; rms: number } | undefined;
    for (const direction of candidates.slice(0, 6)) {
        const fit = axisThrough(mesh, direction);
        if (fit !== undefined && (best === undefined || fit.rms < best.rms)) best = { direction, ...fit };
    }
    if (best === undefined || best.rms > Math.max(tol * 4, 0.02)) return undefined;
    // the section plane through the axis: normal m ⟂ axis, sketch x along the axis
    const a = best.direction;
    const m = normalize(Math.abs(a[2]) < 0.9 ? cross(a, [0, 0, 1]) : cross(a, [1, 0, 0]));
    const frame: SliceFrame = { axis: m, xvec: a, yvec: cross(m, a) };
    const base = dot(best.point, m);
    const v0 = dot(best.point, frame.yvec);
    const loops = sectionAt(mesh, frame, base, mesh.size);
    const profiles: Profile2D[] = [];
    for (const loop of loops) {
        const half = clipHalf(loop, v0);
        if (half.length < 3) continue;
        const area = half.reduce((s, p, i) => {
            const q = half[(i + 1) % half.length];
            return s + (p[0] * q[1] - q[0] * p[1]) / 2;
        }, 0);
        if (Math.abs(area) < tol * tol) continue;
        const profile = fitProfile(half, tol);
        if (profile !== undefined) profiles.push(profile);
    }
    if (profiles.length === 0) return undefined;
    // the sketch's own origin on the axis, so the revolve's axis is the sketch's x line
    return { point: best.point, direction: a, frame, base, profiles };
}

/** Distance of p from the axis line (for tests and checks). */
export function radiusOf(p: Vec3, point: Vec3, direction: Vec3): number {
    const d = sub(p, point);
    const h = dot(d, direction);
    return Math.hypot(d[0] - direction[0] * h, d[1] - direction[1] * h, d[2] - direction[2] * h);
}
