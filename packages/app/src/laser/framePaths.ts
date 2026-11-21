// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { isEmpty, type LaserPath, type Pt, transformPaths } from "./geometry";
import { jobBounds, type LaserJobData, type LaserObject, objectCorners, objectMatrix } from "./laserData";
import type { FrameMode } from "./machineProfile";
import { orderPaths } from "./pathOrder";

/** How far a simplified outline may stray from the real one, mm. */
export const OUTLINE_TOLERANCE = 0.2;

/**
 * The polylines the pointer loops along, in job coordinates: closed ones repeat their first
 * point at the end. `toolpath` is «Контур гравировки» — every outline the job burns, simplified
 * and in the order a pass takes them, pictures as their box.
 */
export function framePaths(job: LaserJobData, mode: FrameMode | "toolpath"): Pt[][] {
    if (mode === "toolpath") {
        const visible = job.objects.filter((o) => !o.hidden);
        const paths = visible.flatMap(toolpathOutlines);
        return orderPaths(paths).map((trace) => simplify(trace, OUTLINE_TOLERANCE));
    }
    if (mode === "box") {
        const b = jobBounds(job);
        if (isEmpty(b)) return [];
        return [
            [
                { x: b.minX, y: b.minY },
                { x: b.maxX, y: b.minY },
                { x: b.maxX, y: b.maxY },
                { x: b.minX, y: b.maxY },
                { x: b.minX, y: b.minY },
            ],
        ];
    }
    return job.objects.filter((o) => !o.hidden).flatMap(outerOutlines);
}

/** What the laser follows on an object: its outlines (fill and line alike), or a picture's box. */
function toolpathOutlines(o: LaserObject): LaserPath[] {
    if (o.kind === "image") return [{ points: objectCorners(o), closed: true }];
    return transformPaths(
        o.paths.filter((p) => p.points.length > 1),
        objectMatrix(o),
    );
}

function closedLoop(points: Pt[]): Pt[] {
    return [...points, points[0]];
}

/** A picture's box; a vector object's outermost closed paths (or its box when it has none). */
function outerOutlines(o: LaserObject): Pt[][] {
    if (o.kind === "image") return [closedLoop(objectCorners(o))];
    const closed = transformPaths(
        o.paths.filter((p) => p.closed && p.points.length > 2),
        objectMatrix(o),
    );
    const outer = closed.filter((p, i) => !closed.some((q, j) => j !== i && contains(q, p)));
    if (outer.length === 0) return [closedLoop(objectCorners(o))];
    return outer.map((p) => closedLoop(simplify(p.points, OUTLINE_TOLERANCE)));
}

/** Whether `inner` lies inside `outer` (its first vertex does, by the even-odd rule). */
function contains(outer: LaserPath, inner: LaserPath): boolean {
    const p = inner.points[0];
    const pts = outer.points;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i];
        const b = pts[j];
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
            inside = !inside;
    }
    return inside;
}

function segmentDistance(p: Pt, a: Pt, b: Pt): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Douglas–Peucker: the fewest of the points that keep the line within `tolerance`. */
export function simplify(points: readonly Pt[], tolerance: number): Pt[] {
    if (points.length < 3) return [...points];
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    const stack: [number, number][] = [[0, points.length - 1]];
    while (stack.length > 0) {
        const [first, last] = stack.pop()!;
        let index = -1;
        let max = tolerance;
        for (let i = first + 1; i < last; i++) {
            const d = segmentDistance(points[i], points[first], points[last]);
            if (d > max) {
                max = d;
                index = i;
            }
        }
        if (index >= 0) {
            keep[index] = 1;
            stack.push([first, index], [index, last]);
        }
    }
    return points.filter((_, i) => keep[i]);
}
