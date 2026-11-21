// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Loop2D } from "./slices";

export type P2 = readonly [number, number];

/** One curve of a fitted profile; consecutive curves share their end points exactly. */
export type Curve2D =
    | { readonly kind: "line"; readonly a: P2; readonly b: P2 }
    | {
          readonly kind: "arc";
          readonly c: P2;
          readonly r: number;
          readonly a: P2;
          readonly b: P2;
          /** Counter-clockwise from `a` to `b`. */
          readonly ccw: boolean;
      };

/** A closed profile: a full circle, or a chain of lines and arcs. */
export type Profile2D =
    /** `ccw`: material inside (a boss's section); clockwise is a hole. */
    | { readonly kind: "circle"; readonly c: P2; readonly r: number; readonly ccw: boolean }
    | { readonly kind: "chain"; readonly curves: readonly Curve2D[] };

/** Turns below this are a straight run; above `BEND_MAX` a corner; between, an arc's facet. */
const BEND_MIN = (0.3 * Math.PI) / 180;
const BEND_MAX = (35 * Math.PI) / 180;

/** Least-squares circle (Kåsa) through 2D points. */
export function fitCircle(points: readonly P2[]): { c: P2; r: number } | undefined {
    if (points.length < 3) return undefined;
    // centred for conditioning
    let mx = 0;
    let my = 0;
    for (const [x, y] of points) {
        mx += x;
        my += y;
    }
    mx /= points.length;
    my /= points.length;
    let suu = 0;
    let svv = 0;
    let suv = 0;
    let suuu = 0;
    let svvv = 0;
    let suvv = 0;
    let svuu = 0;
    for (const [x, y] of points) {
        const u = x - mx;
        const v = y - my;
        suu += u * u;
        svv += v * v;
        suv += u * v;
        suuu += u * u * u;
        svvv += v * v * v;
        suvv += u * v * v;
        svuu += v * u * u;
    }
    const det = suu * svv - suv * suv;
    if (Math.abs(det) < 1e-24) return undefined;
    const bu = (suuu + suvv) / 2;
    const bv = (svvv + svuu) / 2;
    const uc = (bu * svv - bv * suv) / det;
    const vc = (bv * suu - bu * suv) / det;
    const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / points.length);
    return Number.isFinite(r) ? { c: [uc + mx, vc + my], r } : undefined;
}

function maxDeviation(points: readonly P2[], c: P2, r: number): number {
    let worst = 0;
    for (const [x, y] of points) worst = Math.max(worst, Math.abs(Math.hypot(x - c[0], y - c[1]) - r));
    return worst;
}

const turn = (a: P2, b: P2, c: P2) =>
    Math.atan2(
        (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]),
        (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]),
    );

/** Distance of `p` from the line through `a`, `b`. */
function offLine(p: P2, a: P2, b: P2): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    return l === 0
        ? Math.hypot(p[0] - a[0], p[1] - a[1])
        : Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / l;
}

/** Consecutive points closer than `tol` merged; the loop's closing duplicate dropped. */
function clean(loop: Loop2D, tol: number): P2[] {
    const out: P2[] = [];
    for (const p of loop) {
        const last = out[out.length - 1];
        if (last === undefined || Math.hypot(p[0] - last[0], p[1] - last[1]) > tol) out.push(p);
    }
    while (out.length > 1) {
        const [f, l] = [out[0], out[out.length - 1]];
        if (Math.hypot(f[0] - l[0], f[1] - l[1]) > tol) break;
        out.pop();
    }
    return out;
}

/**
 * A section loop as lines and arcs, within `tol` of every loop point. Facet runs that turn the
 * same way by small steps are arcs (a tessellated hole, a rounded corner); straight runs merge
 * into one line; the whole loop on one circle is a circle. The curves keep the loop's own points
 * as their ends, so neighbours meet exactly.
 */
export function fitProfile(loop: Loop2D, tol: number): Profile2D | undefined {
    const pts = clean(loop, tol * 0.1);
    const n = pts.length;
    if (n < 3) return undefined;
    const angles = pts.map((p, i) => turn(pts[(i - 1 + n) % n], p, pts[(i + 1) % n]));

    // the whole loop one circle
    const allBend = angles.every((a) => Math.abs(a) < BEND_MAX && Math.sign(a) === Math.sign(angles[0]));
    if (allBend && n >= 6) {
        const circle = fitCircle(pts);
        if (circle && maxDeviation(pts, circle.c, circle.r) <= tol) {
            return { kind: "circle", ...circle, ccw: angles[0] > 0 };
        }
    }

    // start the walk at a vertex that is no arc's middle, so no run straddles the seam
    const kind = (i: number) => {
        const a = Math.abs(angles[i]);
        return a < BEND_MIN ? "flat" : a > BEND_MAX ? "corner" : "bend";
    };
    let start = [...pts.keys()].find((i) => kind(i) === "corner");
    start ??= [...pts.keys()].find((i) => kind(i) === "flat");
    if (start === undefined) {
        // every vertex bends but the loop is not one circle: split at the sharpest turn
        start = angles.reduce((best, a, i) => (Math.abs(a) > Math.abs(angles[best]) ? i : best), 0);
    }
    const order = [...pts.keys()].map((k) => (start + k) % n);
    const at = (k: number) => pts[order[k % n]];
    const kindAt = (k: number) => kind(order[k % n]);
    const signAt = (k: number) => Math.sign(angles[order[k % n]]);

    const raw: Curve2D[] = [];
    let k = 0;
    while (k < n) {
        // an arc: interior vertices k+1..j-1 all bends of one sign, at least two of them
        let j = k + 1;
        if (kindAt(j) === "bend") {
            const sign = signAt(j);
            while (j < n && kindAt(j) === "bend" && signAt(j) === sign) j++;
        }
        const interior = j - k - 1;
        if (interior >= 2) {
            const run = Array.from({ length: j - k + 1 }, (_, m) => at(k + m));
            const circle = fitCircle(run);
            if (circle && maxDeviation(run, circle.c, circle.r) <= tol) {
                // the centre moved onto the chord's bisector, so both ends sit on the one radius
                const a = run[0];
                const b = run[run.length - 1];
                const mid: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
                const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
                const nrm: P2 = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
                const off = (circle.c[0] - mid[0]) * nrm[0] + (circle.c[1] - mid[1]) * nrm[1];
                const c: P2 = [mid[0] + nrm[0] * off, mid[1] + nrm[1] * off];
                const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
                raw.push({ kind: "arc", c, r, a, b, ccw: signAt(k + 1) > 0 });
                k = j;
                continue;
            }
        }
        raw.push({ kind: "line", a: at(k), b: at(k + 1) });
        k++;
    }

    // straight runs into one line, as long as every merged point stays within tol
    const curves: Curve2D[] = [];
    let pending: { a: P2; b: P2; points: P2[] } | undefined;
    const flush = () => {
        if (pending) curves.push({ kind: "line", a: pending.a, b: pending.b });
        pending = undefined;
    };
    for (const curve of raw) {
        if (curve.kind !== "line") {
            flush();
            curves.push(curve);
            continue;
        }
        if (pending === undefined) {
            pending = { a: curve.a, b: curve.b, points: [] };
            continue;
        }
        const points = [...pending.points, pending.b];
        if (points.every((p) => offLine(p, pending!.a, curve.b) <= tol)) {
            pending = { a: pending.a, b: curve.b, points };
        } else {
            flush();
            pending = { a: curve.a, b: curve.b, points: [] };
        }
    }
    flush();
    // the seam: a last line running straight on into the first one
    if (curves.length > 2) {
        const first = curves[0];
        const last = curves[curves.length - 1];
        if (first.kind === "line" && last.kind === "line" && offLine(first.a, last.a, first.b) <= tol) {
            curves[0] = { kind: "line", a: last.a, b: first.b };
            curves.pop();
        }
    }
    return curves.length >= 2 ? { kind: "chain", curves } : undefined;
}

/** Area of a fitted profile (positive counter-clockwise), arcs counted exactly. */
export function profileArea(profile: Profile2D): number {
    if (profile.kind === "circle") return Math.PI * profile.r * profile.r * (profile.ccw ? 1 : -1);
    let area = 0;
    for (const c of profile.curves) {
        area += (c.a[0] * c.b[1] - c.b[0] * c.a[1]) / 2;
        if (c.kind === "arc") {
            // the circular segment between the chord and the arc
            const sweep = arcSweep(c);
            area += ((c.r * c.r * (sweep - Math.sin(sweep))) / 2) * (c.ccw ? 1 : -1);
        }
    }
    return area;
}

/** The arc's sweep in radians (0, 2π). */
export function arcSweep(c: Extract<Curve2D, { kind: "arc" }>): number {
    const a0 = Math.atan2(c.a[1] - c.c[1], c.a[0] - c.c[0]);
    const a1 = Math.atan2(c.b[1] - c.c[1], c.b[0] - c.c[0]);
    let s = c.ccw ? a1 - a0 : a0 - a1;
    while (s <= 0) s += 2 * Math.PI;
    while (s > 2 * Math.PI) s -= 2 * Math.PI;
    return s;
}
