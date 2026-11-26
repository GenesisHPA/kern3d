// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { cross, dot, normalize, sub, type TriMesh, type Vec3, vertex } from "./mesh";
import { type Primitive, primitiveDistance, type Segment, surfaceNormal } from "./segment";

/**
 * The part with its rounds and chamfers taken off: a narrow cylinder or torus band tangent to
 * two larger faces is a fillet, a narrow plane meeting two faces at a bend that adds up to
 * theirs is a chamfer; each band's vertices are moved onto the sharp edge its two faces make (the
 * nearest point on both surfaces), so the band collapses and its faces run on to a sharp corner.
 * The slabs planned on that mesh have sharp edges where the part is rounded; the rounds come back
 * as fillet and chamfer features with the band's own size — the cylinder's radius as the STL's
 * vertices give it, not a staircase of slabs.
 */

/** A round or chamfer of the part, as the sharp edge it replaces. */
export interface RoundBand {
    readonly kind: "fillet" | "chamfer";
    /** Radius, or the chamfer's (equal) distance, mm. */
    readonly size: number;
    /** The faces the sharp edge lies on. */
    readonly supports: readonly Primitive[];
    /** The band's facets collapsed onto the sharp edge: segments along it. */
    readonly edge: readonly (readonly [Vec3, Vec3])[];
    /** The segment the band was. */
    readonly segment: number;
}

export interface Sharpened {
    readonly mesh: TriMesh;
    readonly bands: readonly RoundBand[];
}

/** Largest bend between a fillet band's facets and a face it is tangent to (a facet step). */
const TANGENT = (25 * Math.PI) / 180;
/** A chamfer meets each of its faces at a bend in this range. */
const CHAMFER_MIN = (12 * Math.PI) / 180;
const CHAMFER_MAX = (70 * Math.PI) / 180;
const BINS = 72;

function basis(a: Vec3): [Vec3, Vec3] {
    const e1 = normalize(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
    return [e1, cross(a, e1)];
}

/** Share of the turn the segment covers: round a cylinder's axis, round a torus's tube. */
function sweep(mesh: TriMesh, s: Segment): number {
    const p = s.primitive;
    let angle: (v: Vec3) => number;
    if (p.kind === "cylinder") {
        const [e1, e2] = basis(p.axis);
        angle = (v) => {
            const d = sub(v, p.point);
            return Math.atan2(dot(d, e2), dot(d, e1));
        };
    } else if (p.kind === "torus") {
        angle = (v) => {
            const d = sub(v, p.center);
            const h = dot(d, p.axis);
            const rho = Math.hypot(d[0] - h * p.axis[0], d[1] - h * p.axis[1], d[2] - h * p.axis[2]);
            return Math.atan2(h, rho - p.major);
        };
    } else return 1;
    const bins = new Uint8Array(BINS);
    const step = (2 * Math.PI) / BINS;
    const t = mesh.triangles;
    for (const k of s.triangles) {
        const a = [0, 1, 2].map((j) => angle(vertex(mesh, t[3 * k + j])));
        let from = a[0];
        let to = a[0];
        for (const x of a.slice(1)) {
            let d = x - a[0];
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            from = Math.min(from, a[0] + d);
            to = Math.max(to, a[0] + d);
        }
        for (let x = Math.floor(from / step); x * step < to; x++) bins[((x % BINS) + BINS) % BINS] = 1;
    }
    return bins.reduce((a, b) => a + b, 0) / BINS;
}

/** The point nearest `p` on every one of the surfaces (alternating projections), or undefined. */
export function onAll(p: Vec3, surfaces: readonly Primitive[], tol: number): Vec3 | undefined {
    let x = p;
    for (let it = 0; it < 200; it++) {
        let worst = 0;
        for (const s of surfaces) {
            const d = primitiveDistance(s, x);
            worst = Math.max(worst, Math.abs(d));
            const n = surfaceNormal(s, x);
            x = [x[0] - d * n[0], x[1] - d * n[1], x[2] - d * n[2]];
        }
        if (worst <= tol * 1e-6) break;
    }
    return surfaces.every((s) => Math.abs(primitiveDistance(s, x)) <= tol) ? x : undefined;
}

interface Candidate {
    readonly segment: Segment;
    /** A corner: the blend where rounds meet, collapsed with them (no feature of its own). */
    readonly kind: "fillet" | "chamfer" | "corner";
    /** The fillet's radius (the chamfer's distance comes from the moves). */
    readonly radius: number;
    readonly supports: readonly number[];
}

/** Whether the segment is a band, and the two faces it stands between. */
function candidateOf(
    mesh: TriMesh,
    s: Segment,
    segments: readonly Segment[],
    tol: number,
): Candidate | undefined {
    const p = s.primitive;
    const solid = (i: number) => segments[i].primitive.kind !== "free";
    const total = s.borders.reduce((a, b) => a + b.length, 0);
    if (!(total > 0)) return undefined;
    if (p.kind === "cylinder" || p.kind === "torus") {
        const r = p.kind === "cylinder" ? p.radius : p.minor;
        if (!(r >= tol * 10 && r <= mesh.size * 0.1)) return undefined;
        const turn = sweep(mesh, s) * 2 * Math.PI;
        if (turn > Math.PI || turn < (15 * Math.PI) / 180) return undefined;
        const tangent = s.borders
            .filter((b) => b.angle <= TANGENT && solid(b.other) && b.length >= total * 0.1)
            .sort((a, b) => b.length - a.length);
        if (tangent.length < 2) return undefined;
        // the two faces bend into each other by the round's own turn: two faces in one plane
        // with a half-round between them are a groove, not a rounded edge
        const pa = segments[tangent[0].other].primitive;
        const pb = segments[tangent[1].other].primitive;
        if (pa.kind === "plane" && pb.kind === "plane") {
            const bend = Math.acos(Math.max(-1, Math.min(1, dot(pa.normal, pb.normal))));
            if (Math.abs(bend - turn) > Math.max((15 * Math.PI) / 180, turn * 0.3)) return undefined;
        }
        return { segment: s, kind: "fillet", radius: r, supports: [tangent[0].other, tangent[1].other] };
    }
    if (p.kind === "plane") {
        const sides = s.borders
            .filter((b) => b.angle >= CHAMFER_MIN && b.angle <= CHAMFER_MAX && solid(b.other))
            .sort((a, b) => b.length - a.length);
        if (sides.length < 2) return undefined;
        const [a, b] = sides;
        // two long sides, on either side of a narrow face, bent the same way
        if (
            a.length + b.length < total * 0.6 ||
            Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.3
        )
            return undefined;
        if (Math.round(a.convex) !== Math.round(b.convex)) return undefined;
        const width = s.area / ((a.length + b.length) / 2);
        if (width > 0.5 * Math.min(a.length, b.length) || width > mesh.size * 0.08) return undefined;
        // the faces' own bend is the chamfer's two together
        const pa = segments[a.other].primitive;
        const pb = segments[b.other].primitive;
        if (pa.kind !== "plane" || pb.kind !== "plane") return undefined;
        const bend = Math.acos(Math.max(-1, Math.min(1, dot(pa.normal, pb.normal))));
        if (Math.abs(bend - (a.angle + b.angle)) > (8 * Math.PI) / 180) return undefined;
        return { segment: s, kind: "chamfer", radius: 0, supports: [a.other, b.other] };
    }
    return undefined;
}

/**
 * The mesh with its rounds and chamfers collapsed onto their sharp edges, and the bands; undefined
 * when there is none.
 */
export function sharpenMesh(mesh: TriMesh, segments: readonly Segment[], tol: number): Sharpened | undefined {
    let candidates = segments
        .map((s) => candidateOf(mesh, s, segments, tol))
        .filter((c): c is Candidate => c !== undefined);
    // a band's face must not be a band itself
    const bandIds = new Set(candidates.map((c) => c.segment.id));
    candidates = candidates.filter((c) => c.supports.every((x) => !bandIds.has(x)));
    if (candidates.length === 0) return undefined;
    // the blends where rounds meet (a ball at a box's corner): small, between bands only
    const byId = new Map(candidates.map((c) => [c.segment.id, c]));
    for (const s of segments) {
        if (byId.has(s.id) || s.primitive.kind === "plane") continue;
        const near = s.borders.map((b) => byId.get(b.other));
        if (near.length < 2 || near.some((c) => c === undefined)) continue;
        const supports = [...new Set(near.flatMap((c) => c!.supports))];
        if (supports.length < 2) continue;
        const radius = Math.max(...near.map((c) => c!.radius));
        if (!(s.area <= Math.max(...near.map((c) => c!.segment.area)))) continue;
        candidates.push({ segment: s, kind: "corner", radius: radius || mesh.size * 0.02, supports });
    }
    const t = mesh.triangles;
    const eps = Math.max(tol * 2, 1e-4);
    for (let round = 0; round < 8 && candidates.length > 0; round++) {
        // a corner goes with the rounds it joins: none of them left out
        const live = new Set(candidates.filter((c) => c.kind !== "corner").map((c) => c.segment.id));
        candidates = candidates.filter(
            (c) => c.kind !== "corner" || c.segment.borders.every((b) => live.has(b.other)),
        );
        if (live.size === 0) return undefined;
        // every band a vertex is in: it goes onto all their faces at once (a corner of two rounds)
        const supportsOf = new Map<number, Set<number>>();
        const bandsOf = new Map<number, Candidate[]>();
        for (const c of candidates)
            for (const k of c.segment.triangles)
                for (let j = 0; j < 3; j++) {
                    const v = t[3 * k + j];
                    let set = supportsOf.get(v);
                    if (set === undefined) {
                        set = new Set();
                        supportsOf.set(v, set);
                    }
                    for (const x of c.supports) set.add(x);
                    let list = bandsOf.get(v);
                    if (list === undefined) {
                        list = [];
                        bandsOf.set(v, list);
                    }
                    if (!list.includes(c)) list.push(c);
                }
        const moved = new Map<number, Vec3>();
        const failed = new Set<Candidate>();
        for (const [v, set] of supportsOf) {
            const p = vertex(mesh, v);
            const q = onAll(
                p,
                [...set].map((x) => segments[x].primitive),
                eps,
            );
            const reach = Math.max(
                ...bandsOf.get(v)!.map((c) => (c.kind === "chamfer" ? mesh.size * 0.1 : c.radius * 4)),
            );
            if (q === undefined || Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) > reach) {
                for (const c of bandsOf.get(v)!) failed.add(c);
            } else moved.set(v, q);
        }
        if (failed.size > 0) {
            candidates = candidates.filter((c) => !failed.has(c));
            continue;
        }
        // the bands, sized
        const bands: RoundBand[] = [];
        const keep: Candidate[] = [];
        for (const c of candidates) {
            if (c.kind === "corner") {
                keep.push(c);
                continue;
            }
            let size = c.radius;
            if (c.kind === "chamfer") {
                // each leg: how far the band's vertices on that face moved
                const legs = c.supports.map((x) => {
                    const prim = segments[x].primitive;
                    const ds: number[] = [];
                    for (const k of c.segment.triangles)
                        for (let j = 0; j < 3; j++) {
                            const v = t[3 * k + j];
                            const p = vertex(mesh, v);
                            if (Math.abs(primitiveDistance(prim, p)) > eps) continue;
                            const q = moved.get(v)!;
                            ds.push(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
                        }
                    ds.sort((a, b) => a - b);
                    return ds.length > 0 ? ds[Math.floor(ds.length / 2)] : 0;
                });
                if (!(legs[0] > tol * 4 && legs[1] > tol * 4)) continue;
                if (Math.abs(legs[0] - legs[1]) > Math.max(legs[0], legs[1]) * 0.2) continue;
                size = (legs[0] + legs[1]) / 2;
            }
            const edge: [Vec3, Vec3][] = [];
            for (const k of c.segment.triangles)
                for (let j = 0; j < 3; j++) {
                    const a = moved.get(t[3 * k + j])!;
                    const b = moved.get(t[3 * k + ((j + 1) % 3)])!;
                    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > eps) edge.push([a, b]);
                }
            if (edge.length === 0) continue;
            keep.push(c);
            bands.push({
                kind: c.kind as "fillet" | "chamfer",
                size: Number.parseFloat(size.toFixed(4)),
                supports: c.supports.map((x) => segments[x].primitive),
                edge,
                segment: c.segment.id,
            });
        }
        if (bands.length === 0) return undefined;
        if (keep.length < candidates.length) {
            // an unequal chamfer stays as it is: its vertices go back
            candidates = keep;
            continue;
        }
        return { mesh: movedMesh(mesh, moved, tol * 0.1), bands };
    }
    return undefined;
}

/**
 * The mesh with some vertices moved, its topology kept: moved vertices landing on one point (a
 * round's cross-section collapsing onto its sharp edge) become one, the triangles that collapse
 * with them go, and a triangle flattened onto a line stays (with no area) — dropping it would
 * open a crack along the edge, and a section through a cracked mesh is no loop.
 */
function movedMesh(mesh: TriMesh, moved: ReadonlyMap<number, Vec3>, merge: number): TriMesh {
    // the projections land within a whisker of each other where they should be one point
    const step = Math.max(merge, 1e-9);
    const cell = (x: number) => Math.floor(x / step);
    const grid = new Map<string, number[]>();
    const count = mesh.positions.length / 3;
    const ids = new Int32Array(count);
    const positions: number[] = [];
    const near = (q: Vec3): number => {
        const [cx, cy, cz] = [cell(q[0]), cell(q[1]), cell(q[2])];
        for (let dx = -1; dx <= 1; dx++)
            for (let dy = -1; dy <= 1; dy++)
                for (let dz = -1; dz <= 1; dz++)
                    for (const o of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
                        const d = Math.hypot(
                            positions[3 * o] - q[0],
                            positions[3 * o + 1] - q[1],
                            positions[3 * o + 2] - q[2],
                        );
                        if (d <= merge) return o;
                    }
        return -1;
    };
    for (let v = 0; v < count; v++) {
        const q = moved.get(v);
        if (q === undefined) {
            ids[v] = positions.length / 3;
            positions.push(mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2]);
            continue;
        }
        let id = near(q);
        if (id < 0) {
            id = positions.length / 3;
            positions.push(q[0], q[1], q[2]);
            const k = `${cell(q[0])},${cell(q[1])},${cell(q[2])}`;
            grid.set(k, [...(grid.get(k) ?? []), id]);
        }
        ids[v] = id;
    }
    const triangles: number[] = [];
    const normals: number[] = [];
    const areas: number[] = [];
    const p = (i: number): Vec3 => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
    for (let k = 0; k < mesh.triangles.length; k += 3) {
        const a = ids[mesh.triangles[k]];
        const b = ids[mesh.triangles[k + 1]];
        const c = ids[mesh.triangles[k + 2]];
        if (a === b || b === c || a === c) continue;
        const n = cross(sub(p(b), p(a)), sub(p(c), p(a)));
        const double = Math.hypot(n[0], n[1], n[2]);
        triangles.push(a, b, c);
        normals.push(...(double > 0 ? [n[0] / double, n[1] / double, n[2] / double] : [0, 0, 0]));
        areas.push(double / 2);
    }
    return {
        positions: Float64Array.from(positions),
        triangles: Uint32Array.from(triangles),
        normals: Float64Array.from(normals),
        areas: Float64Array.from(areas),
        size: mesh.size,
    };
}

function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const s = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
    return Math.hypot(p[0] - a[0] - s * ab[0], p[1] - a[1] - s * ab[1], p[2] - a[2] - s * ab[2]);
}

/**
 * The band whose sharp edge an edge of the rebuilt body is: every sample on both of the band's
 * faces and along its collapsed facets. -1 when none.
 */
export function bandOfEdge(bands: readonly RoundBand[], samples: readonly Vec3[], tol: number): number {
    const reach = Math.max(tol * 20, 0.05);
    return bands.findIndex(
        (band) =>
            samples.every((p) => band.supports.every((s) => Math.abs(primitiveDistance(s, p)) <= reach)) &&
            samples.every((p) =>
                band.edge.some(([a, b]) => segmentDistance(p, a, b) <= reach + band.size * 0.05),
            ),
    );
}
