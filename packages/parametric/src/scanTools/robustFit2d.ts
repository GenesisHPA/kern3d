// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type Curve2D, fitCircle, fitProfile, type P2, type Profile2D } from "../stlRebuild/fit2d";
import type { Loop2D } from "../stlRebuild/slices";

/**
 * A section loop as lines and arcs when the loop is noisy (a scan's section): `fitProfile`
 * reads a CAD loop's facets one turn at a time, which noise defeats — every vertex turns. Here
 * the loop is resampled, split at its corners (turns measured over a window several noise
 * widths long), and each run between corners split further, Douglas–Peucker style, until each
 * piece is a line or an arc that passes its points within `tol` (95% of them: a few noise
 * spikes do not split a wall). Neighbouring pieces on one line or one circle merge again.
 *
 * Ends are shared exactly: a line meets a line where the two lines cross, anything else at the
 * break point, and each arc's centre is moved onto its chord's bisector so both of its ends lie
 * on its radius — the profile closes as a sketch's coincident chain does.
 */
export function fitNoisyProfile(loop: Loop2D, tol: number): Profile2D | undefined {
    const pts = resample(loop, Math.max(tol * 0.5, perimeter(loop) / 4000));
    if (pts.length < 6) return undefined;
    const whole = fitCircle(pts);
    if (whole !== undefined && within(pts, (p) => Math.abs(dist(p, whole.c) - whole.r), tol)) {
        return { kind: "circle", c: whole.c, r: whole.r, ccw: signedArea(pts) > 0 };
    }
    const window = Math.max(3, Math.round((tol * 6) / spacing(pts)));
    const corners = cornerIndices(pts, window);
    const n = pts.length;
    // a loop without corners (an oval, a slot's rounds): split at two far apart points
    const breaks =
        corners.length >= 2
            ? corners
            : corners.length === 1
              ? [corners[0], (corners[0] + (n >> 1)) % n]
              : [0, n >> 1];
    const pieces: Piece[] = [];
    for (let i = 0; i < breaks.length; i++) {
        const from = breaks[i];
        const to = breaks[(i + 1) % breaks.length];
        const run = slice(pts, from, to);
        splitRun(run, tol, pieces);
    }
    const merged = mergePieces(pieces, tol);
    if (merged.length < 2) return undefined;
    return { kind: "chain", curves: joinPieces(merged) };
}

/** A section loop fitted for its noise: the facet-by-facet CAD fit when the loop is clean. */
export function fitSectionProfile(loop: Loop2D, tol: number, noisy: boolean): Profile2D | undefined {
    if (!noisy) {
        const exact = fitProfile(loop, tol);
        // a clean loop gives a few curves; hundreds means the facets were read as noise
        if (exact !== undefined && (exact.kind === "circle" || exact.curves.length <= loop.length / 3 + 4))
            return exact;
    }
    return fitNoisyProfile(loop, tol) ?? fitProfile(loop, tol);
}

interface Piece {
    readonly kind: "line" | "arc";
    readonly points: P2[];
    /** For an arc: its fitted circle. */
    readonly c?: P2;
    readonly r?: number;
}

const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function perimeter(loop: Loop2D): number {
    let l = 0;
    for (let i = 0; i < loop.length; i++) l += dist(loop[i], loop[(i + 1) % loop.length]);
    return l;
}

function spacing(pts: readonly P2[]): number {
    return perimeter(pts as Loop2D) / pts.length || 1;
}

function signedArea(pts: readonly P2[]): number {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
}

/** The loop at about one point per `step` along it (closing duplicate dropped). */
function resample(loop: Loop2D, step: number): P2[] {
    const out: P2[] = [];
    let carry = 0;
    for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const l = dist(a, b);
        let s = carry;
        while (s < l) {
            const f = s / l;
            out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
            s += step;
        }
        carry = s - l;
    }
    return out;
}

/** Whether 95% of the points lie within `tol` by `error`. */
function within(points: readonly P2[], error: (p: P2) => number, tol: number): boolean {
    let bad = 0;
    const allowed = Math.floor(points.length * 0.05);
    for (const p of points) {
        const e = error(p);
        if (e > tol * 2) return false;
        if (e > tol && ++bad > allowed) return false;
    }
    return true;
}

/**
 * The loop's corners: points where the direction over `w` points behind turns from the one
 * over `w` points ahead by more than 25°, the sharpest of each cluster.
 */
function cornerIndices(pts: readonly P2[], w: number): number[] {
    const n = pts.length;
    const turn = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const a = pts[(i - w + n * 4) % n];
        const b = pts[i];
        const c = pts[(i + w) % n];
        const u = [b[0] - a[0], b[1] - a[1]];
        const v = [c[0] - b[0], c[1] - b[1]];
        turn[i] = Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]));
    }
    const limit = (25 * Math.PI) / 180;
    const corners: number[] = [];
    for (let i = 0; i < n; i++) {
        if (turn[i] < limit) continue;
        let peak = true;
        for (let d = 1; d <= w && peak; d++) {
            if (turn[(i + d) % n] > turn[i] || turn[(i - d + n) % n] >= turn[i]) peak = false;
        }
        if (peak) corners.push(i);
    }
    return corners;
}

function slice(pts: readonly P2[], from: number, to: number): P2[] {
    const n = pts.length;
    const out: P2[] = [];
    for (let i = from; ; i = (i + 1) % n) {
        out.push(pts[i]);
        if (i === to) break;
    }
    return out;
}

function offLine(p: P2, a: P2, b: P2): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    return l === 0 ? dist(p, a) : Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / l;
}

/** Total least-squares line through the points, as two far points on it (first/last projected). */
function lineFit(points: readonly P2[]): { a: P2; b: P2; error: (p: P2) => number } {
    let mx = 0;
    let my = 0;
    for (const p of points) {
        mx += p[0];
        my += p[1];
    }
    mx /= points.length;
    my /= points.length;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const p of points) {
        sxx += (p[0] - mx) ** 2;
        sxy += (p[0] - mx) * (p[1] - my);
        syy += (p[1] - my) ** 2;
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const d: P2 = [Math.cos(angle), Math.sin(angle)];
    const proj = (p: P2): P2 => {
        const s = (p[0] - mx) * d[0] + (p[1] - my) * d[1];
        return [mx + d[0] * s, my + d[1] * s];
    };
    const a = proj(points[0]);
    const b = proj(points[points.length - 1]);
    return { a, b, error: (p) => Math.abs((p[0] - mx) * -d[1] + (p[1] - my) * d[0]) };
}

/** Splits a run (corner to corner) into lines and arcs, appending to `out`. */
function splitRun(run: P2[], tol: number, out: Piece[]): void {
    if (run.length < 2) return;
    const line = lineFit(run);
    if (run.length < 6 || within(run, line.error, tol)) {
        out.push({ kind: "line", points: run });
        return;
    }
    const circle = fitCircle(run);
    if (circle !== undefined && within(run, (p) => Math.abs(dist(p, circle.c) - circle.r), tol)) {
        out.push({ kind: "arc", points: run, c: circle.c, r: circle.r });
        return;
    }
    // split where the run strays farthest from its chord
    const a = run[0];
    const b = run[run.length - 1];
    let worst = 1;
    let far = -1;
    for (let i = 2; i < run.length - 2; i++) {
        const e = offLine(run[i], a, b);
        if (e > far) {
            far = e;
            worst = i;
        }
    }
    splitRun(run.slice(0, worst + 1), tol, out);
    splitRun(run.slice(worst), tol, out);
}

/** Neighbouring pieces that one line or one circle passes within `tol` become one. */
function mergePieces(pieces: Piece[], tol: number): Piece[] {
    const out: Piece[] = [];
    const tryMerge = (p: Piece, q: Piece): Piece | undefined => {
        // pieces of different kinds too, as the longer one's kind: the stretch of an arc that
        // was flat enough to pass as a line within tol (where a wall runs tangent into a round)
        const kind = p.points.length >= q.points.length ? p.kind : q.kind;
        const points = [...p.points, ...q.points.slice(1)];
        if (kind === "line") {
            const fit = lineFit(points);
            return within(points, fit.error, tol) ? { kind: "line", points } : undefined;
        }
        const c = fitCircle(points);
        if (c === undefined || !within(points, (x) => Math.abs(dist(x, c.c) - c.r), tol)) return undefined;
        return { kind: "arc", points, c: c.c, r: c.r };
    };
    for (const piece of pieces) {
        const last = out[out.length - 1];
        const merged = last === undefined ? undefined : tryMerge(last, piece);
        if (merged !== undefined) out[out.length - 1] = merged;
        else out.push(piece);
    }
    // the seam
    while (out.length > 2) {
        const merged = tryMerge(out[out.length - 1], out[0]);
        if (merged === undefined) break;
        out[0] = merged;
        out.pop();
    }
    return out;
}

/** The point where the lines through (a, b) and (c, d) cross, or undefined when about parallel. */
function crossing(a: P2, b: P2, c: P2, d: P2): P2 | undefined {
    const r: P2 = [b[0] - a[0], b[1] - a[1]];
    const s: P2 = [d[0] - c[0], d[1] - c[1]];
    const den = r[0] * s[1] - r[1] * s[0];
    const lr = Math.hypot(r[0], r[1]);
    const ls = Math.hypot(s[0], s[1]);
    if (Math.abs(den) < lr * ls * Math.sin((5 * Math.PI) / 180)) return undefined;
    const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
    return [a[0] + r[0] * t, a[1] + r[1] * t];
}

/** The pieces as curves with shared ends (see the module comment). */
function joinPieces(pieces: readonly Piece[]): Curve2D[] {
    const n = pieces.length;
    const lines = pieces.map((p) => (p.kind === "line" ? lineFit(p.points) : undefined));
    // joint i: between piece i-1 and piece i
    const joints: P2[] = pieces.map((p, i) => {
        const prev = (i - 1 + n) % n;
        const la = lines[prev];
        const lb = lines[i];
        const at = p.points[0];
        if (la !== undefined && lb !== undefined) {
            const x = crossing(la.a, la.b, lb.a, lb.b);
            // a crossing far from where the pieces meet is a near-parallel step, not a corner
            if (x !== undefined && dist(x, at) < dist(la.a, la.b) + dist(lb.a, lb.b)) return x;
        }
        if (lb !== undefined && la === undefined) return closestOn(lb, at);
        if (la !== undefined && lb === undefined) return closestOn(la, at);
        return at;
    });
    const curves: Curve2D[] = [];
    for (let i = 0; i < n; i++) {
        const a = joints[i];
        const b = joints[(i + 1) % n];
        const piece = pieces[i];
        if (piece.kind === "line" || piece.c === undefined || dist(a, b) < 1e-9) {
            curves.push({ kind: "line", a, b });
            continue;
        }
        curves.push(arcThrough(a, b, piece));
    }
    return curves.filter((c) => dist(c.a, c.b) > 1e-9);
}

function closestOn(line: { a: P2; b: P2 }, p: P2): P2 {
    const dx = line.b[0] - line.a[0];
    const dy = line.b[1] - line.a[1];
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return p;
    const t = ((p[0] - line.a[0]) * dx + (p[1] - line.a[1]) * dy) / l2;
    return [line.a[0] + dx * t, line.a[1] + dy * t];
}

/** The arc from `a` to `b` on (about) the piece's circle: its centre on the chord's bisector. */
function arcThrough(a: P2, b: P2, piece: Piece): Curve2D {
    const mid: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const len = dist(a, b);
    const nrm: P2 = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    const off = (piece.c![0] - mid[0]) * nrm[0] + (piece.c![1] - mid[1]) * nrm[1];
    const c: P2 = [mid[0] + nrm[0] * off, mid[1] + nrm[1] * off];
    const r = dist(a, c);
    // the arc's sense: the way round from a to b that passes the run's middle point
    const m = piece.points[piece.points.length >> 1];
    return { kind: "arc", c, r, a, b, ccw: ccwOf(a, b, c, m) };
}

/** Whether going counter-clockwise from `a` about `c` passes `m` before reaching `b`. */
function ccwOf(a: P2, b: P2, c: P2, m: P2): boolean {
    const ang = (p: P2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
    const norm = (x: number) => {
        let y = x;
        while (y < 0) y += 2 * Math.PI;
        while (y >= 2 * Math.PI) y -= 2 * Math.PI;
        return y;
    };
    const a0 = ang(a);
    return norm(ang(m) - a0) < norm(ang(b) - a0);
}
