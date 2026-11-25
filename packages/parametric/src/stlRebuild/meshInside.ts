// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Inside / outside of a closed triangle mesh by ray parity, for many points at once: the
 * triangles are binned over a grid in (x, y), and a point is inside when a ray from it along +z
 * crosses the surface an odd number of times. The ray along −z must agree; where it does not
 * (the ray grazed an edge, the mesh has a gap) the answer is `undefined` and the caller asks the
 * kernel. Thousands of points cost milliseconds — the kernel's classifier is rebuilt per point.
 */
export class MeshInside {
    private readonly cells: Int32Array[];
    private readonly x0: number;
    private readonly y0: number;
    private readonly step: number;
    private readonly nx: number;
    private readonly ny: number;

    /** `soup`: 9 numbers per triangle. */
    constructor(private readonly soup: ArrayLike<number>) {
        const n = Math.floor(soup.length / 9);
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < n * 9; i += 3) {
            minX = Math.min(minX, soup[i]);
            maxX = Math.max(maxX, soup[i]);
            minY = Math.min(minY, soup[i + 1]);
            maxY = Math.max(maxY, soup[i + 1]);
        }
        if (!Number.isFinite(minX)) {
            minX = minY = 0;
            maxX = maxY = 1;
        }
        // about as many cells as triangles, square
        const side = Math.max(1, Math.round(Math.sqrt(Math.max(1, n))));
        this.step = Math.max(maxX - minX, maxY - minY, 1e-9) / side;
        this.x0 = minX - this.step * 0.5;
        this.y0 = minY - this.step * 0.5;
        this.nx = Math.ceil((maxX - minX) / this.step) + 2;
        this.ny = Math.ceil((maxY - minY) / this.step) + 2;
        const lists: number[][] = Array.from({ length: this.nx * this.ny }, () => []);
        for (let t = 0; t < n; t++) {
            const o = t * 9;
            const ax = Math.min(soup[o], soup[o + 3], soup[o + 6]);
            const bx = Math.max(soup[o], soup[o + 3], soup[o + 6]);
            const ay = Math.min(soup[o + 1], soup[o + 4], soup[o + 7]);
            const by = Math.max(soup[o + 1], soup[o + 4], soup[o + 7]);
            const i0 = this.cx(ax);
            const i1 = this.cx(bx);
            const j0 = this.cy(ay);
            const j1 = this.cy(by);
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) lists[j * this.nx + i].push(t);
        }
        this.cells = lists.map((l) => Int32Array.from(l));
    }

    private cx(x: number): number {
        return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.step)));
    }

    private cy(y: number): number {
        return Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.y0) / this.step)));
    }

    /**
     * Whether (x, y, z) is inside: true / false when the rays up and down agree, undefined when
     * they do not (ask someone else).
     */
    contains(x: number, y: number, z: number): boolean | undefined {
        const cell = this.cells[this.cy(y) * this.nx + this.cx(x)];
        const s = this.soup;
        let up = 0;
        let down = 0;
        for (let k = 0; k < cell.length; k++) {
            const o = cell[k] * 9;
            // barycentric test of (x, y) in the triangle's shadow; half-open on edges
            const x1 = s[o] - x;
            const y1 = s[o + 1] - y;
            const x2 = s[o + 3] - x;
            const y2 = s[o + 4] - y;
            const x3 = s[o + 6] - x;
            const y3 = s[o + 7] - y;
            const d = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
            if (d === 0) continue; // seen edge-on: no crossing
            const w1 = x2 * y3 - x3 * y2;
            const w2 = x3 * y1 - x1 * y3;
            const w3 = x1 * y2 - x2 * y1;
            const inside = d > 0 ? w1 >= 0 && w2 >= 0 && w3 >= 0 : w1 <= 0 && w2 <= 0 && w3 <= 0;
            if (!inside) continue;
            // a weight of exactly zero puts the ray on an edge: the answer is not to be trusted
            if (w1 === 0 || w2 === 0 || w3 === 0) return undefined;
            const zc = (w1 * s[o + 2] + w2 * s[o + 5] + w3 * s[o + 8]) / d;
            if (zc > z) up++;
            else if (zc < z) down++;
            else return undefined; // the point lies on the surface
        }
        const a = (up & 1) === 1;
        const b = (down & 1) === 1;
        return a === b ? a : undefined;
    }
}
