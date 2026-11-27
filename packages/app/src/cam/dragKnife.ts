// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { KnifeSettings } from "./camTools";
import type { Pt } from "./offset";
import type { Heights, MillMove, OperationKind } from "./toolpath";

/**
 * Drag (swivel) knife paths. The blade turns freely in its holder and its tip trails the holder's
 * axis by `offset`: wherever the tip must be, the axis is `offset` ahead of it along the way the
 * knife is going. So each straight stretch of the line is cut with the axis shifted forward along
 * it, and at a corner the blade has to be swung round to the new direction — the axis goes round
 * an arc of radius `offset` about the corner (the tip stays on the corner and turns), in the
 * material («loop») or lifted to the top («lift»). Gentle turns (under `cornerAngle`) need no
 * swivel: the blade follows on its own. A cut starts with the blade dragged along the first
 * stretch on the surface so it lines up, and a closed outline runs on past its start (`overcut`)
 * so the cut joins. No ramps: the blade goes straight down.
 */

/** Operations a knife can do: cut along outlines (on, outside, inside) and along lines. */
export const KNIFE_OPERATIONS: readonly OperationKind[] = ["profile", "engrave"];

export function knifeCanDo(kind: OperationKind): boolean {
    return KNIFE_OPERATIONS.includes(kind);
}

/** The swivel arc's step, radians: fine enough for a smooth turn of a tiny radius. */
const ARC_STEP = (10 * Math.PI) / 180;

interface Dir {
    x: number;
    y: number;
}

class KnifePath {
    readonly moves: MillMove[] = [];
    constructor(
        private readonly h: Heights,
        private readonly k: KnifeSettings,
    ) {}

    private last(): MillMove | undefined {
        return this.moves.at(-1);
    }

    push(type: MillMove["type"], x: number, y: number, z: number) {
        const l = this.last();
        if (l && Math.abs(l.x - x) < 1e-6 && Math.abs(l.y - y) < 1e-6 && Math.abs(l.z - z) < 1e-6) return;
        this.moves.push({ type, x, y, z });
    }

    /** Where the axis is for the tip at `p` going along `d`. */
    axis(p: Pt, d: Dir): Pt {
        return { x: p.x + this.k.offset * d.x, y: p.y + this.k.offset * d.y };
    }

    /**
     * Down onto the surface a little before `p` (on the line `d` comes along), the blade dragged
     * there along `d` on the top so it points the right way.
     */
    leadIn(p: Pt, d: Dir, length: number) {
        const from = this.axis({ x: p.x - d.x * length, y: p.y - d.y * length }, d);
        const l = this.last();
        if (l) this.push("rapid", l.x, l.y, this.h.safeZ);
        this.push("rapid", from.x, from.y, this.h.safeZ);
        this.push("rapid", from.x, from.y, this.h.clearance);
        this.push("plunge", from.x, from.y, 0);
        const at = this.axis(p, d);
        this.push("feed", at.x, at.y, 0);
    }

    /** At corner `p`: the blade turned from `din` to `dout` (swung round when the turn is sharp). */
    corner(p: Pt, din: Dir, dout: Dir, z: number) {
        const turn = Math.atan2(din.x * dout.y - din.y * dout.x, din.x * dout.x + din.y * dout.y);
        const to = this.axis(p, dout);
        if (Math.abs(turn) <= (this.k.cornerAngle * Math.PI) / 180 + 1e-9 || this.k.offset <= 1e-9) {
            this.push("feed", to.x, to.y, z);
            return;
        }
        const lift = this.k.corners === "lift";
        const at = lift ? Math.max(z, 0) : z;
        if (lift) {
            const l = this.last()!;
            this.push("rapid", l.x, l.y, at);
        }
        const a0 = Math.atan2(din.y, din.x);
        const n = Math.max(2, Math.ceil(Math.abs(turn) / ARC_STEP));
        for (let i = 1; i <= n; i++) {
            const a = a0 + (turn * i) / n;
            this.push("feed", p.x + this.k.offset * Math.cos(a), p.y + this.k.offset * Math.sin(a), at);
        }
        if (lift) this.push("plunge", to.x, to.y, z);
    }

    retract() {
        const l = this.last();
        if (l) this.push("rapid", l.x, l.y, this.h.safeZ);
    }
}

function direction(a: Pt, b: Pt): Dir {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
}

/** The points with repeats (closer than a micron) dropped. */
function clean(pts: readonly Pt[]): Pt[] {
    const out: Pt[] = [];
    for (const p of pts) {
        const l = out.at(-1);
        if (!l || Math.hypot(p.x - l.x, p.y - l.y) > 1e-6) out.push({ x: p.x, y: p.y });
    }
    return out;
}

/** The first `length` mm of a polyline (as points, its start included). */
function prefix(line: readonly Pt[], length: number): Pt[] {
    const out = [line[0]];
    let left = length;
    for (let i = 0; i + 1 < line.length && left > 1e-9; i++) {
        const a = line[i];
        const b = line[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len >= left) {
            out.push({ x: a.x + ((b.x - a.x) * left) / len, y: a.y + ((b.y - a.y) * left) / len });
            break;
        }
        out.push(b);
        left -= len;
    }
    return out;
}

/** The lead-in length: a few blade offsets, at least a millimetre. */
function leadLength(k: KnifeSettings): number {
    return Math.max(1, 4 * k.offset);
}

/** Passes one after another: lined up at the first, each later one joined by a turn at the end. */
function cutPasses(path: KnifePath, passes: { pts: Pt[]; z: number }[], lead: number) {
    let prev: { dir: Dir; z: number } | undefined;
    for (const pass of passes) {
        const pts = pass.pts;
        const dirs = pts.slice(1).map((p, i) => direction(pts[i], p));
        if (dirs.length === 0) continue;
        if (prev === undefined) path.leadIn(pts[0], dirs[0], lead);
        else path.corner(pts[0], prev.dir, dirs[0], prev.z);
        const start = path.axis(pts[0], dirs[0]);
        path.push("plunge", start.x, start.y, pass.z);
        for (let i = 0; i < dirs.length; i++) {
            const end = path.axis(pts[i + 1], dirs[i]);
            path.push("feed", end.x, end.y, pass.z);
            if (i + 1 < dirs.length) path.corner(pts[i + 1], dirs[i], dirs[i + 1], pass.z);
        }
        prev = { dir: dirs[dirs.length - 1], z: pass.z };
    }
    path.retract();
}

/**
 * A closed outline (no repeated closing point) restarted at the middle of its longest side, so
 * the blade lines up and the cut joins on a straight stretch, not on a corner: returned closed
 * (the start again at the end).
 */
function fromLongestSide(ring: readonly Pt[]): Pt[] {
    let best = 0;
    let longest = -1;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len > longest) {
            longest = len;
            best = i;
        }
    }
    const a = ring[best];
    const b = ring[(best + 1) % ring.length];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const rest = Array.from({ length: ring.length }, (_, i) => ring[(best + 1 + i) % ring.length]);
    return [mid, ...rest, mid];
}

/** The knife's moves round a closed outline, level by level, the last one on past the start. */
export function knifeRingMoves(ring: readonly Pt[], zs: readonly number[], k: KnifeSettings, h: Heights) {
    const pts = clean(ring);
    if (pts.length > 1 && Math.hypot(pts[0].x - pts.at(-1)!.x, pts[0].y - pts.at(-1)!.y) < 1e-6) pts.pop();
    if (pts.length < 3 || zs.length === 0) return [];
    const loop = fromLongestSide(pts);
    const half = Math.hypot(loop[1].x - loop[0].x, loop[1].y - loop[0].y);
    const path = new KnifePath(h, k);
    const passes = zs.map((z) => ({ pts: loop, z }));
    if (k.overcut > 1e-6)
        passes[passes.length - 1] = { pts: [...loop, ...prefix(loop, k.overcut).slice(1)], z: zs.at(-1)! };
    cutPasses(path, passes, Math.min(half, leadLength(k)));
    return path.moves;
}

/** The knife's moves along an open line: each level back the other way, turned round at the end. */
export function knifeLineMoves(line: readonly Pt[], zs: readonly number[], k: KnifeSettings, h: Heights) {
    const pts = clean(line);
    if (pts.length < 2 || zs.length === 0) return [];
    const back = [...pts].reverse();
    const path = new KnifePath(h, k);
    cutPasses(
        path,
        zs.map((z, i) => ({ pts: i % 2 === 0 ? pts : back, z })),
        leadLength(k),
    );
    return path.moves;
}

/**
 * Where the blade's tip goes as the holder makes these moves: the tip drags behind the axis at
 * `offset` (it is pulled straight towards the axis: a tractrix), and lifted it keeps its way and
 * travels with the holder. The path of the cut, for the preview and for checking the compensation.
 * `step` — how finely the moves are followed, mm.
 */
export function bladeTrace(
    moves: readonly MillMove[],
    offset: number,
    step = 0.02,
): { x: number; y: number; z: number; cutting: boolean }[] {
    const out: { x: number; y: number; z: number; cutting: boolean }[] = [];
    if (moves.length === 0) return out;
    let ax = moves[0].x;
    let ay = moves[0].y;
    let tip: Pt | undefined;
    for (const m of moves) {
        const dx = m.x - ax;
        const dy = m.y - ay;
        const len = Math.hypot(dx, dy);
        if (tip === undefined && len > 1e-9)
            tip = { x: ax - (offset * dx) / len, y: ay - (offset * dy) / len };
        const n = Math.max(1, Math.ceil(len / step));
        for (let i = 1; i <= n; i++) {
            const x = ax + (dx * i) / n;
            const y = ay + (dy * i) / n;
            if (tip !== undefined) tip = follow(tip, { x, y }, offset, m.type !== "rapid", dx / n, dy / n);
        }
        ax = m.x;
        ay = m.y;
        if (tip !== undefined)
            out.push({ x: tip.x, y: tip.y, z: m.z, cutting: m.type !== "rapid" && m.z < 0 });
    }
    return out;
}

/** One small step of the holder to `axis`: the tip dragged after it (or carried along, lifted). */
function follow(tip: Pt, axis: Pt, offset: number, dragged: boolean, dx: number, dy: number): Pt {
    if (!dragged) return { x: tip.x + dx, y: tip.y + dy };
    const vx = axis.x - tip.x;
    const vy = axis.y - tip.y;
    const d = Math.hypot(vx, vy);
    if (d <= offset || d < 1e-12) return tip;
    return { x: axis.x - (offset * vx) / d, y: axis.y - (offset * vy) / d };
}
