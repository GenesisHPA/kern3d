// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** A point on the bed or in an object's own frame, millimetres, y up. */
export interface Pt {
    x: number;
    y: number;
}

/** A polyline; a closed one returns to its first point without repeating it. */
export interface LaserPath {
    points: Pt[];
    closed: boolean;
}

/** A 2D affine map `[a c e; b d f]`: x' = a·x + c·y + e, y' = b·x + d·y + f (SVG's order). */
export type Affine = [a: number, b: number, c: number, d: number, e: number, f: number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** `m` after `n`: the point goes through `n` first. */
export function multiply(m: Affine, n: Affine): Affine {
    return [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ];
}

export function apply(m: Affine, p: Pt): Pt {
    return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function invert(m: Affine): Affine {
    const det = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(det) < 1e-15) return [...IDENTITY];
    const a = m[3] / det;
    const b = -m[1] / det;
    const c = -m[2] / det;
    const d = m[0] / det;
    return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function translation(x: number, y: number): Affine {
    return [1, 0, 0, 1, x, y];
}

export function scaling(sx: number, sy: number): Affine {
    return [sx, 0, 0, sy, 0, 0];
}

/** Counter-clockwise by `degrees` (y up). */
export function rotation(degrees: number): Affine {
    const r = (degrees * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [c, s, -s, c, 0, 0];
}

/** The largest stretch of the map: how much a tolerance in its output shrinks in its input. */
export function maxScale(m: Affine): number {
    return Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]), 1e-12);
}

export interface Bounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export function emptyBounds(): Bounds {
    return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function isEmpty(b: Bounds): boolean {
    return !(b.minX <= b.maxX && b.minY <= b.maxY);
}

export function addPoint(b: Bounds, p: Pt): void {
    if (p.x < b.minX) b.minX = p.x;
    if (p.y < b.minY) b.minY = p.y;
    if (p.x > b.maxX) b.maxX = p.x;
    if (p.y > b.maxY) b.maxY = p.y;
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
    return {
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY),
    };
}

export function pathsBounds(paths: readonly LaserPath[]): Bounds {
    const b = emptyBounds();
    for (const path of paths) for (const p of path.points) addPoint(b, p);
    return b;
}

export function transformPaths(paths: readonly LaserPath[], m: Affine): LaserPath[] {
    return paths.map((path) => ({ closed: path.closed, points: path.points.map((p) => apply(m, p)) }));
}

export function distance(a: Pt, b: Pt): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Drops consecutive repeats (closer than `eps`) and, for a closed path, a last point equal to the first. */
export function cleanPath(path: LaserPath, eps = 1e-6): LaserPath {
    const points: Pt[] = [];
    for (const p of path.points) {
        const last = points[points.length - 1];
        if (last === undefined || distance(last, p) > eps) points.push(p);
    }
    let closed = path.closed;
    if (points.length > 2 && distance(points[0], points[points.length - 1]) <= eps) {
        points.pop();
        closed = true;
    }
    return { points, closed: closed && points.length > 2 };
}
