// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { TriMesh } from "../stlRebuild/mesh";
import { estimateNoise, vertexRings } from "./noise";

/**
 * Clean-up for a real scan (a 3D scanner's or photogrammetry's mesh: millions of triangles,
 * noise, holes) before it is measured or fitted: welding the raw STL soup, decimation to a
 * target triangle count, light (non-shrinking) smoothing, and small holes filled. Plain arrays,
 * linear passes — a few seconds for a few million triangles.
 */

/** A mesh from positions and triangles: normals, areas and size computed. Degenerate triangles dropped. */
export function meshFrom(positions: Float64Array, triangles: ArrayLike<number>): TriMesh {
    const n = Math.floor(triangles.length / 3);
    const kept: number[] = [];
    const normals: number[] = [];
    const areas: number[] = [];
    const p = positions;
    for (let k = 0; k < n; k++) {
        const a = triangles[3 * k];
        const b = triangles[3 * k + 1];
        const c = triangles[3 * k + 2];
        if (a === b || b === c || a === c) continue;
        const ux = p[3 * b] - p[3 * a];
        const uy = p[3 * b + 1] - p[3 * a + 1];
        const uz = p[3 * b + 2] - p[3 * a + 2];
        const vx = p[3 * c] - p[3 * a];
        const vy = p[3 * c + 1] - p[3 * a + 1];
        const vz = p[3 * c + 2] - p[3 * a + 2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz);
        if (!(l > 0)) continue;
        kept.push(a, b, c);
        normals.push(nx / l, ny / l, nz / l);
        areas.push(l / 2);
    }
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], p[i + k]);
            max[k] = Math.max(max[k], p[i + k]);
        }
    }
    if (!Number.isFinite(min[0])) {
        min = [0, 0, 0];
        max = [0, 0, 0];
    }
    return {
        positions,
        triangles: Uint32Array.from(kept),
        normals: Float64Array.from(normals),
        areas: Float64Array.from(areas),
        size: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]),
    };
}

/** Integer cell coordinates as one number key (each axis below 2^17 cells, exact in a double). */
function cellKey(ix: number, iy: number, iz: number): number {
    return ix + iy * 131072 + iz * 17179869184;
}

/**
 * A triangle soup (9 numbers per triangle: an STL) welded: corners in one cell of `tol` become
 * one vertex. A numeric spatial hash, not string keys — a scan has millions of corners.
 */
export function weldSoup(soup: ArrayLike<number>, tol?: number): TriMesh {
    const count = Math.floor(soup.length / 3);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count * 3; i += 3) {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], soup[i + k]);
            max[k] = Math.max(max[k], soup[i + k]);
        }
    }
    if (count === 0) return meshFrom(new Float64Array(0), []);
    const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-9);
    const step = Math.max(tol ?? span * 1e-6, span / 131000);
    const index = new Map<number, number>();
    const positions: number[] = [];
    const ids = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
        const x = soup[3 * i];
        const y = soup[3 * i + 1];
        const z = soup[3 * i + 2];
        const key = cellKey(
            Math.round((x - min[0]) / step),
            Math.round((y - min[1]) / step),
            Math.round((z - min[2]) / step),
        );
        let id = index.get(key);
        if (id === undefined) {
            id = positions.length / 3;
            index.set(key, id);
            positions.push(x, y, z);
        }
        ids[i] = id;
    }
    return meshFrom(Float64Array.from(positions), ids);
}

/** Per vertex, its error quadric (10 numbers: the symmetric 4×4's upper triangle), area-weighted. */
function vertexQuadrics(mesh: TriMesh): Float64Array {
    const q = new Float64Array((mesh.positions.length / 3) * 10);
    const t = mesh.triangles;
    for (let k = 0; k < t.length / 3; k++) {
        const a = mesh.normals[3 * k];
        const b = mesh.normals[3 * k + 1];
        const c = mesh.normals[3 * k + 2];
        const v = t[3 * k];
        const d = -(
            a * mesh.positions[3 * v] +
            b * mesh.positions[3 * v + 1] +
            c * mesh.positions[3 * v + 2]
        );
        const w = mesh.areas[k];
        const plane = [a * a, a * b, a * c, a * d, b * b, b * c, b * d, c * c, c * d, d * d];
        for (let e = 0; e < 3; e++) {
            const o = t[3 * k + e] * 10;
            for (let m = 0; m < 10; m++) q[o + m] += plane[m] * w;
        }
    }
    return q;
}

/** The point minimising a quadric, or undefined when it is about singular (a flat or straight cluster). */
function quadricPoint(q: ArrayLike<number>, o: number): [number, number, number] | undefined {
    const [a, b, c, d, e, f, g, h, i] = [
        q[o],
        q[o + 1],
        q[o + 2],
        q[o + 4],
        q[o + 5],
        q[o + 7],
        q[o + 3],
        q[o + 6],
        q[o + 8],
    ];
    // | a b c | x = -| g |
    // | b d e |      | h |
    // | c e f |      | i |
    const det = a * (d * f - e * e) - b * (b * f - c * e) + c * (b * e - c * d);
    const scale = Math.max(a + d + f, 1e-300);
    if (Math.abs(det) < 1e-6 * scale * scale * scale) return undefined;
    const x = (-g * (d * f - e * e) + b * (h * f - e * i) - c * (h * e - d * i)) / det;
    const y = (a * (-h * f + e * i) + g * (b * f - c * e) - c * (b * i - c * h)) / det;
    const z = (a * (-d * i + e * h) - b * (-b * i + c * h) - g * (b * e - c * d)) / det;
    return [x, y, z];
}

/**
 * The mesh clustered on a grid of `cell`: every cell's vertices become one, placed where their
 * planes' error quadric is least (inside the cell's vertex box; their mean when the cluster is
 * flat), and the triangles left with three distinct corners kept (each once; a pair that is the
 * same triangle both ways round — a sheet thinner than a cell — dropped together).
 */
export function clusterMesh(mesh: TriMesh, cell: number): TriMesh {
    const nv = mesh.positions.length / 3;
    const p = mesh.positions;
    let mx = Infinity;
    let my = Infinity;
    let mz = Infinity;
    for (let v = 0; v < nv; v++) {
        mx = Math.min(mx, p[3 * v]);
        my = Math.min(my, p[3 * v + 1]);
        mz = Math.min(mz, p[3 * v + 2]);
    }
    const step = Math.max(cell, mesh.size / 131000);
    const cellOf = new Int32Array(nv);
    const cells = new Map<number, number>();
    for (let v = 0; v < nv; v++) {
        const key = cellKey(
            Math.floor((p[3 * v] - mx) / step),
            Math.floor((p[3 * v + 1] - my) / step),
            Math.floor((p[3 * v + 2] - mz) / step),
        );
        let id = cells.get(key);
        if (id === undefined) {
            id = cells.size;
            cells.set(key, id);
        }
        cellOf[v] = id;
    }
    const nc = cells.size;
    const vq = vertexQuadrics(mesh);
    const cq = new Float64Array(nc * 10);
    const sum = new Float64Array(nc * 3);
    const count = new Float64Array(nc);
    const lo = new Float64Array(nc * 3).fill(Infinity);
    const hi = new Float64Array(nc * 3).fill(-Infinity);
    for (let v = 0; v < nv; v++) {
        const c = cellOf[v];
        for (let m = 0; m < 10; m++) cq[c * 10 + m] += vq[v * 10 + m];
        count[c]++;
        for (let k = 0; k < 3; k++) {
            sum[3 * c + k] += p[3 * v + k];
            lo[3 * c + k] = Math.min(lo[3 * c + k], p[3 * v + k]);
            hi[3 * c + k] = Math.max(hi[3 * c + k], p[3 * v + k]);
        }
    }
    const positions = new Float64Array(nc * 3);
    for (let c = 0; c < nc; c++) {
        const best = quadricPoint(cq, c * 10);
        for (let k = 0; k < 3; k++) {
            const mean = sum[3 * c + k] / count[c];
            const x = best?.[k] ?? mean;
            // a quadric minimum outside the cluster's box is a near-degenerate one: clamp it
            positions[3 * c + k] = Math.min(
                hi[3 * c + k],
                Math.max(lo[3 * c + k], Number.isFinite(x) ? x : mean),
            );
        }
    }
    const t = mesh.triangles;
    const seen = new Map<string, number>();
    const out: number[] = [];
    for (let k = 0; k < t.length / 3; k++) {
        const a = cellOf[t[3 * k]];
        const b = cellOf[t[3 * k + 1]];
        const c = cellOf[t[3 * k + 2]];
        if (a === b || b === c || a === c) continue;
        const sorted = [a, b, c].sort((x, y) => x - y);
        const key = `${sorted[0]},${sorted[1]},${sorted[2]}`;
        const at = seen.get(key);
        if (at === undefined) {
            seen.set(key, out.length);
            out.push(a, b, c);
        } else if (at >= 0) {
            // the same triangle again: a sheet folded onto itself if the other way round
            const same = sameWinding([out[at], out[at + 1], out[at + 2]], [a, b, c]);
            if (!same) {
                out[at] = out[at + 1] = out[at + 2] = 0;
                seen.set(key, -1);
            }
        }
    }
    return meshFrom(positions, out);
}

function sameWinding(p: readonly number[], q: readonly number[]): boolean {
    const i = p.indexOf(q[0]);
    return p[(i + 1) % 3] === q[1];
}

/**
 * The mesh decimated to about `target` triangles: clustering (`clusterMesh`), the cell size
 * searched until the count lands within 10% of the target (a few passes). The mesh itself when
 * it is already at or below the target.
 */
export function decimate(mesh: TriMesh, target: number): TriMesh {
    const n = mesh.areas.length;
    if (n <= target || target < 4) return mesh;
    let area = 0;
    for (let k = 0; k < n; k++) area += mesh.areas[k];
    // a cell of side c leaves about 2·A/c² triangles on a surface of area A
    let cell = Math.sqrt((2 * area) / target);
    let best = clusterMesh(mesh, cell);
    for (let pass = 0; pass < 6; pass++) {
        const got = best.areas.length;
        if (Math.abs(got - target) <= target * 0.1) break;
        cell *= Math.sqrt(Math.max(got, 1) / target);
        const next = clusterMesh(mesh, cell);
        if (Math.abs(next.areas.length - target) < Math.abs(got - target)) best = next;
    }
    return best;
}

/**
 * Taubin smoothing (λ|μ): a shrinking Laplacian step then an inflating one, so the mesh loses
 * its noise but not its size. `iterations` pairs of steps; boundary vertices stay put.
 */
export function smoothMesh(mesh: TriMesh, iterations = 2, lambda = 0.5, mu = -0.53): TriMesh {
    if (iterations <= 0) return mesh;
    const { neighbours } = vertexRings(mesh);
    const boundary = boundaryVertices(mesh);
    let p = Float64Array.from(mesh.positions);
    const step = (factor: number) => {
        const next = Float64Array.from(p);
        for (let v = 0; v < neighbours.length; v++) {
            const ring = neighbours[v];
            if (ring.length === 0 || boundary[v]) continue;
            for (let k = 0; k < 3; k++) {
                let m = 0;
                for (const w of ring) m += p[3 * w + k];
                next[3 * v + k] = p[3 * v + k] + factor * (m / ring.length - p[3 * v + k]);
            }
        }
        p = next;
    };
    for (let i = 0; i < iterations; i++) {
        step(lambda);
        step(mu);
    }
    return meshFrom(p, mesh.triangles);
}

/** Directed boundary half-edges (an edge only one triangle has), as a map from its start to its end. */
function boundaryEdges(mesh: TriMesh): Map<number, number[]> {
    const t = mesh.triangles;
    const nv = mesh.positions.length / 3;
    const count = new Map<number, number>();
    for (let k = 0; k < t.length / 3; k++) {
        for (let e = 0; e < 3; e++) {
            const a = t[3 * k + e];
            const b = t[3 * k + ((e + 1) % 3)];
            const key = Math.min(a, b) * nv + Math.max(a, b);
            count.set(key, (count.get(key) ?? 0) + 1);
        }
    }
    const out = new Map<number, number[]>();
    for (let k = 0; k < t.length / 3; k++) {
        for (let e = 0; e < 3; e++) {
            const a = t[3 * k + e];
            const b = t[3 * k + ((e + 1) % 3)];
            if (count.get(Math.min(a, b) * nv + Math.max(a, b)) !== 1) continue;
            out.set(a, [...(out.get(a) ?? []), b]);
        }
    }
    return out;
}

function boundaryVertices(mesh: TriMesh): Uint8Array {
    const flags = new Uint8Array(mesh.positions.length / 3);
    for (const [a, ends] of boundaryEdges(mesh)) {
        flags[a] = 1;
        for (const b of ends) flags[b] = 1;
    }
    return flags;
}

/** The mesh's holes: closed chains of boundary edges, each in the order its triangles run them. */
export function boundaryLoops(mesh: TriMesh): number[][] {
    const next = boundaryEdges(mesh);
    const loops: number[][] = [];
    for (const start of [...next.keys()]) {
        while ((next.get(start)?.length ?? 0) > 0) {
            const loop = [start];
            let at = start;
            let closed = false;
            for (let guard = 0; guard < 1_000_000; guard++) {
                const ends = next.get(at);
                if (ends === undefined || ends.length === 0) break;
                const to = ends.shift()!;
                if (to === start) {
                    closed = true;
                    break;
                }
                loop.push(to);
                at = to;
            }
            if (closed && loop.length >= 3) loops.push(loop);
        }
    }
    return loops;
}

/**
 * Holes of at most `maxEdges` edges closed: a fan from a new vertex at the loop's centre (a
 * triangle for a three-edge hole), wound against the loop so the patch faces the way the
 * surface round it does. Returns the mended mesh and how many holes were filled / left open.
 */
export function fillHoles(mesh: TriMesh, maxEdges: number): { mesh: TriMesh; filled: number; left: number } {
    const loops = boundaryLoops(mesh);
    const positions = Array.from(mesh.positions);
    const triangles = Array.from(mesh.triangles);
    let filled = 0;
    for (const loop of loops) {
        if (loop.length > maxEdges) continue;
        filled++;
        // the loop runs as its neighbours' edges do; the patch runs each edge the other way
        if (loop.length === 3) {
            triangles.push(loop[0], loop[2], loop[1]);
            continue;
        }
        const c = positions.length / 3;
        const centre = [0, 0, 0];
        for (const v of loop)
            for (let k = 0; k < 3; k++) centre[k] += mesh.positions[3 * v + k] / loop.length;
        positions.push(...centre);
        for (let i = 0; i < loop.length; i++) triangles.push(loop[(i + 1) % loop.length], loop[i], c);
    }
    return { mesh: meshFrom(Float64Array.from(positions), triangles), filled, left: loops.length - filled };
}

export interface ScanPrepOptions {
    /** Triangles to decimate to (0: keep the count). */
    readonly targetTriangles: number;
    /** Taubin smoothing iterations (0: none). */
    readonly smoothing: number;
    /** Largest hole filled, in boundary edges (0: none). */
    readonly maxHoleEdges: number;
}

export interface ScanPrepReport {
    readonly trianglesBefore: number;
    readonly trianglesAfter: number;
    readonly holesFilled: number;
    readonly holesLeft: number;
    readonly noiseBefore: number;
    readonly noiseAfter: number;
}

/**
 * The whole clean-up, in order: holes filled and the noise smoothed on the full detail, then the
 * decimation — and the slivers of holes the clustering can tear where the surface was rough
 * (a fold dropped both ways round) filled after it.
 */
export function prepareScan(
    mesh: TriMesh,
    options: ScanPrepOptions,
): { mesh: TriMesh; report: ScanPrepReport } {
    const noiseBefore = estimateNoise(mesh);
    const holes =
        options.maxHoleEdges > 0
            ? fillHoles(mesh, options.maxHoleEdges)
            : { mesh, filled: 0, left: boundaryLoops(mesh).length };
    let out = smoothMesh(holes.mesh, options.smoothing);
    if (options.targetTriangles > 0 && out.areas.length > options.targetTriangles) {
        out = decimate(out, options.targetTriangles);
        // only tears the decimation made: holes the scan had and were left open stay open
        out = fillHoles(out, TEAR_EDGES).mesh;
    }
    return {
        mesh: out,
        report: {
            trianglesBefore: mesh.areas.length,
            trianglesAfter: out.areas.length,
            holesFilled: holes.filled,
            holesLeft: holes.left,
            noiseBefore,
            noiseAfter: estimateNoise(out),
        },
    };
}

/** A hole the decimation tore is a few edges round; a hole the scan had and was left open is larger. */
const TEAR_EDGES = 12;
