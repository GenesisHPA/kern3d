// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { TriMesh } from "../stlRebuild/mesh";

/**
 * How noisy a mesh is: the spread of its surface about a smooth one, in mm (a Gaussian's σ).
 * A CAD export reads ~0 — its vertices lie on the true surface and its curvature changes
 * smoothly from vertex to vertex — a 3D scan or a photogrammetry mesh reads its scanner's noise.
 *
 * Per smooth vertex (its facets within 30° of each other — a sharp edge says nothing about
 * noise), the umbrella offset h = n·(v − mean of its neighbours): curvature makes it vary
 * slowly over the surface, noise makes it jump from vertex to vertex. So the noise is the
 * spread (MAD) of h minus its neighbours' mean h, scaled to σ on synthetic Gaussian noise.
 */
export function estimateNoise(mesh: TriMesh, maxSamples = 20000): number {
    const n = mesh.positions.length / 3;
    if (n < 30) return 0;
    const { neighbours, normals, smooth } = vertexRings(mesh);
    const p = mesh.positions;
    const h = new Float64Array(n);
    for (let v = 0; v < n; v++) {
        const ring = neighbours[v];
        if (ring.length < 3) continue;
        let mx = 0;
        let my = 0;
        let mz = 0;
        for (const w of ring) {
            mx += p[3 * w];
            my += p[3 * w + 1];
            mz += p[3 * w + 2];
        }
        const k = ring.length;
        h[v] =
            normals[3 * v] * (p[3 * v] - mx / k) +
            normals[3 * v + 1] * (p[3 * v + 1] - my / k) +
            normals[3 * v + 2] * (p[3 * v + 2] - mz / k);
    }
    const diffs: number[] = [];
    const stride = Math.max(1, Math.floor(n / maxSamples));
    for (let v = 0; v < n; v += stride) {
        const ring = neighbours[v];
        if (!smooth[v] || ring.length < 3 || !ring.every((w) => smooth[w])) continue;
        let m = 0;
        for (const w of ring) m += h[w];
        diffs.push(Math.abs(h[v] - m / ring.length));
    }
    // a mesh mostly of sharp edges (a coarse CAD export) has too few smooth vertices to tell
    if (diffs.length < 30) return 0;
    diffs.sort((a, b) => a - b);
    const mad = diffs[Math.floor(diffs.length / 2)];
    // h − mean(h) of a valence-6 umbrella on N(0, σ) noise has a median |·| ≈ 0.86 σ
    return mad / 0.86;
}

/**
 * The fit tolerance for a mesh: the rebuild's CAD default (`defaultTolerance` in
 * stlRebuild/rebuild.ts, repeated here), or three times the
 * scan's noise when that is larger — a fit closer than its data's noise only fits the noise.
 */
export function scanTolerance(mesh: TriMesh, noise = estimateNoise(mesh)): number {
    return Math.max(0.005, mesh.size * 5e-5, 3 * noise);
}

/** Per vertex: its neighbours, its area-weighted normal, and whether its facets bend gently. */
export function vertexRings(mesh: TriMesh): {
    neighbours: number[][];
    normals: Float64Array;
    smooth: Uint8Array;
} {
    const n = mesh.positions.length / 3;
    const sets: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
    const normals = new Float64Array(n * 3);
    const t = mesh.triangles;
    for (let k = 0; k < t.length / 3; k++) {
        const a = mesh.areas[k];
        for (let e = 0; e < 3; e++) {
            const v = t[3 * k + e];
            sets[v].add(t[3 * k + ((e + 1) % 3)]);
            sets[v].add(t[3 * k + ((e + 2) % 3)]);
            normals[3 * v] += mesh.normals[3 * k] * a;
            normals[3 * v + 1] += mesh.normals[3 * k + 1] * a;
            normals[3 * v + 2] += mesh.normals[3 * k + 2] * a;
        }
    }
    for (let v = 0; v < n; v++) {
        const l = Math.hypot(normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]) || 1;
        normals[3 * v] /= l;
        normals[3 * v + 1] /= l;
        normals[3 * v + 2] /= l;
    }
    const smooth = new Uint8Array(n).fill(1);
    const cos30 = Math.cos(Math.PI / 6);
    for (let k = 0; k < t.length / 3; k++) {
        for (let e = 0; e < 3; e++) {
            const v = t[3 * k + e];
            const d =
                mesh.normals[3 * k] * normals[3 * v] +
                mesh.normals[3 * k + 1] * normals[3 * v + 1] +
                mesh.normals[3 * k + 2] * normals[3 * v + 2];
            if (d < cos30) smooth[v] = 0;
        }
    }
    return { neighbours: sets.map((s) => [...s]), normals, smooth };
}
