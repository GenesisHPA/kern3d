// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Nearest point on a triangle mesh, for many queries: the triangles binned over a uniform 3D
 * grid (each into every cell its box touches), a query searched in growing shells of cells until
 * no unvisited cell can hold anything nearer. No kernel, no booleans — a deviation map over a
 * body's display mesh costs milliseconds per thousand points.
 *
 * The signed distance takes the side from the nearest triangle's normal; where several
 * triangles are about as near (the query is closest to an edge or a corner) the one that faces
 * the query most squarely decides, which is the side a closed mesh's edge pseudo-normal gives.
 */
export interface ClosestHit {
    /** Unsigned distance, mm. */
    readonly distance: number;
    /** Positive outside the mesh (along its normals), negative inside. */
    readonly signed: number;
    readonly triangle: number;
    readonly point: readonly [number, number, number];
}

export class ClosestPointGrid {
    private readonly cellStart: Int32Array;
    private readonly cellItems: Int32Array;
    private readonly origin: [number, number, number];
    private readonly step: number;
    private readonly dims: [number, number, number];
    private readonly normals: Float64Array;
    readonly triangleCount: number;
    private stamp: Int32Array;
    private visit = 0;

    /** `soup`: 9 numbers per triangle (positions of its three corners). */
    constructor(private readonly soup: ArrayLike<number>) {
        const n = Math.floor(soup.length / 9);
        this.triangleCount = n;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < n * 9; i += 3) {
            for (let k = 0; k < 3; k++) {
                min[k] = Math.min(min[k], soup[i + k]);
                max[k] = Math.max(max[k], soup[i + k]);
            }
        }
        if (!Number.isFinite(min[0])) {
            min.fill(0);
            max.fill(1);
        }
        const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        const longest = Math.max(ext[0], ext[1], ext[2], 1e-9);
        // about two triangles per cell (flat parts: by area, not volume), at most 256 a side
        const cells = Math.min(Math.max(n / 2, 1), 2_000_000);
        const area =
            Math.max(ext[0] * ext[1], ext[1] * ext[2], ext[0] * ext[2], longest * longest * 1e-6) * 2;
        let step = Math.max(Math.cbrt(((ext[0] + 1e-9) * (ext[1] + 1e-9) * (ext[2] + 1e-9)) / cells), 0);
        step = Math.max(step, Math.sqrt(area / cells) * 0.5, longest / 256, 1e-9);
        this.step = step;
        this.origin = [min[0] - step * 0.5, min[1] - step * 0.5, min[2] - step * 0.5];
        this.dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil((ext[k] + step) / step))) as [
            number,
            number,
            number,
        ];
        const total = this.dims[0] * this.dims[1] * this.dims[2];
        const counts = new Int32Array(total + 1);
        this.forEachCell(n, (cell) => counts[cell + 1]++);
        for (let i = 0; i < total; i++) counts[i + 1] += counts[i];
        this.cellStart = counts;
        this.cellItems = new Int32Array(counts[total]);
        const fill = counts.slice(0, total);
        this.forEachCell(n, (cell, t) => {
            this.cellItems[fill[cell]++] = t;
        });
        this.normals = new Float64Array(n * 3);
        for (let t = 0; t < n; t++) {
            const o = t * 9;
            const ux = soup[o + 3] - soup[o];
            const uy = soup[o + 4] - soup[o + 1];
            const uz = soup[o + 5] - soup[o + 2];
            const vx = soup[o + 6] - soup[o];
            const vy = soup[o + 7] - soup[o + 1];
            const vz = soup[o + 8] - soup[o + 2];
            const nx = uy * vz - uz * vy;
            const ny = uz * vx - ux * vz;
            const nz = ux * vy - uy * vx;
            const l = Math.hypot(nx, ny, nz) || 1;
            this.normals[t * 3] = nx / l;
            this.normals[t * 3 + 1] = ny / l;
            this.normals[t * 3 + 2] = nz / l;
        }
        this.stamp = new Int32Array(n);
    }

    private cellIndex(i: number, j: number, k: number): number {
        return (k * this.dims[1] + j) * this.dims[0] + i;
    }

    private coord(v: number, axis: number): number {
        const c = Math.floor((v - this.origin[axis]) / this.step);
        return Math.min(this.dims[axis] - 1, Math.max(0, c));
    }

    private forEachCell(n: number, visit: (cell: number, triangle: number) => void) {
        const s = this.soup;
        for (let t = 0; t < n; t++) {
            const o = t * 9;
            const i0 = this.coord(Math.min(s[o], s[o + 3], s[o + 6]), 0);
            const i1 = this.coord(Math.max(s[o], s[o + 3], s[o + 6]), 0);
            const j0 = this.coord(Math.min(s[o + 1], s[o + 4], s[o + 7]), 1);
            const j1 = this.coord(Math.max(s[o + 1], s[o + 4], s[o + 7]), 1);
            const k0 = this.coord(Math.min(s[o + 2], s[o + 5], s[o + 8]), 2);
            const k1 = this.coord(Math.max(s[o + 2], s[o + 5], s[o + 8]), 2);
            for (let k = k0; k <= k1; k++)
                for (let j = j0; j <= j1; j++)
                    for (let i = i0; i <= i1; i++) visit(this.cellIndex(i, j, k), t);
        }
    }

    /** The triangle's unit normal (from its winding). */
    normal(t: number): [number, number, number] {
        return [this.normals[t * 3], this.normals[t * 3 + 1], this.normals[t * 3 + 2]];
    }

    /**
     * The nearest point of the mesh to (x, y, z), or undefined for an empty mesh or when
     * nothing lies within `maxDistance`.
     */
    closest(x: number, y: number, z: number, maxDistance = Number.POSITIVE_INFINITY): ClosestHit | undefined {
        if (this.triangleCount === 0) return undefined;
        this.visit++;
        if (this.visit === 0x7fffffff) {
            this.stamp = new Int32Array(this.triangleCount);
            this.visit = 1;
        }
        const ci = Math.floor((x - this.origin[0]) / this.step);
        const cj = Math.floor((y - this.origin[1]) / this.step);
        const ck = Math.floor((z - this.origin[2]) / this.step);
        const state: SearchState = {
            best: maxDistance * maxDistance,
            t: -1,
            facing: 0,
            p: [0, 0, 0],
        };
        // a query outside the grid starts its shells at the nearest cell's distance
        const outside = Math.max(
            0,
            -ci,
            ci - this.dims[0] + 1,
            -cj,
            cj - this.dims[1] + 1,
            -ck,
            ck - this.dims[2] + 1,
        );
        const maxRing = Math.max(this.dims[0], this.dims[1], this.dims[2]) + outside;
        for (let ring = outside; ring <= maxRing; ring++) {
            // every cell of this ring lies at least (ring - 1) cells away
            const reach = (ring - 1) * this.step;
            if (ring > outside && reach > 0 && reach * reach > state.best) break;
            this.searchRing(ci, cj, ck, ring, x, y, z, state);
        }
        if (state.t < 0) return undefined;
        const distance = Math.sqrt(state.best);
        const n = state.t * 3;
        const side =
            (x - state.p[0]) * this.normals[n] +
            (y - state.p[1]) * this.normals[n + 1] +
            (z - state.p[2]) * this.normals[n + 2];
        return { distance, signed: side < 0 ? -distance : distance, triangle: state.t, point: state.p };
    }

    private searchRing(
        ci: number,
        cj: number,
        ck: number,
        ring: number,
        x: number,
        y: number,
        z: number,
        state: SearchState,
    ) {
        const q: [number, number, number] = [0, 0, 0];
        for (let k = Math.max(0, ck - ring); k <= Math.min(this.dims[2] - 1, ck + ring); k++) {
            for (let j = Math.max(0, cj - ring); j <= Math.min(this.dims[1] - 1, cj + ring); j++) {
                const onShell = Math.abs(k - ck) === ring || Math.abs(j - cj) === ring;
                for (let i = Math.max(0, ci - ring); i <= Math.min(this.dims[0] - 1, ci + ring); i++) {
                    if (!onShell && Math.abs(i - ci) !== ring) continue;
                    const cell = this.cellIndex(i, j, k);
                    for (let m = this.cellStart[cell]; m < this.cellStart[cell + 1]; m++) {
                        const t = this.cellItems[m];
                        if (this.stamp[t] === this.visit) continue;
                        this.stamp[t] = this.visit;
                        closestOnTriangle(this.soup, t * 9, x, y, z, q);
                        this.consider(t, x - q[0], y - q[1], z - q[2], q, state);
                    }
                }
            }
        }
    }

    private consider(
        t: number,
        dx: number,
        dy: number,
        dz: number,
        q: readonly [number, number, number],
        state: SearchState,
    ) {
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > state.best * (1 + 1e-9) + 1e-24) return;
        const l = Math.sqrt(d2) || 1;
        const n = t * 3;
        const facing = Math.abs(
            (dx * this.normals[n] + dy * this.normals[n + 1] + dz * this.normals[n + 2]) / l,
        );
        // a tie (an edge or corner shared by several facets): the squarest facet decides the side
        const tie = state.t >= 0 && d2 >= state.best * (1 - 1e-6) - 1e-24;
        if (tie && facing <= state.facing) return;
        state.best = Math.min(state.best, d2);
        state.t = t;
        state.facing = facing;
        state.p = [q[0], q[1], q[2]];
    }
}

interface SearchState {
    best: number;
    t: number;
    facing: number;
    p: [number, number, number];
}

/** The point of triangle `s[o..o+9]` nearest (px, py, pz), into `out` (Ericson's regions). */
export function closestOnTriangle(
    s: ArrayLike<number>,
    o: number,
    px: number,
    py: number,
    pz: number,
    out: [number, number, number],
): void {
    const ax = s[o];
    const ay = s[o + 1];
    const az = s[o + 2];
    const abx = s[o + 3] - ax;
    const aby = s[o + 4] - ay;
    const abz = s[o + 5] - az;
    const acx = s[o + 6] - ax;
    const acy = s[o + 7] - ay;
    const acz = s[o + 8] - az;
    const set = (u: number, v: number) => {
        out[0] = ax + abx * u + acx * v;
        out[1] = ay + aby * u + acy * v;
        out[2] = az + abz * u + acz * v;
    };
    const apx = px - ax;
    const apy = py - ay;
    const apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) {
        set(0, 0);
        return;
    }
    const bpx = px - s[o + 3];
    const bpy = py - s[o + 4];
    const bpz = pz - s[o + 5];
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) {
        set(1, 0);
        return;
    }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        set(d1 / (d1 - d3), 0);
        return;
    }
    const cpx = px - s[o + 6];
    const cpy = py - s[o + 7];
    const cpz = pz - s[o + 8];
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) {
        set(0, 1);
        return;
    }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        set(0, d2 / (d2 - d6));
        return;
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
        set(1 - w, w);
        return;
    }
    const denom = 1 / (va + vb + vc);
    set(vb * denom, vc * denom);
    return;
}
