// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { TriMesh } from "./mesh";

/** Inside intervals along z of one ray column, sorted, as [z0, z1, z0, z1, …]. */
type Intervals = number[];

interface Grid {
    readonly x0: number;
    readonly y0: number;
    readonly step: number;
    readonly nx: number;
    readonly ny: number;
}

/** The z crossings of every column of `grid` with the mesh's triangles. */
function crossings(mesh: TriMesh, grid: Grid): Map<number, number[]> {
    const out = new Map<number, number[]>();
    const p = mesh.positions;
    const t = mesh.triangles;
    const { x0, y0, step, nx, ny } = grid;
    for (let k = 0; k < t.length; k += 3) {
        const a = 3 * t[k];
        const b = 3 * t[k + 1];
        const c = 3 * t[k + 2];
        const ax = p[a];
        const ay = p[a + 1];
        const bx = p[b];
        const by = p[b + 1];
        const cx = p[c];
        const cy = p[c + 1];
        const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
        if (Math.abs(det) < 1e-18) continue; // edge-on to the rays: crosses none of them
        const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - x0) / step - 0.5));
        const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / step - 0.5));
        const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - y0) / step - 0.5));
        const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - y0) / step - 0.5));
        for (let i = i0; i <= i1; i++) {
            const x = x0 + (i + 0.5) * step;
            for (let j = j0; j <= j1; j++) {
                const y = y0 + (j + 0.5) * step;
                // barycentric: inside the triangle's shadow, half-open so a shared edge counts once
                const u = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / det;
                const v = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / det;
                if (u < 0 || v < 0 || u + v > 1) continue;
                if ((u === 0 || v === 0 || u + v === 1) && det < 0) continue;
                const z = p[a + 2] + u * (p[b + 2] - p[a + 2]) + v * (p[c + 2] - p[a + 2]);
                const key = i * ny + j;
                let list = out.get(key);
                if (list === undefined) {
                    list = [];
                    out.set(key, list);
                }
                list.push(z);
            }
        }
    }
    return out;
}

/** Crossings into inside intervals by parity (an odd one left over is dropped). */
function intervals(zs: number[] | undefined): Intervals {
    if (zs === undefined) return [];
    zs.sort((a, b) => a - b);
    return zs.length % 2 === 0 ? zs : zs.slice(0, zs.length - 1);
}

/** Length inside `a` and not inside `b` (both sorted, disjoint intervals). */
export function lengthMinus(a: Intervals, b: Intervals): number {
    let total = 0;
    let j = 0;
    for (let i = 0; i + 1 < a.length; i += 2) {
        const s = a[i];
        const e = a[i + 1];
        while (j + 1 < b.length && b[j + 1] <= s) j += 2;
        let cur = s;
        for (let k = j; k + 1 < b.length && b[k] < e; k += 2) {
            if (b[k] > cur) total += b[k] - cur;
            cur = Math.max(cur, b[k + 1]);
        }
        if (cur < e) total += e - cur;
    }
    return total;
}

/**
 * The two-way difference between two closed meshes by ray columns along z: `resolution` columns
 * across the larger side of their joint shadow, each ray's inside intervals compared. A volume
 * measure no boolean is involved in, so it holds where the kernel gives up on near-coincident
 * solids — the very case a rebuild is.
 */
export function meshDifference(
    a: TriMesh,
    b: TriMesh,
    resolution = 256,
): { aOnly: number; bOnly: number; aVolume: number } {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const m of [a, b]) {
        for (let i = 0; i < m.positions.length; i += 3) {
            minX = Math.min(minX, m.positions[i]);
            maxX = Math.max(maxX, m.positions[i]);
            minY = Math.min(minY, m.positions[i + 1]);
            maxY = Math.max(maxY, m.positions[i + 1]);
        }
    }
    if (!Number.isFinite(minX)) return { aOnly: 0, bOnly: 0, aVolume: 0 };
    const step = Math.max(maxX - minX, maxY - minY, 1e-9) / resolution;
    // off-axis by an odd fraction of a column, so rays miss the parts' own grid of edges
    const grid: Grid = {
        x0: minX - step * 0.5137,
        y0: minY - step * 0.4729,
        step,
        nx: Math.ceil((maxX - minX) / step) + 2,
        ny: Math.ceil((maxY - minY) / step) + 2,
    };
    const ca = crossings(a, grid);
    const cb = crossings(b, grid);
    let aOnly = 0;
    let bOnly = 0;
    let aVolume = 0;
    for (const key of new Set([...ca.keys(), ...cb.keys()])) {
        const ia = intervals(ca.get(key));
        const ib = intervals(cb.get(key));
        aOnly += lengthMinus(ia, ib);
        bOnly += lengthMinus(ib, ia);
        for (let i = 0; i + 1 < ia.length; i += 2) aVolume += ia[i + 1] - ia[i];
    }
    const area = step * step;
    return { aOnly: aOnly * area, bOnly: bOnly * area, aVolume: aVolume * area };
}
