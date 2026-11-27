// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ClosestPointGrid } from "./closestPoint";

/**
 * The deviation map's numbers: a body's surface against the source mesh, point by point. Each
 * point's signed distance to the mesh (`ClosestPointGrid`) is positive where the body stands
 * outside the mesh (material the scan does not have: red), negative inside it (material missing:
 * blue), and green within the tolerance either way. Pure arithmetic — no kernel, no booleans.
 */

/** Signed distances of `points` (xyz triples) to the mesh. */
export function signedDistances(points: ArrayLike<number>, grid: ClosestPointGrid): Float64Array {
    const n = Math.floor(points.length / 3);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        out[i] = grid.closest(points[3 * i], points[3 * i + 1], points[3 * i + 2])?.signed ?? 0;
    }
    return out;
}

export interface DeviationStats {
    /** Largest outward (positive) and inward (negative, as a negative number) deviations, mm. */
    readonly max: number;
    readonly min: number;
    /** Mean of |d| and the RMS, mm. */
    readonly meanAbs: number;
    readonly rms: number;
    /** Share of the points within ± tolerance. */
    readonly within: number;
    readonly count: number;
}

export function deviationStats(d: ArrayLike<number>, tol: number): DeviationStats {
    let max = 0;
    let min = 0;
    let sum = 0;
    let sq = 0;
    let inside = 0;
    for (let i = 0; i < d.length; i++) {
        const v = d[i];
        max = Math.max(max, v);
        min = Math.min(min, v);
        sum += Math.abs(v);
        sq += v * v;
        if (Math.abs(v) <= tol) inside++;
    }
    const n = Math.max(d.length, 1);
    return { max, min, meanAbs: sum / n, rms: Math.sqrt(sq / n), within: inside / n, count: d.length };
}

/**
 * The colour scale's reach, mm: what the legend's ends read. The 98th percentile of |d|, so one
 * stray spike does not wash the whole map out, but no less than five tolerances.
 */
export function deviationRange(d: ArrayLike<number>, tol: number): number {
    const abs = Float64Array.from(d, Math.abs).sort();
    const p98 = abs.length === 0 ? 0 : abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.98))];
    return Math.max(tol * 5, p98);
}

type Rgb = readonly [number, number, number];

const GREEN: Rgb = [0.18, 0.75, 0.3];
/** Outside the mesh: yellow at the tolerance's edge, red at the range's end. */
const OUT_STOPS: Rgb[] = [
    [0.95, 0.85, 0.15],
    [0.9, 0.12, 0.1],
];
/** Inside the mesh: cyan at the tolerance's edge, blue at the range's end. */
const IN_STOPS: Rgb[] = [
    [0.15, 0.8, 0.9],
    [0.1, 0.2, 0.9],
];

/** The colour of one deviation (RGB 0–1). */
export function deviationColor(d: number, tol: number, range: number): Rgb {
    const a = Math.abs(d);
    if (a <= tol) return GREEN;
    const [near, far] = d > 0 ? OUT_STOPS : IN_STOPS;
    const f = range > tol ? Math.min(1, (a - tol) / (range - tol)) : 1;
    return [
        near[0] + (far[0] - near[0]) * f,
        near[1] + (far[1] - near[1]) * f,
        near[2] + (far[2] - near[2]) * f,
    ];
}

/** Per-vertex colours (3 numbers each) for a mesh's vertex colour array. */
export function deviationColors(d: ArrayLike<number>, tol: number, range: number): number[] {
    const out = new Array<number>(d.length * 3);
    for (let i = 0; i < d.length; i++) {
        const c = deviationColor(d[i], tol, range);
        out[3 * i] = c[0];
        out[3 * i + 1] = c[1];
        out[3 * i + 2] = c[2];
    }
    return out;
}

/** The legend's gradient as CSS: the range's red end on top, its blue end at the bottom. */
export function legendGradient(tol: number, range: number): string {
    const css = (c: Rgb) => `rgb(${c.map((x) => Math.round(x * 255)).join(",")})`;
    const at = (d: number) => `${(((range - d) / (2 * range)) * 100).toFixed(2)}%`;
    return [
        `${css(OUT_STOPS[1])} 0%`,
        `${css(OUT_STOPS[0])} ${at(tol)}`,
        `${css(GREEN)} ${at(tol)}`,
        `${css(GREEN)} ${at(-tol)}`,
        `${css(IN_STOPS[0])} ${at(-tol)}`,
        `${css(IN_STOPS[1])} 100%`,
    ].join(", ");
}

export interface DisplayMesh {
    readonly position: Float32Array;
    readonly normal: Float32Array;
    readonly index: Uint32Array;
}

/**
 * The mesh with every triangle longer than `maxEdge` cut into k² smaller ones (positions and
 * normals interpolated): a CAD body's display mesh spans a big flat face with two triangles, and
 * a colour known only at their corners would hide a dent in the middle. At most `maxVertices`.
 */
export function refineForDisplay(mesh: DisplayMesh, maxEdge: number, maxVertices = 200_000): DisplayMesh {
    const { position: p, normal: nrm, index } = mesh;
    const edge = (a: number, b: number) =>
        Math.hypot(p[3 * a] - p[3 * b], p[3 * a + 1] - p[3 * b + 1], p[3 * a + 2] - p[3 * b + 2]);
    const splits = new Uint8Array(index.length / 3);
    let budget = p.length / 3;
    for (let t = 0; t < splits.length; t++) {
        const [a, b, c] = [index[3 * t], index[3 * t + 1], index[3 * t + 2]];
        const k = Math.min(16, Math.ceil(Math.max(edge(a, b), edge(b, c), edge(c, a)) / maxEdge));
        splits[t] = Math.max(1, k);
        if (splits[t] > 1) budget += ((splits[t] + 1) * (splits[t] + 2)) / 2;
    }
    if (budget > maxVertices) {
        // too many for the budget: coarser everywhere, in proportion
        const shrink = Math.sqrt(maxVertices / budget);
        for (let t = 0; t < splits.length; t++) splits[t] = Math.max(1, Math.floor(splits[t] * shrink));
    }
    const pos: number[] = Array.from(p);
    const nor: number[] = Array.from(nrm);
    const idx: number[] = [];
    for (let t = 0; t < splits.length; t++) {
        const tri = [index[3 * t], index[3 * t + 1], index[3 * t + 2]];
        const k = splits[t];
        if (k <= 1) {
            idx.push(...tri);
            continue;
        }
        // a triangular grid over the barycentric (i, j): row i from corner a toward b
        const id: number[][] = [];
        for (let i = 0; i <= k; i++) {
            id.push([]);
            for (let j = 0; j <= k - i; j++) {
                const wa = (k - i - j) / k;
                const wb = i / k;
                const wc = j / k;
                id[i].push(pos.length / 3);
                for (let e = 0; e < 3; e++) {
                    pos.push(p[3 * tri[0] + e] * wa + p[3 * tri[1] + e] * wb + p[3 * tri[2] + e] * wc);
                    nor.push(nrm[3 * tri[0] + e] * wa + nrm[3 * tri[1] + e] * wb + nrm[3 * tri[2] + e] * wc);
                }
            }
        }
        for (let i = 0; i < k; i++) {
            for (let j = 0; j < k - i; j++) {
                idx.push(id[i][j], id[i + 1][j], id[i][j + 1]);
                if (j + 1 < k - i) idx.push(id[i + 1][j], id[i + 1][j + 1], id[i][j + 1]);
            }
        }
    }
    return { position: Float32Array.from(pos), normal: Float32Array.from(nor), index: Uint32Array.from(idx) };
}
