// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { flattenCubic } from "./flatten";
import type { LaserPath, Pt } from "./geometry";

/**
 * A path of Bézier nodes, as the pen tool draws it (EzCAD «Кривая», LightBurn's pen) and the
 * node editor changes it: each node an anchor with optional handles — none is a sharp corner,
 * a smooth node keeps its two handles in one line. Between two nodes runs a cubic from the
 * first's outgoing handle to the second's incoming one (a straight line when both are absent).
 * Coordinates are the object's own millimetre frame.
 */

export interface PathNode {
    x: number;
    y: number;
    /** Incoming handle, absolute; absent: none. */
    in?: Pt;
    /** Outgoing handle, absolute. */
    out?: Pt;
    /** Moving one handle turns the other to stay opposite. */
    smooth?: boolean;
}

export interface SubPath {
    nodes: PathNode[];
    closed: boolean;
}

const TOLERANCE = 0.02;

function segments(sub: SubPath): [PathNode, PathNode][] {
    const out: [PathNode, PathNode][] = [];
    const n = sub.nodes.length;
    for (let i = 0; i + 1 < n; i++) out.push([sub.nodes[i], sub.nodes[i + 1]]);
    if (sub.closed && n > 1) out.push([sub.nodes[n - 1], sub.nodes[0]]);
    return out;
}

/** The subpaths flattened to the tolerance. */
export function flattenSubPaths(subs: readonly SubPath[], tolerance = TOLERANCE): LaserPath[] {
    const out: LaserPath[] = [];
    for (const sub of subs) {
        if (sub.nodes.length === 0) continue;
        const points: Pt[] = [{ x: sub.nodes[0].x, y: sub.nodes[0].y }];
        for (const [a, b] of segments(sub)) {
            if (a.out === undefined && b.in === undefined) points.push({ x: b.x, y: b.y });
            else flattenCubic(a, a.out ?? a, b.in ?? b, { x: b.x, y: b.y }, tolerance, points);
        }
        if (sub.closed && points.length > 1) points.pop();
        if (points.length >= 2) out.push({ points, closed: sub.closed && points.length >= 3 });
    }
    return out;
}

/** Plain outlines as corner nodes, to edit an imported or converted object node by node. */
export function subPathsFromOutlines(paths: readonly LaserPath[]): SubPath[] {
    return paths
        .filter((p) => p.points.length >= 2)
        .map((p) => ({ closed: p.closed, nodes: p.points.map((q) => ({ x: q.x, y: q.y })) }));
}

export function cloneSubPaths(subs: readonly SubPath[]): SubPath[] {
    return subs.map((s) => ({
        closed: s.closed,
        nodes: s.nodes.map((n) => ({
            x: n.x,
            y: n.y,
            in: n.in && { ...n.in },
            out: n.out && { ...n.out },
            smooth: n.smooth,
        })),
    }));
}

/** Every anchor and handle moved by d. */
export function translateSubPaths(subs: SubPath[], dx: number, dy: number) {
    for (const s of subs)
        for (const n of s.nodes) {
            n.x += dx;
            n.y += dy;
            if (n.in) n.in = { x: n.in.x + dx, y: n.in.y + dy };
            if (n.out) n.out = { x: n.out.x + dx, y: n.out.y + dy };
        }
}

function lerp(a: Pt, b: Pt, t: number): Pt {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
    const a = lerp(p0, p1, t);
    const b = lerp(p1, p2, t);
    const c = lerp(p2, p3, t);
    return lerp(lerp(a, b, t), lerp(b, c, t), t);
}

/** The point of segment `index` of the subpath at t. */
export function segmentPoint(sub: SubPath, index: number, t: number): Pt {
    const [a, b] = segments(sub)[index];
    return cubicAt(a, a.out ?? a, b.in ?? b, b, t);
}

export interface SegmentHit {
    sub: number;
    segment: number;
    t: number;
    distance: number;
}

/** The segment nearest to p (sampled), within `reach`. */
export function hitSegment(subs: readonly SubPath[], p: Pt, reach: number): SegmentHit | undefined {
    let best: SegmentHit | undefined;
    subs.forEach((sub, si) => {
        segments(sub).forEach((_, k) => {
            const steps = 48;
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const q = segmentPoint(sub, k, t);
                const d = Math.hypot(q.x - p.x, q.y - p.y);
                if (d <= reach && (best === undefined || d < best.distance))
                    best = { sub: si, segment: k, t, distance: d };
            }
        });
    });
    return best;
}

/** A node put into segment `segment` at t, the curve unchanged (de Casteljau); its index. */
export function insertNode(sub: SubPath, segment: number, t: number): number {
    const n = sub.nodes.length;
    const ia = segment;
    const ib = (segment + 1) % n;
    const a = sub.nodes[ia];
    const b = sub.nodes[ib];
    if (a.out === undefined && b.in === undefined) {
        sub.nodes.splice(ia + 1, 0, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        return ia + 1;
    }
    const p1 = a.out ?? { x: a.x, y: a.y };
    const p2 = b.in ?? { x: b.x, y: b.y };
    const q0 = lerp(a, p1, t);
    const q1 = lerp(p1, p2, t);
    const q2 = lerp(p2, b, t);
    const r0 = lerp(q0, q1, t);
    const r1 = lerp(q1, q2, t);
    const s = lerp(r0, r1, t);
    a.out = q0;
    b.in = q2;
    sub.nodes.splice(ia + 1, 0, { x: s.x, y: s.y, in: r0, out: r1, smooth: true });
    return ia + 1;
}

/** A node taken out; a subpath left with one node goes. */
export function deleteNode(subs: SubPath[], si: number, ni: number) {
    const sub = subs[si];
    sub.nodes.splice(ni, 1);
    if (sub.nodes.length < 2) subs.splice(si, 1);
    else if (sub.nodes.length < 3) sub.closed = false;
}

/** Smooth: the handles in one line (made from the neighbours if there were none); corner: none. */
export function toggleSmooth(sub: SubPath, ni: number) {
    const n = sub.nodes[ni];
    if (n.smooth || n.in !== undefined || n.out !== undefined) {
        n.smooth = false;
        n.in = undefined;
        n.out = undefined;
        return;
    }
    const count = sub.nodes.length;
    const prev = sub.nodes[(ni - 1 + count) % count];
    const next = sub.nodes[(ni + 1) % count];
    const first = ni === 0 && !sub.closed;
    const last = ni === count - 1 && !sub.closed;
    const from = first ? n : prev;
    const to = last ? n : next;
    const dx = (to.x - from.x) / 6;
    const dy = (to.y - from.y) / 6;
    n.in = { x: n.x - dx, y: n.y - dy };
    n.out = { x: n.x + dx, y: n.y + dy };
    n.smooth = true;
}

/** A handle dragged to p: the opposite one of a smooth node turned to stay in line (its length kept). */
export function moveHandle(n: PathNode, which: "in" | "out", p: Pt, breakMirror: boolean) {
    n[which] = { ...p };
    if (breakMirror) {
        n.smooth = false;
        return;
    }
    if (!n.smooth) return;
    const other = which === "in" ? "out" : "in";
    const o = n[other];
    const len = o === undefined ? Math.hypot(p.x - n.x, p.y - n.y) : Math.hypot(o.x - n.x, o.y - n.y);
    const d = Math.hypot(p.x - n.x, p.y - n.y);
    if (d < 1e-9) return;
    n[other] = { x: n.x - ((p.x - n.x) / d) * len, y: n.y - ((p.y - n.y) / d) * len };
}

/** The anchor moved, its handles with it. */
export function moveNode(n: PathNode, x: number, y: number) {
    const dx = x - n.x;
    const dy = y - n.y;
    n.x = x;
    n.y = y;
    if (n.in) n.in = { x: n.in.x + dx, y: n.in.y + dy };
    if (n.out) n.out = { x: n.out.x + dx, y: n.out.y + dy };
}

/**
 * Broken at a node: a closed path opens there (the node twice, start and end); an open one
 * splits in two.
 */
export function breakAt(subs: SubPath[], si: number, ni: number) {
    const sub = subs[si];
    const n = sub.nodes[ni];
    const twin = (): PathNode => ({ x: n.x, y: n.y, in: n.in && { ...n.in }, out: n.out && { ...n.out } });
    if (sub.closed) {
        sub.nodes = [...sub.nodes.slice(ni), ...sub.nodes.slice(0, ni), twin()];
        sub.nodes[0].in = undefined;
        sub.nodes[sub.nodes.length - 1].out = undefined;
        sub.closed = false;
        return;
    }
    if (ni === 0 || ni === sub.nodes.length - 1) return;
    const tail: SubPath = { closed: false, nodes: [twin(), ...sub.nodes.slice(ni + 1)] };
    tail.nodes[0].in = undefined;
    sub.nodes = sub.nodes.slice(0, ni + 1);
    sub.nodes[ni].out = undefined;
    subs.splice(si + 1, 0, tail);
}

/**
 * Joined at an end node: to the nearest end of another open subpath (merged into one), or, when
 * there is none, the subpath closed. False when the node is not an end of an open subpath.
 */
export function joinAt(subs: SubPath[], si: number, ni: number): boolean {
    const sub = subs[si];
    if (sub.closed || (ni !== 0 && ni !== sub.nodes.length - 1)) return false;
    const end = sub.nodes[ni];
    let best: { s: number; atStart: boolean; d: number } | undefined;
    subs.forEach((other, k) => {
        if (k === si || other.closed) return;
        for (const atStart of [true, false]) {
            const q = atStart ? other.nodes[0] : other.nodes[other.nodes.length - 1];
            const d = Math.hypot(q.x - end.x, q.y - end.y);
            if (best === undefined || d < best.d) best = { s: k, atStart, d };
        }
    });
    if (best === undefined) {
        if (sub.nodes.length < 3) return false;
        sub.closed = true;
        return true;
    }
    const target = best as { s: number; atStart: boolean; d: number };
    const other = subs[target.s];
    const reversed = (s: SubPath) => [...s.nodes].reverse().map((n) => ({ ...n, in: n.out, out: n.in }));
    const ours = ni === sub.nodes.length - 1 ? sub.nodes : reversed(sub);
    const theirs = target.atStart ? other.nodes : reversed(other);
    sub.nodes = [...ours, ...theirs];
    subs.splice(target.s, 1);
    return true;
}

// ---- freehand ---------------------------------------------------------------------------------

/** Ramer–Douglas–Peucker: the fewest points within `tolerance` of the stroke. */
export function simplify(points: readonly Pt[], tolerance: number): Pt[] {
    if (points.length <= 2) return [...points];
    const keep = new Array(points.length).fill(false);
    keep[0] = keep[points.length - 1] = true;
    const stack: [number, number][] = [[0, points.length - 1]];
    while (stack.length > 0) {
        const [i, j] = stack.pop() as [number, number];
        const a = points[i];
        const b = points[j];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        let worst = -1;
        let at = -1;
        for (let k = i + 1; k < j; k++) {
            const p = points[k];
            const d =
                len < 1e-12
                    ? Math.hypot(p.x - a.x, p.y - a.y)
                    : Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
            if (d > worst) {
                worst = d;
                at = k;
            }
        }
        if (worst > tolerance && at > 0) {
            keep[at] = true;
            stack.push([i, at], [at, j]);
        }
    }
    return points.filter((_, k) => keep[k]);
}

/** A stroke as smooth nodes: simplified, then each node's handles along its neighbours (Catmull–Rom). */
export function smoothStroke(points: readonly Pt[], tolerance: number, closed: boolean): SubPath {
    const pts = simplify(points, tolerance);
    if (closed && pts.length > 3) pts.pop();
    const n = pts.length;
    const nodes: PathNode[] = pts.map((p, i) => {
        const hasPrev = closed || i > 0;
        const hasNext = closed || i < n - 1;
        if (!hasPrev || !hasNext || n < 3) return { x: p.x, y: p.y };
        const prev = pts[(i - 1 + n) % n];
        const next = pts[(i + 1) % n];
        const dx = (next.x - prev.x) / 6;
        const dy = (next.y - prev.y) / 6;
        return {
            x: p.x,
            y: p.y,
            in: { x: p.x - dx, y: p.y - dy },
            out: { x: p.x + dx, y: p.y + dy },
            smooth: true,
        };
    });
    return { nodes, closed: closed && n >= 3 };
}

export function parseSubPaths(raw: unknown): SubPath[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const pt = (v: any): Pt | undefined =>
        v !== null && typeof v === "object" && Number.isFinite(v.x) && Number.isFinite(v.y)
            ? { x: v.x, y: v.y }
            : undefined;
    const subs: SubPath[] = [];
    for (const s of raw as any[]) {
        if (!Array.isArray(s?.nodes)) continue;
        const nodes: PathNode[] = [];
        for (const n of s.nodes) {
            const p = pt(n);
            if (p === undefined) continue;
            nodes.push({ ...p, in: pt(n.in), out: pt(n.out), smooth: n.smooth === true ? true : undefined });
        }
        if (nodes.length >= 2) subs.push({ nodes, closed: s.closed === true && nodes.length >= 3 });
    }
    return subs.length > 0 ? subs : undefined;
}
