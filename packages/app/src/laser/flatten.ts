// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { LaserPath, Pt } from "./geometry";

/** The chord error a curve is flattened to, millimetres on the bed. */
export const FLATTEN_TOLERANCE = 0.05;

const MAX_DEPTH = 18;

function lineDistance(p: Pt, a: Pt, b: Pt): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

function mid(a: Pt, b: Pt): Pt {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * A cubic Bézier as points after `p0` (which the caller already holds), split in halves until
 * both inner control points lie within `tolerance` of the chord — the curve then deviates from
 * the chord by less than that (the hull bound).
 */
export function flattenCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, tolerance: number, out: Pt[], depth = 0): void {
    const flat = Math.max(lineDistance(p1, p0, p3), lineDistance(p2, p0, p3)) <= tolerance;
    if (flat || depth >= MAX_DEPTH) {
        out.push(p3);
        return;
    }
    const p01 = mid(p0, p1);
    const p12 = mid(p1, p2);
    const p23 = mid(p2, p3);
    const p012 = mid(p01, p12);
    const p123 = mid(p12, p23);
    const m = mid(p012, p123);
    flattenCubic(p0, p01, p012, m, tolerance, out, depth + 1);
    flattenCubic(m, p123, p23, p3, tolerance, out, depth + 1);
}

export function flattenQuadratic(p0: Pt, p1: Pt, p2: Pt, tolerance: number, out: Pt[]): void {
    const c1 = { x: p0.x + (2 / 3) * (p1.x - p0.x), y: p0.y + (2 / 3) * (p1.y - p0.y) };
    const c2 = { x: p2.x + (2 / 3) * (p1.x - p2.x), y: p2.y + (2 / 3) * (p1.y - p2.y) };
    flattenCubic(p0, c1, c2, p2, tolerance, out);
}

/** Segments of a circular arc of `radius` so the sagitta stays under `tolerance`. */
export function arcSegments(radius: number, sweep: number, tolerance: number): number {
    if (radius <= tolerance) return Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
    const step = 2 * Math.acos(1 - tolerance / radius);
    return Math.max(1, Math.ceil(Math.abs(sweep) / step));
}

/**
 * An ellipse arc around (cx, cy) with radii rx, ry, its x axis turned by `phi` radians, from
 * parameter `start` over `sweep` — points after the start point.
 */
export function flattenEllipseArc(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    phi: number,
    start: number,
    sweep: number,
    tolerance: number,
    out: Pt[],
): void {
    const n = arcSegments(Math.max(rx, ry), sweep, tolerance);
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    for (let i = 1; i <= n; i++) {
        const t = start + (sweep * i) / n;
        const x = rx * Math.cos(t);
        const y = ry * Math.sin(t);
        out.push({ x: cx + x * cos - y * sin, y: cy + x * sin + y * cos });
    }
}

/**
 * The SVG endpoint arc (`A rx ry phi large sweep x y`) converted to its centre form (SVG 1.1
 * appendix F.6.5) and flattened. Radii too small to reach are scaled up as the spec says; a zero
 * radius is a straight line.
 */
export function flattenSvgArc(
    from: Pt,
    rxIn: number,
    ryIn: number,
    phiDeg: number,
    large: boolean,
    sweepFlag: boolean,
    to: Pt,
    tolerance: number,
    out: Pt[],
): void {
    let rx = Math.abs(rxIn);
    let ry = Math.abs(ryIn);
    if (rx < 1e-12 || ry < 1e-12 || (from.x === to.x && from.y === to.y)) {
        out.push(to);
        return;
    }
    const phi = (phiDeg * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx = (from.x - to.x) / 2;
    const dy = (from.y - to.y) / 2;
    const x1 = cos * dx + sin * dy;
    const y1 = -sin * dx + cos * dy;
    const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lambda > 1) {
        const s = Math.sqrt(lambda);
        rx *= s;
        ry *= s;
    }
    const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let k = Math.sqrt(Math.max(0, num / den));
    if (large === sweepFlag) k = -k;
    const cxp = (k * rx * y1) / ry;
    const cyp = (-k * ry * x1) / rx;
    const cx = cos * cxp - sin * cyp + (from.x + to.x) / 2;
    const cy = sin * cxp + cos * cyp + (from.y + to.y) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number) =>
        Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const start = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
    let sweep = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    if (!sweepFlag && sweep > 0) sweep -= 2 * Math.PI;
    if (sweepFlag && sweep < 0) sweep += 2 * Math.PI;
    flattenEllipseArc(cx, cy, rx, ry, phi, start, sweep, tolerance, out);
    // land exactly on the end point the path continues from
    out[out.length - 1] = to;
}

/** A full ellipse as a closed path (no repeated end point). */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number, tolerance: number): LaserPath {
    const points: Pt[] = [];
    flattenEllipseArc(cx, cy, rx, ry, 0, 0, 2 * Math.PI, tolerance, points);
    points.pop();
    return { points: [{ x: cx + rx, y: cy }, ...points], closed: true };
}
