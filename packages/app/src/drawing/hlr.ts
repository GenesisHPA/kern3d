// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Vec3 } from "./drawingData";
import type { ViewBasis } from "./viewBasis";

/**
 * Hidden-line removal for drawing views, done in TypeScript on top of the kernel's
 * triangulation (the wasm build exposes OCCT's HLR only as visible sharp edges, without the
 * hidden set or the outlines of curved faces).
 *
 * - Every B-rep edge is sampled into a 3D polyline and projected; each sample is tested for
 *   occlusion against the projected triangle mesh (is any triangle in front of it by more
 *   than a depth tolerance?), and the polyline is split where the answer changes — the split
 *   point found by bisection.
 * - Outlines (silhouettes) of curved faces are the zero set of n·w over the face's mesh,
 *   interpolated per triangle from the exact vertex normals and pushed from the chord back
 *   onto the arc the two normals describe, so a cylinder's outline lands on the cylinder and
 *   not on its facets.
 * - A hidden line drawn over a visible one is dropped (a visible line always wins), and so is
 *   an outline that runs along an edge.
 *
 * Precision: occlusion is decided against the mesh, so near a curved occluder the answer can
 * be off by the mesh sag (relative deflection 0.005 of the face size), and a split point is
 * exact to the bisection step (~1/1000 of the sample spacing). Lines closer than ~0.1 % of the
 * view size to a visible line are treated as coincident with it.
 */

export interface HlrEdge {
    /** Sampled points along the edge, in model space. */
    points: Vec3[];
    /** The edge joins two faces tangentially (a fillet boundary): drawn only on request. */
    tangent: boolean;
    circle?: { center: Vec3; axis: Vec3; radius: number };
}

/** A face of the mesh: `count` entries of `index` starting at `start`, three per triangle. */
export interface HlrFace {
    start: number;
    count: number;
}

export interface HlrInput {
    position: Float32Array | Float64Array;
    normal: Float32Array | Float64Array;
    index: Uint32Array;
    faces: HlrFace[];
    edges: HlrEdge[];
}

export interface Arc2 {
    cx: number;
    cy: number;
    r: number;
    /** Radians, counter-clockwise from +x. */
    start: number;
    /** Signed sweep, radians; ±2π for a full circle. */
    sweep: number;
}

export interface Polyline2 {
    /** Flat x, y pairs in the view's model 2D frame. */
    points: number[];
    arc?: Arc2;
}

export interface Circle2 {
    cx: number;
    cy: number;
    r: number;
}

/** A cylinder-like axis seen from the side: the line its coaxial circles project onto. */
export interface Axis2 {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

export interface Bounds2 {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export interface ViewGeometry {
    visible: Polyline2[];
    hidden: Polyline2[];
    tangent: Polyline2[];
    /** Circles whose axis points at the viewer, for centre marks and diameter dimensions. */
    circles: Circle2[];
    axes: Axis2[];
    /** Flat x, y pairs: edge end points and circle centres, the snap targets of a dimension. */
    vertices: number[];
    bounds: Bounds2;
}

export interface HlrOptions {
    hidden: boolean;
    tangent: boolean;
}

type P3 = [number, number, number];

function project(basis: ViewBasis, p: ArrayLike<number>, offset = 0): P3 {
    const x = p[offset];
    const y = p[offset + 1];
    const z = p[offset + 2];
    return [
        x * basis.u[0] + y * basis.u[1] + z * basis.u[2],
        x * basis.v[0] + y * basis.v[1] + z * basis.v[2],
        x * basis.w[0] + y * basis.w[1] + z * basis.w[2],
    ];
}

function lerp3(a: P3, b: P3, t: number): P3 {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function emptyBounds(): Bounds2 {
    return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function grow(bounds: Bounds2, x: number, y: number) {
    if (x < bounds.minX) bounds.minX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y > bounds.maxY) bounds.maxY = y;
}

/** Uniform 2D grid over projected triangles, answering "is anything in front of this point?". */
class OccluderGrid {
    private readonly cells: number[][];
    private readonly nx: number;
    private readonly ny: number;
    private readonly cellW: number;
    private readonly cellH: number;

    constructor(
        private readonly p: Float64Array,
        private readonly tris: Uint32Array,
        private readonly bounds: Bounds2,
    ) {
        const triCount = tris.length / 3;
        const n = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(triCount))));
        this.nx = n;
        this.ny = n;
        this.cellW = Math.max(1e-9, (bounds.maxX - bounds.minX) / n);
        this.cellH = Math.max(1e-9, (bounds.maxY - bounds.minY) / n);
        this.cells = Array.from({ length: n * n }, () => []);
        for (let t = 0; t < triCount; t++) this.insert(t);
    }

    private cellX(x: number) {
        return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.bounds.minX) / this.cellW)));
    }

    private cellY(y: number) {
        return Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.bounds.minY) / this.cellH)));
    }

    private insert(t: number) {
        const [a, b, c] = [this.tris[t * 3], this.tris[t * 3 + 1], this.tris[t * 3 + 2]];
        const p = this.p;
        const area =
            (p[b * 3] - p[a * 3]) * (p[c * 3 + 1] - p[a * 3 + 1]) -
            (p[c * 3] - p[a * 3]) * (p[b * 3 + 1] - p[a * 3 + 1]);
        const size = Math.max(this.bounds.maxX - this.bounds.minX, this.bounds.maxY - this.bounds.minY);
        if (Math.abs(area) <= 1e-12 * size * size) return; // edge-on: hides nothing
        const x0 = this.cellX(Math.min(p[a * 3], p[b * 3], p[c * 3]));
        const x1 = this.cellX(Math.max(p[a * 3], p[b * 3], p[c * 3]));
        const y0 = this.cellY(Math.min(p[a * 3 + 1], p[b * 3 + 1], p[c * 3 + 1]));
        const y1 = this.cellY(Math.max(p[a * 3 + 1], p[b * 3 + 1], p[c * 3 + 1]));
        for (let i = x0; i <= x1; i++) {
            for (let j = y0; j <= y1; j++) this.cells[j * this.nx + i].push(t);
        }
    }

    occluded(x: number, y: number, z: number, tolerance: number): boolean {
        if (x < this.bounds.minX || x > this.bounds.maxX || y < this.bounds.minY || y > this.bounds.maxY) {
            return false;
        }
        const cell = this.cells[this.cellY(y) * this.nx + this.cellX(x)];
        for (const t of cell) {
            if (this.inFront(t, x, y, z, tolerance)) return true;
        }
        return false;
    }

    private inFront(t: number, x: number, y: number, z: number, tolerance: number): boolean {
        const p = this.p;
        const a = this.tris[t * 3] * 3;
        const b = this.tris[t * 3 + 1] * 3;
        const c = this.tris[t * 3 + 2] * 3;
        const area = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[c] - p[a]) * (p[b + 1] - p[a + 1]);
        const l1 = ((p[b] - x) * (p[c + 1] - y) - (p[c] - x) * (p[b + 1] - y)) / area;
        const l2 = ((p[c] - x) * (p[a + 1] - y) - (p[a] - x) * (p[c + 1] - y)) / area;
        const l3 = 1 - l1 - l2;
        const eps = -1e-7;
        if (l1 < eps || l2 < eps || l3 < eps) return false;
        const depth = l1 * p[a + 2] + l2 * p[b + 2] + l3 * p[c + 2];
        return depth > z + tolerance;
    }
}

/** Uniform grid of 2D segments, answering "is a line within `tolerance` of this point?". */
class SegmentIndex {
    private readonly cells = new Map<number, number[]>();
    private readonly segments: number[] = [];

    constructor(
        private readonly cell: number,
        private readonly tolerance: number,
    ) {}

    private key(i: number, j: number) {
        return i * 1_000_003 + j;
    }

    add(polylines: readonly Polyline2[]) {
        for (const line of polylines) {
            for (let k = 0; k + 3 < line.points.length; k += 2) {
                this.addSegment(line.points[k], line.points[k + 1], line.points[k + 2], line.points[k + 3]);
            }
        }
    }

    private addSegment(x1: number, y1: number, x2: number, y2: number) {
        const id = this.segments.length / 4;
        this.segments.push(x1, y1, x2, y2);
        const t = this.tolerance;
        const i0 = Math.floor((Math.min(x1, x2) - t) / this.cell);
        const i1 = Math.floor((Math.max(x1, x2) + t) / this.cell);
        const j0 = Math.floor((Math.min(y1, y2) - t) / this.cell);
        const j1 = Math.floor((Math.max(y1, y2) + t) / this.cell);
        for (let i = i0; i <= i1; i++) {
            for (let j = j0; j <= j1; j++) {
                const key = this.key(i, j);
                let list = this.cells.get(key);
                if (list === undefined) {
                    list = [];
                    this.cells.set(key, list);
                }
                list.push(id);
            }
        }
    }

    /**
     * Whether a line through (x, y) heading (dx, dy) runs along an indexed segment: within
     * the tolerance of it, parallel to it, and not past either of its ends. Lines that merely
     * meet one (at a corner, or end to end) are not covered by it.
     */
    near(x: number, y: number, dx: number, dy: number): boolean {
        const list = this.cells.get(this.key(Math.floor(x / this.cell), Math.floor(y / this.cell)));
        if (list === undefined) return false;
        const s = this.segments;
        const dl = Math.hypot(dx, dy);
        for (const id of list) {
            const x1 = s[id * 4];
            const y1 = s[id * 4 + 1];
            const sx = s[id * 4 + 2] - x1;
            const sy = s[id * 4 + 3] - y1;
            const sl = Math.hypot(sx, sy);
            if (sl === 0 || dl === 0) continue;
            if (Math.abs(sx * dy - sy * dx) / (sl * dl) > 0.05) continue;
            const t = ((x - x1) * sx + (y - y1) * sy) / (sl * sl);
            if (t < 0 || t > 1) continue;
            if (Math.abs((x - x1) * sy - (y - y1) * sx) / sl <= this.tolerance) return true;
        }
        return false;
    }
}

export function pointSegmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Splits a polyline into maximal runs over which `test` holds, refining every change of
 * answer by bisection on the segment it falls in. `test` is evaluated on 3D (projected)
 * points so occlusion can read the depth.
 */
type PointTest = (p: P3, dx: number, dy: number) => boolean;

function splitBy(points: P3[], test: PointTest, wanted: boolean): P3[][] {
    const runs: P3[][] = [];
    let current: P3[] | undefined;
    const direction = (i: number): [number, number] => {
        const a = points[Math.max(0, i - 1)];
        const b = points[Math.max(1, i)];
        return [b[0] - a[0], b[1] - a[1]];
    };
    let previous = test(points[0], ...direction(0));
    if (previous === wanted) current = [points[0]];
    for (let i = 1; i < points.length; i++) {
        const state = test(points[i], ...direction(i));
        if (state !== previous) {
            const split = bisect(points[i - 1], points[i], previous, test);
            if (current !== undefined) {
                current.push(split);
                runs.push(current);
                current = undefined;
            } else {
                current = [split];
            }
        }
        if (state === wanted) current?.push(points[i]);
        previous = state;
    }
    if (current !== undefined && current.length > 1) runs.push(current);
    return runs.filter((run) => run.length > 1);
}

function bisect(a: P3, b: P3, stateA: boolean, test: PointTest): P3 {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2;
        if (test(lerp3(a, b, mid), dx, dy) === stateA) lo = mid;
        else hi = mid;
    }
    return lerp3(a, b, (lo + hi) / 2);
}

function densify(points: P3[], step: number): P3[] {
    const result: P3[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
        for (let k = 1; k <= n; k++) result.push(lerp3(a, b, k / n));
    }
    return result;
}

function length2(points: P3[]): number {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    }
    return total;
}

/**
 * A point between two mesh vertices, moved off the chord onto the circular arc their exact
 * normals describe — the surface the mesh approximates, to second order.
 */
export function curvedPoint(a: P3, b: P3, na: P3, nb: P3, t: number): P3 {
    const p = lerp3(a, b, t);
    const cos = Math.max(-1, Math.min(1, na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]));
    const alpha = Math.acos(cos);
    if (alpha < 1e-6 || alpha > Math.PI / 2) return p;
    // Only the part of the chord along which the normal turns is curved (a cylinder's
    // diagonal facet edge is straight along the axis): measure the chord in that direction.
    const dn: P3 = [nb[0] - na[0], nb[1] - na[1], nb[2] - na[2]];
    const dnLength = Math.hypot(dn[0], dn[1], dn[2]);
    const spread = dn[0] * (b[0] - a[0]) + dn[1] * (b[1] - a[1]) + dn[2] * (b[2] - a[2]);
    const chord = Math.abs(spread) / dnLength;
    if (chord === 0) return p;
    const radius = chord / (2 * Math.sin(alpha / 2));
    const half = chord * (t - 0.5);
    const lift = Math.sqrt(Math.max(0, radius * radius - half * half)) - radius * Math.cos(alpha / 2);
    const n = lerp3(na, nb, t);
    const nl = Math.hypot(n[0], n[1], n[2]);
    if (nl === 0) return p;
    // Normals that spread apart along the chord belong to a surface bulging toward them.
    const sign = spread >= 0 ? 1 : -1;
    return [
        p[0] + (sign * lift * n[0]) / nl,
        p[1] + (sign * lift * n[1]) / nl,
        p[2] + (sign * lift * n[2]) / nl,
    ];
}

interface ProjectedMesh {
    p: Float64Array;
    n: Float64Array;
    bounds: Bounds2;
    depthRange: number;
}

function projectMesh(input: HlrInput, basis: ViewBasis): ProjectedMesh {
    const count = input.position.length / 3;
    const p = new Float64Array(count * 3);
    const n = new Float64Array(count * 3);
    const bounds = emptyBounds();
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
        const q = project(basis, input.position, i * 3);
        p.set(q, i * 3);
        n.set(project(basis, input.normal, i * 3), i * 3);
        grow(bounds, q[0], q[1]);
        minZ = Math.min(minZ, q[2]);
        maxZ = Math.max(maxZ, q[2]);
    }
    return { p, n, bounds, depthRange: Number.isFinite(maxZ - minZ) ? maxZ - minZ : 0 };
}

interface Segment3 {
    keyA: string;
    keyB: string;
    a: P3;
    b: P3;
}

function crossing(mesh: ProjectedMesh, i: number, j: number, gi: number, gj: number): [string, P3] {
    const t = gi / (gi - gj);
    const vec = (k: number, arr: Float64Array): P3 => [arr[k * 3], arr[k * 3 + 1], arr[k * 3 + 2]];
    const point = curvedPoint(vec(i, mesh.p), vec(j, mesh.p), vec(i, mesh.n), vec(j, mesh.n), t);
    return [i < j ? `${i}_${j}` : `${j}_${i}`, point];
}

function faceSilhouetteSegments(input: HlrInput, mesh: ProjectedMesh, face: HlrFace): Segment3[] {
    const idx = input.index;
    const first = idx[face.start];
    const segments: Segment3[] = [];
    let planar = true;
    for (let k = face.start; k < face.start + face.count && planar; k++) {
        const v = idx[k];
        const d =
            mesh.n[v * 3] * mesh.n[first * 3] +
            mesh.n[v * 3 + 1] * mesh.n[first * 3 + 1] +
            mesh.n[v * 3 + 2] * mesh.n[first * 3 + 2];
        if (d < 0.999999) planar = false;
    }
    if (planar) return segments;
    for (let k = face.start; k + 2 < face.start + face.count; k += 3) {
        const v = [idx[k], idx[k + 1], idx[k + 2]];
        const g = v.map((i) => mesh.n[i * 3 + 2]);
        if (Math.max(Math.abs(g[0]), Math.abs(g[1]), Math.abs(g[2])) < 1e-4) continue;
        // A vertex on the outline itself (|g| ~ 0, e.g. on a seam whose two copies carry
        // opposite round-off) counts as back-facing, so exactly one side reports the crossing.
        const s = g.map((x) => x > 1e-9);
        if (s[0] === s[1] && s[1] === s[2]) continue;
        const hits: [string, P3][] = [];
        for (const [i, j] of [
            [0, 1],
            [1, 2],
            [2, 0],
        ]) {
            if (s[i] !== s[j]) hits.push(crossing(mesh, v[i], v[j], g[i], g[j]));
        }
        if (hits.length === 2)
            segments.push({ keyA: hits[0][0], a: hits[0][1], keyB: hits[1][0], b: hits[1][1] });
    }
    return segments;
}

/** Chains segments sharing crossing keys into polylines. */
function chainSegments(segments: Segment3[]): P3[][] {
    const byKey = new Map<string, number[]>();
    segments.forEach((s, i) => {
        for (const key of [s.keyA, s.keyB]) {
            const list = byKey.get(key);
            if (list === undefined) byKey.set(key, [i]);
            else list.push(i);
        }
    });
    const used = new Uint8Array(segments.length);
    const chains: P3[][] = [];
    const extend = (chain: P3[], key: string, atEnd: boolean) => {
        let current = key;
        for (;;) {
            const next = byKey.get(current)?.find((i) => used[i] === 0);
            if (next === undefined) return;
            used[next] = 1;
            const s = segments[next];
            const [point, nextKey] = s.keyA === current ? [s.b, s.keyB] : [s.a, s.keyA];
            if (atEnd) chain.push(point);
            else chain.unshift(point);
            current = nextKey;
        }
    };
    segments.forEach((s, i) => {
        if (used[i]) return;
        used[i] = 1;
        const chain: P3[] = [s.a, s.b];
        extend(chain, s.keyB, true);
        extend(chain, s.keyA, false);
        chains.push(chain);
    });
    return chains;
}

interface RawLine {
    points: P3[];
    circle?: Circle2;
}

interface Classified {
    visible: RawLine[];
    hidden: RawLine[];
}

function toPolyline(points: readonly P3[], circle?: Circle2): Polyline2 {
    const flat: number[] = [];
    for (const p of points) flat.push(p[0], p[1]);
    return circle === undefined ? { points: flat } : { points: flat, arc: arcThrough(flat, circle) };
}

/** The arc of `circle` a polyline runs along, start angle and signed sweep from its points. */
export function arcThrough(points: number[], circle: Circle2): Arc2 {
    const angle = (k: number) => Math.atan2(points[k + 1] - circle.cy, points[k] - circle.cx);
    const start = angle(0);
    let previous = start;
    let sweep = 0;
    for (let k = 2; k < points.length; k += 2) {
        const a = angle(k);
        let delta = a - previous;
        if (delta > Math.PI) delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        sweep += delta;
        previous = a;
    }
    if (Math.abs(Math.abs(sweep) - 2 * Math.PI) < 1e-3) sweep = Math.sign(sweep) * 2 * Math.PI;
    return { cx: circle.cx, cy: circle.cy, r: circle.r, start, sweep };
}

/** Removes the parts of `lines` that run within the index's tolerance of an indexed line. */
function subtractCovered(lines: RawLine[], index: SegmentIndex, step: number, minLength: number): RawLine[] {
    const result: RawLine[] = [];
    for (const line of lines) {
        const dense = densify(line.points, step);
        for (const run of splitBy(dense, (p, dx, dy) => index.near(p[0], p[1], dx, dy), false)) {
            if (length2(run) > minLength) result.push({ points: run, circle: line.circle });
        }
    }
    return result;
}

/** Drops interior points that lie on the line through their neighbours. */
function simplify(points: P3[], tolerance: number): P3[] {
    if (points.length <= 2) return points;
    const result: P3[] = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
        const a = result[result.length - 1];
        const c = points[i + 1];
        if (pointSegmentDistance(points[i][0], points[i][1], a[0], a[1], c[0], c[1]) > tolerance) {
            result.push(points[i]);
        }
    }
    result.push(points[points.length - 1]);
    return result;
}

interface Context {
    basis: ViewBasis;
    grid: OccluderGrid;
    depthTolerance: number;
    step: number;
    tolerance2D: number;
}

function classify(lines: RawLine[], context: Context): Classified {
    const result: Classified = { visible: [], hidden: [] };
    const hiddenTest = (p: P3) => context.grid.occluded(p[0], p[1], p[2], context.depthTolerance);
    for (const line of lines) {
        if (length2(line.points) <= context.tolerance2D) continue;
        const dense = densify(line.points, context.step);
        for (const run of splitBy(dense, hiddenTest, false)) {
            if (length2(run) > context.tolerance2D) result.visible.push({ points: run, circle: line.circle });
        }
        for (const run of splitBy(dense, hiddenTest, true)) {
            if (length2(run) > context.tolerance2D) result.hidden.push({ points: run, circle: line.circle });
        }
    }
    return result;
}

function edgeLine(edge: HlrEdge, basis: ViewBasis): RawLine {
    const points = edge.points.map((p) => project(basis, p));
    const c = edge.circle;
    if (c === undefined) return { points };
    const facing = Math.abs(c.axis[0] * basis.w[0] + c.axis[1] * basis.w[1] + c.axis[2] * basis.w[2]);
    if (facing < 0.9999) return { points };
    const center = project(basis, c.center);
    return { points, circle: { cx: center[0], cy: center[1], r: c.radius } };
}

function dedupeCircles(circles: Circle2[], tolerance: number): Circle2[] {
    const result: Circle2[] = [];
    for (const c of circles) {
        const same = result.some(
            (x) => Math.hypot(x.cx - c.cx, x.cy - c.cy) <= tolerance && Math.abs(x.r - c.r) <= tolerance,
        );
        if (!same) result.push(c);
    }
    return result;
}

/** Coaxial circles seen edge-on: one centre line per axis, spanning their projected centres. */
function sideAxes(edges: HlrEdge[], basis: ViewBasis, tolerance: number): Axis2[] {
    const groups: { dx: number; dy: number; points: [number, number][] }[] = [];
    for (const edge of edges) {
        const c = edge.circle;
        if (c === undefined) continue;
        const facing = c.axis[0] * basis.w[0] + c.axis[1] * basis.w[1] + c.axis[2] * basis.w[2];
        if (Math.abs(facing) > 1e-3) continue;
        const center = project(basis, c.center);
        const axis = project(basis, c.axis);
        const length = Math.hypot(axis[0], axis[1]);
        const dx = axis[0] / length;
        const dy = axis[1] / length;
        const group = groups.find((g) => {
            if (Math.abs(g.dx * dy - g.dy * dx) > 1e-3) return false;
            const [px, py] = g.points[0];
            return Math.abs((center[0] - px) * g.dy - (center[1] - py) * g.dx) <= tolerance;
        });
        if (group === undefined) groups.push({ dx, dy, points: [[center[0], center[1]]] });
        else group.points.push([center[0], center[1]]);
    }
    const axes: Axis2[] = [];
    for (const g of groups) {
        const ts = g.points.map(([x, y]) => x * g.dx + y * g.dy);
        const lo = Math.min(...ts);
        const hi = Math.max(...ts);
        if (hi - lo <= tolerance) continue;
        const [px, py] = g.points[0];
        const n = px * -g.dy + py * g.dx;
        const at = (t: number): [number, number] => [t * g.dx - n * g.dy, t * g.dy + n * g.dx];
        const [x1, y1] = at(lo);
        const [x2, y2] = at(hi);
        axes.push({ x1, y1, x2, y2 });
    }
    return axes;
}

function collectVertices(lines: RawLine[], circles: Circle2[], tolerance: number): number[] {
    const seen = new Set<string>();
    const result: number[] = [];
    const push = (x: number, y: number) => {
        const key = `${Math.round(x / tolerance)}_${Math.round(y / tolerance)}`;
        if (seen.has(key)) return;
        seen.add(key);
        result.push(x, y);
    };
    for (const line of lines) {
        const first = line.points[0];
        const last = line.points[line.points.length - 1];
        push(first[0], first[1]);
        push(last[0], last[1]);
    }
    for (const c of circles) push(c.cx, c.cy);
    return result;
}

/** Projects the input along `basis` and sorts every line into visible, hidden and tangent. */
export function computeViewGeometry(input: HlrInput, basis: ViewBasis, options: HlrOptions): ViewGeometry {
    const mesh = projectMesh(input, basis);
    const edgeLines = input.edges.filter((e) => !e.tangent).map((e) => edgeLine(e, basis));
    const tangentLines = input.edges.filter((e) => e.tangent).map((e) => edgeLine(e, basis));
    const silhouettes: RawLine[] = [];
    for (const face of input.faces) {
        for (const chain of chainSegments(faceSilhouetteSegments(input, mesh, face))) {
            silhouettes.push({ points: chain });
        }
    }

    const bounds = emptyBounds();
    for (const line of [...edgeLines, ...tangentLines, ...silhouettes]) {
        for (const p of line.points) grow(bounds, p[0], p[1]);
    }
    if (!Number.isFinite(bounds.minX)) {
        return { visible: [], hidden: [], tangent: [], circles: [], axes: [], vertices: [], bounds };
    }
    const meshBounds = { ...mesh.bounds };
    grow(meshBounds, bounds.minX, bounds.minY);
    grow(meshBounds, bounds.maxX, bounds.maxY);
    const size = Math.max(
        1e-6,
        Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, mesh.depthRange),
    );
    const context: Context = {
        basis,
        grid: new OccluderGrid(mesh.p, input.index, meshBounds),
        depthTolerance: size * 1e-3 + 1e-4,
        step: size / 400,
        tolerance2D: size * 1e-3 + 1e-6,
    };
    const minLength = context.tolerance2D * 2;
    const cell = Math.max(context.tolerance2D * 4, size / 128);

    const edges = classify(edgeLines, context);
    const outlines = classify(silhouettes, context);
    const tangents = options.tangent ? classify(tangentLines, context) : { visible: [], hidden: [] };

    const visibleIndex = new SegmentIndex(cell, context.tolerance2D);
    const asPolylines = (lines: RawLine[]) => lines.map((l) => toPolyline(l.points));
    // Visible edges drawn over one another (a back edge seen through a hole lining up with
    // the front one) are kept once: each is added minus what is already there.
    const visibleEdges: RawLine[] = [];
    for (const line of edges.visible) {
        const kept = subtractCovered([line], visibleIndex, context.step, minLength);
        visibleEdges.push(...kept);
        visibleIndex.add(asPolylines(kept));
    }
    const visibleOutlines = subtractCovered(outlines.visible, visibleIndex, context.step, minLength);
    visibleIndex.add(asPolylines(visibleOutlines));
    const visibleTangents = subtractCovered(tangents.visible, visibleIndex, context.step, minLength);
    visibleIndex.add(asPolylines(visibleTangents));

    let hidden: RawLine[] = [];
    if (options.hidden) {
        const hiddenEdges = subtractCovered(edges.hidden, visibleIndex, context.step, minLength);
        const hiddenIndex = new SegmentIndex(cell, context.tolerance2D);
        hiddenIndex.add(asPolylines(hiddenEdges));
        const hiddenOutlines = subtractCovered(
            subtractCovered(outlines.hidden, visibleIndex, context.step, minLength),
            hiddenIndex,
            context.step,
            minLength,
        );
        hidden = [...hiddenEdges, ...hiddenOutlines];
    }

    const finish = (lines: RawLine[]) =>
        lines.map((l) => toPolyline(simplify(l.points, context.tolerance2D * 0.01), l.circle));
    const circles = dedupeCircles(
        edgeLines.flatMap((l) => (l.circle === undefined ? [] : [l.circle])),
        context.tolerance2D,
    );
    return {
        visible: finish([...visibleEdges, ...visibleOutlines]),
        hidden: finish(hidden),
        tangent: finish(visibleTangents),
        circles,
        axes: sideAxes(input.edges, basis, context.tolerance2D),
        vertices: collectVertices([...edges.visible, ...edges.hidden], circles, context.tolerance2D),
        bounds,
    };
}
