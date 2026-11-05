// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Circle2, Polyline2, ViewGeometry } from "./hlr";
import { SegmentIndex } from "./hlr";

/**
 * Centre lines by ГОСТ 2.303 / 2.305: a cross on every circle seen face-on (one per centre,
 * as long as the largest circle there), the pitch circle of holes spaced round a centre, and
 * the axes of symmetry of a symmetric view. All in the view's model 2D frame.
 */

/** Holes of one size spaced round a common centre: drawn on a centre-line circle. */
export interface PitchCircle {
    cx: number;
    cy: number;
    r: number;
    /** Indexes into the view's circles. */
    members: number[];
}

export interface SymmetryAxes {
    /** x of a vertical axis of symmetry. */
    vertical?: number;
    /** y of a horizontal one. */
    horizontal?: number;
}

function sizeOf(g: ViewGeometry): number {
    const b = g.bounds;
    return Math.max(1e-6, Math.hypot(b.maxX - b.minX, b.maxY - b.minY));
}

export function toleranceOf(g: ViewGeometry): number {
    return sizeOf(g) * 1e-3 + 1e-6;
}

/** Circles sharing a centre, the largest first: one cross marks them all. */
export function concentricGroups(circles: readonly Circle2[], tolerance: number): Circle2[][] {
    const groups: Circle2[][] = [];
    for (const c of circles) {
        const group = groups.find((g) => Math.hypot(g[0].cx - c.cx, g[0].cy - c.cy) <= tolerance);
        if (group === undefined) groups.push([c]);
        else group.push(c);
    }
    for (const g of groups) g.sort((a, b) => b.r - a.r);
    return groups;
}

/**
 * Three or more equal circles evenly spaced round the centre of a larger circle (a flange's
 * bore or rim): a bolt circle. Holes at a rectangle's corners are not one — they are placed
 * by linear dimensions.
 */
export function pitchCircles(circles: readonly Circle2[], tolerance: number): PitchCircle[] {
    const result: PitchCircle[] = [];
    const used = new Set<number>();
    for (let i = 0; i < circles.length; i++) {
        if (used.has(i)) continue;
        const members = [i];
        for (let j = i + 1; j < circles.length; j++) {
            if (!used.has(j) && Math.abs(circles[j].r - circles[i].r) <= tolerance) members.push(j);
        }
        if (members.length < 3) continue;
        const candidates = circles
            .filter((c) => c.r > circles[i].r)
            .map((c): [number, number] => [c.cx, c.cy]);
        for (const [cx, cy] of candidates) {
            const radii = members.map((k) => Math.hypot(circles[k].cx - cx, circles[k].cy - cy));
            const r = radii[0];
            if (r <= tolerance * 10 || radii.some((x) => Math.abs(x - r) > tolerance * 2)) continue;
            if (!evenlySpaced(members.map((k) => Math.atan2(circles[k].cy - cy, circles[k].cx - cx))))
                continue;
            result.push({ cx, cy, r, members });
            for (const k of members) used.add(k);
            break;
        }
    }
    return result;
}

function evenlySpaced(angles: number[]): boolean {
    const sorted = [...angles].sort((a, b) => a - b);
    const step = (2 * Math.PI) / sorted.length;
    return sorted.every((a, k) => {
        const next = k + 1 < sorted.length ? sorted[k + 1] : sorted[0] + 2 * Math.PI;
        return Math.abs(next - a - step) < 1e-3;
    });
}

function samples(lines: readonly Polyline2[], step: number): [number, number, number, number][] {
    const result: [number, number, number, number][] = [];
    for (const line of lines) {
        const p = line.points;
        for (let k = 0; k + 3 < p.length; k += 2) {
            const dx = p[k + 2] - p[k];
            const dy = p[k + 3] - p[k + 1];
            const length = Math.hypot(dx, dy);
            if (length === 0) continue;
            const n = Math.max(1, Math.ceil(length / step));
            for (let i = 0; i < n; i++) {
                const t = (i + 0.5) / n;
                result.push([p[k] + dx * t, p[k + 1] + dy * t, dx, dy]);
            }
        }
    }
    return result;
}

const symmetryCache = new WeakMap<ViewGeometry, SymmetryAxes>();

/**
 * Whether the view's line work (visible and hidden) is its own mirror image about the vertical, and the
 * horizontal, line through the middle of its bounds — sampled along every line, each sample
 * mirrored must fall on a line running the mirrored way.
 */
export function symmetryAxes(g: ViewGeometry): SymmetryAxes {
    const cached = symmetryCache.get(g);
    if (cached !== undefined) return cached;
    const result: SymmetryAxes = {};
    const b = g.bounds;
    if (Number.isFinite(b.minX) && g.visible.length > 0) {
        const tolerance = toleranceOf(g) * 2;
        const size = sizeOf(g);
        const index = new SegmentIndex(Math.max(tolerance * 4, size / 64), tolerance);
        index.add(g.visible);
        index.add(g.hidden);
        const points = samples([...g.visible, ...g.hidden], size / 150);
        const mx = (b.minX + b.maxX) / 2;
        const my = (b.minY + b.maxY) / 2;
        const mirrored = (
            f: (x: number, y: number, dx: number, dy: number) => [number, number, number, number],
        ) => points.every(([x, y, dx, dy]) => index.near(...f(x, y, dx, dy)));
        if (mirrored((x, y, dx, dy) => [2 * mx - x, y, -dx, dy])) result.vertical = mx;
        if (mirrored((x, y, dx, dy) => [x, 2 * my - y, dx, -dy])) result.horizontal = my;
    }
    symmetryCache.set(g, result);
    return result;
}
