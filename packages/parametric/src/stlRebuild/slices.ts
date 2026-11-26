// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    anyPerpendicular,
    cross,
    dot,
    normalize,
    normalOf,
    sub,
    type TriMesh,
    type Vec3,
    vertex,
} from "./mesh";

import { regionAxes } from "./regions";

/** Normals within ~0.5° of the axis are caps; within ~0.5° of its plane, walls. */
const AXIS_TOL = Math.sin((0.5 * Math.PI) / 180);
const CAP_COS = Math.cos((0.5 * Math.PI) / 180);

/** A direction to slice along and the in-plane x the sketches are drawn in. */
export interface SliceFrame {
    readonly axis: Vec3;
    readonly xvec: Vec3;
    readonly yvec: Vec3;
}

export function isCap(normal: Vec3, axis: Vec3): boolean {
    return Math.abs(dot(normal, axis)) >= CAP_COS;
}

export function isWall(normal: Vec3, axis: Vec3): boolean {
    return Math.abs(dot(normal, axis)) <= AXIS_TOL;
}

/** Share of the surface that is caps or walls for `axis` (1 = the part is a pure extrusion). */
export function prismaticShare(mesh: TriMesh, axis: Vec3): { caps: number; walls: number } {
    let caps = 0;
    let walls = 0;
    let total = 0;
    for (let t = 0; t < mesh.areas.length; t++) {
        const area = mesh.areas[t];
        const n = normalOf(mesh, t);
        total += area;
        if (isCap(n, axis)) caps += area;
        else if (isWall(n, axis)) walls += area;
    }
    return total > 0 ? { caps: caps / total, walls: walls / total } : { caps: 0, walls: 0 };
}

/**
 * The flat directions of the mesh, largest area first: triangle normals clustered within ~0.5°
 * (± the same), each with the area of its cluster. These are the candidates for the slice axis
 * (a face normal) and for the sketch x (a wall normal).
 */
export function planarDirections(mesh: TriMesh, limit = 12): { dir: Vec3; area: number }[] {
    const clusters: { dir: Vec3; sum: [number, number, number]; area: number }[] = [];
    const order = [...mesh.areas.keys()].sort((a, b) => mesh.areas[b] - mesh.areas[a]);
    for (const t of order) {
        const n = normalOf(mesh, t);
        const area = mesh.areas[t];
        const cluster = clusters.find((c) => Math.abs(dot(c.dir, n)) >= CAP_COS);
        if (cluster !== undefined) {
            const s = Math.sign(dot(cluster.dir, n));
            cluster.sum[0] += s * n[0] * area;
            cluster.sum[1] += s * n[1] * area;
            cluster.sum[2] += s * n[2] * area;
            cluster.area += area;
        } else if (clusters.length < 400) {
            clusters.push({ dir: n, sum: [n[0] * area, n[1] * area, n[2] * area], area });
        }
    }
    return clusters
        .map((c) => ({ dir: normalize(c.sum), area: c.area }))
        .sort((a, b) => b.area - a.area)
        .slice(0, limit);
}

const WORLD: Vec3[] = [
    [0, 0, 1],
    [0, 1, 0],
    [1, 0, 0],
];

/** The frame for `axis`: x along the largest wall direction square to it, world-aligned when it is one. */
export function frameFor(mesh: TriMesh, axis: Vec3, flats = planarDirections(mesh)): SliceFrame {
    const wall = flats.find(({ dir }) => isWall(dir, axis));
    let xvec: Vec3 = wall
        ? normalize(cross(cross(axis, wall.dir), axis))
        : (WORLD.find((w) => isWall(w, axis)) ?? anyPerpendicular(axis));
    const worldX = WORLD.find((w) => Math.abs(dot(w, xvec)) > 1 - 1e-9);
    if (worldX !== undefined) xvec = worldX;
    // the x must be square to the axis exactly, so the sketch plane is a true frame
    xvec = normalize(cross(cross(axis, xvec), axis));
    if (dot(xvec, xvec) === 0) xvec = anyPerpendicular(axis);
    return { axis, xvec, yvec: cross(axis, xvec) };
}

/**
 * The slice frames to try, best first: every candidate axis (the world axes and the mesh's
 * large flat directions) scored by how much of the surface is caps or walls along it.
 */
export function sliceFrames(mesh: TriMesh): SliceFrame[] {
    const flats = planarDirections(mesh);
    const candidates: Vec3[] = [...WORLD];
    // the flat faces' normals, then the axes the curved regions' sides name (an oblique boss
    // or hole whose faces are not among the large flat ones)
    const directions = [
        ...flats.map((f) => f.dir),
        ...regionAxes(
            mesh,
            flats.map((f) => f.dir),
        ),
    ];
    for (const dir of directions) {
        if (!candidates.some((c) => Math.abs(dot(c, dir)) > 0.9999)) candidates.push(dir);
    }
    const scored = candidates.map((axis, i) => {
        const share = prismaticShare(mesh, axis);
        // a world axis wins a near tie: parts are usually modelled square to the world
        return { axis, score: share.caps + share.walls + (i < 3 ? 1e-3 : 0) };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map(({ axis }) => frameFor(mesh, axis, flats));
}

/** More cap heights than this along an axis and it is not one to slice along. */
export const MAX_LEVELS = 200;

/** A closed section loop in the frame's (u, v): counter-clockwise around material. */
export type Loop2D = [number, number][];

export interface Slab {
    /** Heights along the axis (bottom < top). */
    readonly bottom: number;
    readonly top: number;
    /** The section loops through the slab (outer CCW, holes CW). */
    readonly loops: Loop2D[];
    /** Share of the slab's side surface that is neither a cap nor a wall (chamfers, drafts, fillets). */
    readonly slanted: number;
}

/** Heights of the mesh along `axis` where a cap lies, plus its two ends, merged within `tol`. */
export function levels(mesh: TriMesh, axis: Vec3, tol: number): number[] {
    const heights: number[] = [];
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < mesh.positions.length / 3; i++) {
        const h = dot(vertex(mesh, i), axis);
        min = Math.min(min, h);
        max = Math.max(max, h);
    }
    heights.push(min, max);
    const t = mesh.triangles;
    for (let k = 0; k < mesh.areas.length; k++) {
        if (isCap(normalOf(mesh, k), axis)) heights.push(dot(vertex(mesh, t[3 * k]), axis));
    }
    // where straight walls give way to leaning ones (a round's or chamfer's band, a cone): the
    // ends of every run of heights the leaning triangles cover
    const runs: [number, number][] = [];
    for (let k = 0; k < mesh.areas.length; k++) {
        const n = normalOf(mesh, k);
        if (isCap(n, axis) || isWall(n, axis)) continue;
        const z = [0, 1, 2].map((j) => dot(vertex(mesh, t[3 * k + j]), axis));
        runs.push([Math.min(...z), Math.max(...z)]);
    }
    runs.sort((a, b) => a[0] - b[0]);
    let run: [number, number] | undefined;
    for (const r of runs) {
        if (run !== undefined && r[0] <= run[1] + tol) {
            run[1] = Math.max(run[1], r[1]);
            continue;
        }
        if (run !== undefined) heights.push(run[0], run[1]);
        run = [r[0], r[1]];
    }
    if (run !== undefined) heights.push(run[0], run[1]);
    heights.sort((a, b) => a - b);
    const merged: number[] = [];
    for (const h of heights) {
        if (merged.length === 0 || h - merged[merged.length - 1] > tol) merged.push(h);
    }
    return merged;
}

/**
 * The mesh cut by the plane at height `h` along the frame's axis, as closed loops in (u, v).
 * Each crossing triangle gives one segment, oriented so the material is on its left; segments
 * chain through the mesh edges they cross. A chain that does not close (a mesh with holes) is
 * dropped. `h` should not pass through a vertex; `sectionAt` picks one that does not.
 */
export function sectionLoops(mesh: TriMesh, frame: SliceFrame, h: number): Loop2D[] {
    const { axis, xvec, yvec } = frame;
    const t = mesh.triangles;
    const n = mesh.positions.length / 3;
    const heights = new Float64Array(n);
    for (let i = 0; i < n; i++) heights[i] = dot(vertex(mesh, i), axis) - h;
    const next = new Map<
        string,
        { to: string; point: [number, number]; toPoint: [number, number]; exact: boolean }
    >();
    /** An edge along the axis crosses the plane at a true surface point, not on a facet's chord. */
    const alongAxis = (a: number, b: number) => {
        const d = sub(vertex(mesh, b), vertex(mesh, a));
        const h = dot(d, axis);
        return (
            Math.hypot(d[0] - axis[0] * h, d[1] - axis[1] * h, d[2] - axis[2] * h) <= 1e-9 * (1 + mesh.size)
        );
    };
    const pointOn = (a: number, b: number): [number, number] => {
        const s = heights[a] / (heights[a] - heights[b]);
        const pa = vertex(mesh, a);
        const pb = vertex(mesh, b);
        const p: Vec3 = [
            pa[0] + (pb[0] - pa[0]) * s,
            pa[1] + (pb[1] - pa[1]) * s,
            pa[2] + (pb[2] - pa[2]) * s,
        ];
        return [dot(p, xvec), dot(p, yvec)];
    };
    const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
    for (let k = 0; k < mesh.areas.length; k++) {
        // a facet flattened onto a line (a sharpened round's) bounds nothing: the walk steps over
        // it by position below
        if (!(mesh.areas[k] > 0)) continue;
        const v = [t[3 * k], t[3 * k + 1], t[3 * k + 2]];
        const crossings: { key: string; point: [number, number]; exact: boolean; down: boolean }[] = [];
        for (let e = 0; e < 3; e++) {
            const a = v[e];
            const b = v[(e + 1) % 3];
            if (heights[a] < 0 !== heights[b] < 0) {
                crossings.push({
                    key: edgeKey(a, b),
                    point: pointOn(a, b),
                    exact: alongAxis(a, b),
                    down: heights[b] < 0,
                });
            }
        }
        if (crossings.length !== 2) continue;
        // material on the left (the segment along axis × normal): from the edge the winding takes
        // down through the plane to the one it takes up — the winding's say, so a facet flattened
        // onto a line (no normal: a round collapsed onto its sharp edge) still chains
        const [p, q] = crossings;
        const [from, to] = p.down ? [p, q] : [q, p];
        next.set(from.key, { to: to.key, point: from.point, toPoint: to.point, exact: from.exact });
    }
    const loops: Loop2D[] = [];
    const used = new Set<string>();
    // where the edges do not chain (a mesh whose facets meet edge to edge only in position: a
    // sharpened round's line), a segment goes on from the one that starts where it ended
    const joinTol = Math.max(mesh.size * 1e-8, 1e-12);
    const cell = (p: readonly [number, number]) =>
        `${Math.round(p[0] / (joinTol * 4))},${Math.round(p[1] / (joinTol * 4))}`;
    let starts: Map<string, string[]> | undefined;
    const startingAt = (p: readonly [number, number]): string | undefined => {
        if (starts === undefined) {
            starts = new Map();
            for (const [k, v] of next) {
                const c = cell(v.point);
                starts.set(c, [...(starts.get(c) ?? []), k]);
            }
        }
        const cx = Math.round(p[0] / (joinTol * 4));
        const cy = Math.round(p[1] / (joinTol * 4));
        for (let dx = -1; dx <= 1; dx++)
            for (let dy = -1; dy <= 1; dy++)
                for (const k of starts.get(`${cx + dx},${cy + dy}`) ?? []) {
                    const q = next.get(k)!.point;
                    if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= joinTol && !used.has(k)) return k;
                }
        return undefined;
    };
    for (const start of next.keys()) {
        if (used.has(start)) continue;
        const loop: Loop2D = [];
        const exact: boolean[] = [];
        let key = start;
        let closed = false;
        const startPoint = next.get(start)!.point;
        while (!used.has(key)) {
            const step = next.get(key);
            if (step === undefined) break;
            used.add(key);
            loop.push(step.point);
            exact.push(step.exact);
            key = step.to;
            if (key === start) {
                closed = true;
                break;
            }
            if (!next.has(key) || used.has(key)) {
                if (Math.hypot(step.toPoint[0] - startPoint[0], step.toPoint[1] - startPoint[1]) <= joinTol) {
                    closed = true;
                    break;
                }
                const jump = startingAt(step.toPoint);
                if (jump === undefined) break;
                key = jump;
            }
        }
        if (!closed || loop.length < 3) continue;
        // on a straight wall every other point is where the plane crossed a facet's diagonal:
        // on the chord, short of a curved wall's true surface — dropped between two exact ones
        const kept = loop.filter(
            (_, i) =>
                exact[i] || !(exact[(i + loop.length - 1) % loop.length] && exact[(i + 1) % loop.length]),
        );
        loops.push(kept.length >= 3 ? kept : loop);
    }
    return loops;
}

/** The section loops at a height near `h`, nudged off any vertex. */
export function sectionAt(mesh: TriMesh, frame: SliceFrame, h: number, span: number): Loop2D[] {
    const eps = Math.max(span * 1e-6, 1e-9);
    const n = mesh.positions.length / 3;
    for (const shift of [0, 0.0137, -0.0219, 0.0311, -0.0423, 0.0517]) {
        const height = h + shift * span;
        let clear = true;
        for (let i = 0; i < n && clear; i++) {
            if (Math.abs(dot(vertex(mesh, i), frame.axis) - height) < eps) clear = false;
        }
        if (clear) return sectionLoops(mesh, frame, height);
    }
    return sectionLoops(mesh, frame, h + 0.0617 * span);
}

/** Signed area of a loop (positive counter-clockwise). */
export function loopArea(loop: Loop2D): number {
    let a = 0;
    for (let i = 0; i < loop.length; i++) {
        const [x1, y1] = loop[i];
        const [x2, y2] = loop[(i + 1) % loop.length];
        a += x1 * y2 - x2 * y1;
    }
    return a / 2;
}

/**
 * The part as slabs along the frame's axis: one between every two neighbouring cap heights,
 * with its section loops, and how much of its side is slanted (not a straight wall).
 */
export function slabsOf(mesh: TriMesh, frame: SliceFrame): Slab[] {
    const tol = Math.max(mesh.size * 1e-5, 1e-4);
    const hs = levels(mesh, frame.axis, tol);
    // a part cut across its curves (a disc sliced edge-on) splits into hundreds of slabs: no
    // feature tree anyone would want, and the sections alone run the heap out — not this axis
    if (hs.length > MAX_LEVELS) return [];
    const slabs: Slab[] = [];
    const t = mesh.triangles;
    const zs = new Float64Array(mesh.positions.length / 3);
    for (let i = 0; i < zs.length; i++) zs[i] = dot(vertex(mesh, i), frame.axis);
    for (let i = 0; i + 1 < hs.length; i++) {
        const bottom = hs[i];
        const top = hs[i + 1];
        const span = top - bottom;
        let slanted = 0;
        let side = 0;
        for (let k = 0; k < mesh.areas.length; k++) {
            const normal = normalOf(mesh, k);
            if (isCap(normal, frame.axis)) continue;
            const z0 = zs[t[3 * k]];
            const z1 = zs[t[3 * k + 1]];
            const z2 = zs[t[3 * k + 2]];
            const lo = Math.min(z0, z1, z2);
            const hi = Math.max(z0, z1, z2);
            const overlap = Math.min(hi, top) - Math.max(lo, bottom);
            if (overlap <= tol) continue;
            const share = (mesh.areas[k] * overlap) / Math.max(hi - lo, tol);
            side += share;
            if (!isWall(normal, frame.axis)) slanted += share;
        }
        const loops = sectionAt(mesh, frame, (bottom + top) / 2, span).filter(
            (loop) => Math.abs(loopArea(loop)) > tol * tol,
        );
        slabs.push({ bottom, top, loops, slanted: side > 0 ? slanted / side : 0 });
    }
    return slabs;
}
