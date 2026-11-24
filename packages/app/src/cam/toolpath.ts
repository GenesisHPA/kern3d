// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CamTool } from "./camTools";
import { offsetRegion, oriented, type Pt, region, ringLength } from "./offset";

/**
 * 2.5D milling operations: a profile (a part cut out, on, outside or inside its outline), a
 * pocket (the inside cleared), an engraving (the tool along the lines) and drilling. The work's
 * top is Z 0, depths go down (negative Z), the stock's X Y as drawn.
 */
export const OPERATION_KINDS = ["profile", "pocket", "engrave", "drill"] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];
export const PROFILE_SIDES = ["outside", "inside", "on"] as const;
export type ProfileSide = (typeof PROFILE_SIDES)[number];

export interface Tabs {
    /** Bridges left on a profile so the part does not come loose; 0 — none. */
    count: number;
    /** Length along the outline and height above the bottom, mm. */
    width: number;
    height: number;
}

export interface CamOperation {
    id: string;
    name: string;
    kind: OperationKind;
    toolId: string;
    /** Total depth below the top, mm (positive). */
    depth: number;
    /** Overrides of the tool's cutting data; undefined — the tool's. */
    stepDown?: number;
    stepOver?: number;
    feed?: number;
    plunge?: number;
    rpm?: number;
    side: ProfileSide;
    /** Climb (the cutter's teeth meet the work as it moves forward) rather than conventional. */
    climb: boolean;
    /** Enter by ramping down along the path instead of plunging straight. */
    ramp: boolean;
    /** Left on the walls for a finishing pass, mm. */
    allowance: number;
    tabs: Tabs;
    /** Drilling: the depth of a peck before a retract to clear the chips; 0 — in one go. */
    peck: number;
    /** The outlines (closed rings) or lines; drilling: the hole centres. */
    rings: Pt[][];
    points: Pt[];
    hidden?: boolean;
}

export interface MillMove {
    type: "rapid" | "feed" | "plunge";
    x: number;
    y: number;
    z: number;
}

export interface Heights {
    /** Above everything: moves between features, mm. */
    safeZ: number;
    /** Just above the work: where a plunge starts at feed, mm. */
    clearance: number;
}

/** The ramp's slope, degrees: gentle enough for small cutters. */
const RAMP_DEG = 4;

export interface ResolvedCut {
    stepDown: number;
    stepOver: number;
    feed: number;
    plunge: number;
    rpm: number;
}

export function cutData(op: CamOperation, tool: CamTool): ResolvedCut {
    return {
        stepDown: Math.max(0.01, op.stepDown ?? tool.stepDown),
        stepOver: Math.max(0.01, Math.min(tool.diameter, op.stepOver ?? tool.stepOver)),
        feed: Math.max(1, op.feed ?? tool.feed),
        plunge: Math.max(1, op.plunge ?? tool.plunge),
        rpm: Math.max(0, op.rpm ?? tool.rpm),
    };
}

/** The pass depths (negative Z) from the first step down to the full depth, evenly. */
export function levels(depth: number, stepDown: number): number[] {
    const d = Math.max(0, depth);
    if (d === 0) return [];
    const n = Math.max(1, Math.ceil(d / Math.max(0.01, stepDown) - 1e-9));
    return Array.from({ length: n }, (_, i) => -(d * (i + 1)) / n);
}

class Path {
    readonly moves: MillMove[] = [];
    constructor(private readonly h: Heights) {}
    private last(): MillMove | undefined {
        return this.moves.at(-1);
    }
    push(type: MillMove["type"], x: number, y: number, z: number) {
        const l = this.last();
        if (
            l !== undefined &&
            Math.abs(l.x - x) < 1e-6 &&
            Math.abs(l.y - y) < 1e-6 &&
            Math.abs(l.z - z) < 1e-6
        )
            return;
        this.moves.push({ type, x, y, z });
    }
    /** Up to safe height, across, down to just above the work. */
    approach(p: Pt) {
        const l = this.last();
        if (l !== undefined) this.push("rapid", l.x, l.y, this.h.safeZ);
        this.push("rapid", p.x, p.y, this.h.safeZ);
        this.push("rapid", p.x, p.y, this.h.clearance);
    }
    retract() {
        const l = this.last();
        if (l !== undefined) this.push("rapid", l.x, l.y, this.h.safeZ);
    }
}

/** Where along a closed ring distance `s` falls (wrapping round). */
function pointAt(ring: Pt[], cumulative: number[], total: number, s: number): Pt {
    let d = ((s % total) + total) % total;
    let i = 0;
    while (i < ring.length - 1 && cumulative[i + 1] < d) i++;
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = cumulative[i + 1] - cumulative[i];
    d -= cumulative[i];
    const t = len > 0 ? Math.min(1, d / len) : 0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * One closed ring cut level by level: each level entered by a ramp along the ring (or a
 * plunge), then once round — the ramp's stretch cut again at full depth — and over the tabs
 * at their height.
 */
function cutRing(
    path: Path,
    ring: Pt[],
    zs: number[],
    opts: { ramp: boolean; from?: number; tabs?: { centres: number[]; half: number; top: number } },
) {
    const cumulative = [0];
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        cumulative.push(cumulative[i] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    const total = cumulative[ring.length];
    if (total <= 1e-6) return;
    const start = ring[0];
    path.approach(start);
    let z = opts.from ?? 0;
    // down at plunge feed to the top (or the last level cut), then ramp from there
    path.push("plunge", start.x, start.y, z);
    const inTab = (s: number) => {
        const t = opts.tabs;
        if (t === undefined) return false;
        const m = ((s % total) + total) % total;
        return t.centres.some(
            (c) =>
                Math.abs(m - c) <= t.half ||
                Math.abs(m - c - total) <= t.half ||
                Math.abs(m - c + total) <= t.half,
        );
    };
    // each level starts where the last one ended: no move back along the cut ring
    let s0 = 0;
    const local = (g: number) => (((g - s0) % total) + total) % total;
    for (const level of zs) {
        const rampLength = opts.ramp
            ? Math.min(total, (z - level) / Math.tan((RAMP_DEG * Math.PI) / 180))
            : 0;
        if (rampLength <= 1e-6) {
            const here = pointAt(ring, cumulative, total, s0);
            path.push("plunge", here.x, here.y, level);
        }
        // breakpoints (from this level's start): the ring's corners, the ramp's end, the tabs' edges
        const marks = new Set<number>([rampLength]);
        const edges = [...cumulative];
        if (opts.tabs !== undefined)
            for (const c of opts.tabs.centres) edges.push(c - opts.tabs.half, c + opts.tabs.half);
        for (const g of edges) for (const k of [0, 1]) marks.add(local(g) + k * total);
        const end = total + rampLength;
        const stops = [...marks].filter((x) => x > 1e-9 && x < end - 1e-9).sort((a, b) => a - b);
        stops.push(end);
        const depthAt = (x: number) => {
            const base = x < rampLength ? z + ((level - z) * x) / rampLength : level;
            return opts.tabs !== undefined && base < opts.tabs.top && inTab(x + s0) ? opts.tabs.top : base;
        };
        let prev = 0;
        let zNow = rampLength > 1e-6 ? z : level;
        for (const x of stops) {
            const len = x - prev;
            const zFrom = depthAt(prev + len * 1e-4);
            // a tab's edge: straight up or down where it starts
            if (Math.abs(zFrom - zNow) > 1e-6) {
                const q = pointAt(ring, cumulative, total, prev + s0);
                path.push("feed", q.x, q.y, zFrom);
            }
            const p = pointAt(ring, cumulative, total, x + s0);
            zNow =
                x <= rampLength + 1e-9
                    ? depthAt(Math.min(x, rampLength) - 1e-9 * 0)
                    : depthAt(x - len * 1e-4);
            if (x <= rampLength + 1e-9)
                zNow = x >= rampLength - 1e-9 ? level : z + ((level - z) * x) / rampLength;
            if (opts.tabs !== undefined && zNow < opts.tabs.top && inTab(x - len * 1e-4 + s0))
                zNow = opts.tabs.top;
            path.push("feed", p.x, p.y, zNow);
            prev = x;
        }
        s0 = (s0 + end) % total;
        z = level;
    }
    path.retract();
}

/** An open line followed level by level, there and back (no lift between levels). */
function cutLine(path: Path, line: Pt[], zs: number[]) {
    if (line.length < 2) return;
    path.approach(line[0]);
    let forward = true;
    for (const level of zs) {
        const pts = forward ? line : [...line].reverse();
        path.push("plunge", pts[0].x, pts[0].y, level);
        for (const p of pts.slice(1)) path.push("feed", p.x, p.y, level);
        forward = !forward;
    }
    path.retract();
}

function closedRings(rings: readonly Pt[][]): Pt[][] {
    return rings.filter((r) => r.length >= 3);
}

/**
 * The tool's moves for one operation. Climb milling on an outline outside means going round
 * clockwise (the cutter turning clockwise from above), counter-clockwise inside and in pockets.
 */
export function operationMoves(op: CamOperation, tool: CamTool, h: Heights): MillMove[] {
    const c = cutData(op, tool);
    const zs = levels(op.depth, c.stepDown);
    const path = new Path(h);
    const radius = tool.diameter / 2;
    if (op.kind === "drill") {
        const peck = op.peck > 0 ? op.peck : op.depth;
        for (const p of op.points) {
            path.approach(p);
            let z = 0;
            while (z > -op.depth + 1e-9) {
                z = Math.max(-op.depth, z - peck);
                path.push("plunge", p.x, p.y, z);
                if (z > -op.depth + 1e-9) path.push("rapid", p.x, p.y, h.clearance);
                if (z > -op.depth + 1e-9) path.push("rapid", p.x, p.y, Math.min(h.clearance, z + 0.3));
            }
            path.retract();
        }
        return path.moves;
    }
    if (op.kind === "engrave") {
        for (const r of op.rings) {
            if (r.length >= 3 && Math.hypot(r[0].x - r.at(-1)!.x, r[0].y - r.at(-1)!.y) < 1e-6)
                cutRing(path, r.slice(0, -1), zs, { ramp: op.ramp });
            else cutLine(path, r, zs);
        }
        return path.moves;
    }
    const base = region(closedRings(op.rings));
    if (op.kind === "profile") {
        const delta =
            op.side === "outside"
                ? radius + op.allowance
                : op.side === "inside"
                  ? -(radius + op.allowance)
                  : 0;
        const rings = offsetRegion(base, delta);
        const bottom = -op.depth;
        for (const r of rings) {
            // the tool goes round the outer ring and the holes' rings each its own way
            const outer = (op.side === "inside") !== isHoleOf(r, rings);
            const ccw = op.climb ? !outer : outer;
            const ring = oriented(r, ccw);
            const total = ringLength(ring);
            const tabs =
                op.kind === "profile" && op.tabs.count > 0 && op.tabs.height > 0 && op.tabs.height < op.depth
                    ? {
                          centres: Array.from(
                              { length: op.tabs.count },
                              (_, i) => ((i + 0.5) * total) / op.tabs.count,
                          ),
                          half: (op.tabs.width + tool.diameter) / 2,
                          top: bottom + op.tabs.height,
                      }
                    : undefined;
            cutRing(path, ring, zs, { ramp: op.ramp, tabs });
        }
        return path.moves;
    }
    // pocket: rings from the wall inwards, a step-over apart, cut from the middle out at each level
    const rounds: Pt[][][] = [];
    let current = offsetRegion(base, -(radius + op.allowance));
    while (current.length > 0 && rounds.length < 2000) {
        rounds.push(current);
        current = offsetRegion(current, -c.stepOver);
    }
    const ordered = rounds.reverse().flat();
    zs.forEach((level, i) => {
        const from = i === 0 ? 0 : zs[i - 1];
        for (const r of ordered) cutRing(path, oriented(r, op.climb), [level], { ramp: op.ramp, from });
    });
    return path.moves;
}

/** Whether a ring of an offset result is a hole (inside another ring of it). */
function isHoleOf(ring: Pt[], all: Pt[][]): boolean {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
        area += (ring[j].x - ring[i].x) * (ring[j].y + ring[i].y);
    // clipper's result: outer rings counter-clockwise, holes clockwise
    return all.length > 0 && area < 0;
}
