// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { cross, dot, normalize, sub, type TriMesh, type Vec3, vertex } from "./mesh";
import { MeshInside } from "./meshInside";
import type { PlannedExtrude } from "./plan";
import { type Primitive, type Segment, surfaceNormal } from "./segment";
import type { SliceFrame } from "./slices";

/**
 * Holes read off the mesh's faces, in whatever direction they run: a concave cylinder or cone
 * that goes (nearly) all the way round its axis is a hole's wall, a countersink, a counterbore's
 * or a drill tip's; the walls on one axis stack into one hole, each wall cut as an extrude of its
 * exact circle (a cone tapered) — so a side hole the slices along the main axis cannot see, or a
 * countersink in another face, is one feature with its true diameter.
 */

/** One hole: the cuts along its axis, widest end first, and their volume. */
export interface HoleCut {
    readonly axis: Vec3;
    readonly plans: PlannedExtrude[];
    readonly volume: number;
    readonly label: string;
}

/** Share of the turn round its axis a wall must cover to be a hole's (not a concave round's). */
const MIN_COVERAGE = 0.85;
const BINS = 72;

interface Wall {
    /** Heights along the hole's axis (from its origin), low < high. */
    lo: number;
    hi: number;
    /** Radius at `lo` and at `hi`. */
    rLo: number;
    rHi: number;
}

function basis(a: Vec3): [Vec3, Vec3] {
    const e1 = normalize(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
    return [e1, cross(a, e1)];
}

function axisOf(p: Primitive): { axis: Vec3; origin: Vec3 } | undefined {
    if (p.kind === "cylinder") return { axis: p.axis, origin: p.point };
    if (p.kind === "cone") return { axis: p.axis, origin: p.apex };
    return undefined;
}

/** The radius of a cylinder or cone at height `h` along `a` from `o` (`a` parallel to its axis). */
function radiusAt(p: Primitive, o: Vec3, a: Vec3, h: number): number {
    if (p.kind === "cylinder") return p.radius;
    if (p.kind !== "cone") return 0;
    const hApex = dot(sub(p.apex, o), a);
    const s = Math.sign(dot(p.axis, a));
    return (h - hApex) * s * Math.tan(p.angle);
}

/** Whether the segment's facets face its axis (material outside: a hole) and go round it. */
function holeWall(mesh: TriMesh, s: Segment): boolean {
    const ax = axisOf(s.primitive);
    if (ax === undefined) return false;
    const t = mesh.triangles;
    let facing = 0;
    let area = 0;
    const [e1, e2] = basis(ax.axis);
    const bins = new Uint8Array(BINS);
    for (const k of s.triangles) {
        const ps = [0, 1, 2].map((j) => vertex(mesh, t[3 * k + j]));
        const c: Vec3 = [
            (ps[0][0] + ps[1][0] + ps[2][0]) / 3,
            (ps[0][1] + ps[1][1] + ps[2][1]) / 3,
            (ps[0][2] + ps[1][2] + ps[2][2]) / 3,
        ];
        const n: Vec3 = [mesh.normals[3 * k], mesh.normals[3 * k + 1], mesh.normals[3 * k + 2]];
        const w = mesh.areas[k];
        // the primitive's normal points away from the axis: a hole's facets face against it
        facing += dot(n, surfaceNormal(s.primitive, c)) * w;
        area += w;
        // the turn the facet spans round the axis
        const angles = ps.map((p) => {
            const d = sub(p, ax.origin);
            return Math.atan2(dot(d, e2), dot(d, e1));
        });
        let from = angles[0];
        let to = angles[0];
        for (const x of angles.slice(1)) {
            let d = x - angles[0];
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            from = Math.min(from, angles[0] + d);
            to = Math.max(to, angles[0] + d);
        }
        const step = (2 * Math.PI) / BINS;
        for (let x = Math.floor(from / step); x * step < to; x++) bins[((x % BINS) + BINS) % BINS] = 1;
    }
    if (!(area > 0) || facing / area > -0.5) return false;
    return bins.reduce((a, b) => a + b, 0) >= BINS * MIN_COVERAGE;
}

/**
 * The mesh's holes from its segments (`segmentMesh`); `soup` is the mesh as a triangle soup (for
 * telling an open end from a blind one), `tol` the fit tolerance.
 */
export function primitiveHoles(
    mesh: TriMesh,
    soup: ArrayLike<number>,
    segments: readonly Segment[],
    tol: number,
    frameFor: (axis: Vec3) => SliceFrame,
): HoleCut[] {
    const walls = segments.filter((s) => holeWall(mesh, s));
    if (walls.length === 0) return [];
    const inside = new MeshInside(soup);
    const t = mesh.triangles;
    // walls on one axis: parallel within ~1°, each one's axis through the other's
    const groups: { axis: Vec3; origin: Vec3; walls: Segment[] }[] = [];
    const near = Math.max(tol * 10, 0.02);
    for (const w of walls) {
        const ax = axisOf(w.primitive)!;
        const group = groups.find((g) => {
            if (Math.abs(dot(g.axis, ax.axis)) < Math.cos(Math.PI / 180)) return false;
            const d = sub(ax.origin, g.origin);
            const h = dot(d, g.axis);
            return Math.hypot(d[0] - h * g.axis[0], d[1] - h * g.axis[1], d[2] - h * g.axis[2]) <= near;
        });
        if (group !== undefined) group.walls.push(w);
        else groups.push({ axis: ax.axis, origin: ax.origin, walls: [w] });
    }
    const out: HoleCut[] = [];
    for (const g of groups) {
        const a = g.axis;
        const o = g.origin;
        const pieces: Wall[] = [];
        for (const w of g.walls) {
            let lo = Number.POSITIVE_INFINITY;
            let hi = Number.NEGATIVE_INFINITY;
            for (const k of w.triangles)
                for (let j = 0; j < 3; j++) {
                    const h = dot(sub(vertex(mesh, t[3 * k + j]), o), a);
                    lo = Math.min(lo, h);
                    hi = Math.max(hi, h);
                }
            if (!(hi - lo > tol)) continue;
            pieces.push({
                lo,
                hi,
                rLo: radiusAt(w.primitive, o, a, lo),
                rHi: radiusAt(w.primitive, o, a, hi),
            });
        }
        if (pieces.length === 0) continue;
        pieces.sort((x, y) => x.lo - y.lo);
        const step = Math.max(tol * 10, 0.05);
        // the walls that touch end to end are one hole; apart (the two arms of a clip) two
        const stacks: Wall[][] = [];
        for (const p of pieces) {
            const last = stacks[stacks.length - 1];
            if (last !== undefined && p.lo <= Math.max(...last.map((x) => x.hi)) + step) last.push(p);
            else stacks.push([p]);
        }
        const stackCut = (pieces: Wall[]): HoleCut | undefined => {
            const joined = (h: number, self: Wall) =>
                pieces.some((p) => p !== self && (Math.abs(p.lo - h) <= step || Math.abs(p.hi - h) <= step));
            /** Air just past the end at `h` (going `dir`), across most of its circle. */
            const open = (h: number, r: number, dir: number) => {
                if (r <= tol * 10) return false;
                const [e1, e2] = basis(a);
                const z = h + dir * Math.max(tol * 4, 0.05);
                for (let i = 0; i < 6; i++) {
                    const ang = (i * Math.PI) / 3;
                    const p: Vec3 = [
                        o[0] + a[0] * z + (e1[0] * Math.cos(ang) + e2[0] * Math.sin(ang)) * r * 0.9,
                        o[1] + a[1] * z + (e1[1] * Math.cos(ang) + e2[1] * Math.sin(ang)) * r * 0.9,
                        o[2] + a[2] * z + (e1[2] * Math.cos(ang) + e2[2] * Math.sin(ang)) * r * 0.9,
                    ];
                    if (inside.contains(p[0], p[1], p[2]) !== false) return false;
                }
                return true;
            };
            const plans: PlannedExtrude[] = [];
            let volume = 0;
            const radii: string[] = [];
            for (const p of pieces) {
                const span = p.hi - p.lo;
                const ext = Math.max(span * 0.05, 0.5);
                const slope = (p.rHi - p.rLo) / span;
                const lo = !joined(p.lo, p) && open(p.lo, p.rLo, -1) ? p.lo - ext : p.lo;
                const hi = !joined(p.hi, p) && open(p.hi, p.rHi, 1) ? p.hi + ext : p.hi;
                const rLo = p.rLo + slope * (lo - p.lo);
                const rHi = p.rHi + slope * (hi - p.hi);
                if (!(rLo > 0 && rHi >= 0) || !(Math.max(rLo, rHi) > tol * 2)) continue;
                const depth = hi - lo;
                // drawn at its wide end, tapering (positive narrows toward the end) to the other
                const up = rLo >= rHi;
                const axis: Vec3 = up ? a : [-a[0], -a[1], -a[2]];
                const frame0 = frameFor(axis);
                const frame: SliceFrame = { axis, xvec: frame0.xvec, yvec: cross(axis, frame0.xvec) };
                const wide = up ? rLo : rHi;
                const narrow = up ? rHi : rLo;
                const draft = (Math.atan((wide - narrow) / depth) * 180) / Math.PI;
                const base = up ? dot(o, a) + lo : -(dot(o, a) + hi);
                plans.push({
                    frame,
                    base,
                    depth,
                    profiles: [
                        { kind: "circle", c: [dot(o, frame.xvec), dot(o, frame.yvec)], r: wide, ccw: true },
                    ],
                    operation: "cut",
                    role: "hole",
                    ...(draft >= 0.05 ? { draft } : {}),
                });
                volume += (Math.PI * depth * (rLo * rLo + rLo * rHi + rHi * rHi)) / 3;
                radii.push(
                    draft >= 0.05
                        ? `cone ${(2 * wide).toFixed(2)}→${(2 * narrow).toFixed(2)}`
                        : `Ø${(2 * wide).toFixed(3)}`,
                );
            }
            if (plans.length === 0) return undefined;
            return {
                axis: a,
                plans,
                volume,
                label: `${a.map((x) => x.toFixed(2)).join(",")} ${radii.join(" + ")}`,
            };
        };
        for (const stack of stacks) {
            const cut = stackCut(stack);
            if (cut !== undefined) out.push(cut);
        }
    }
    return out.sort((x, y) => y.volume - x.volume);
}
