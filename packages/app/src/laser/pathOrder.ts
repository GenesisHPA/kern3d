// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { LaserPath, Pt } from "./geometry";

/** Above this many vertices in all, a closed path is entered at its first point (no search along it). */
const VERTEX_SEARCH_LIMIT = 50_000;

/**
 * The paths in the order a laser should trace them, greedy nearest neighbour from `start`:
 * after each path the next is the one whose entry is closest to where the head stopped. An
 * open path may be run backwards (entered at its far end); a closed path is entered at its
 * vertex nearest the head and goes once round. Each result's points are what to trace in order
 * — a closed path's list ends back at its entry point.
 */
export function orderPaths(paths: readonly LaserPath[], start: Pt = { x: 0, y: 0 }): Pt[][] {
    const remaining = paths.filter((p) => p.points.length > 1);
    const total = remaining.reduce((n, p) => n + p.points.length, 0);
    const searchVertices = total <= VERTEX_SEARCH_LIMIT;
    const done = new Uint8Array(remaining.length);
    const result: Pt[][] = [];
    let head = start;
    for (let n = 0; n < remaining.length; n++) {
        let best = -1;
        let bestDistance = Infinity;
        let bestEntry = 0;
        let bestReverse = false;
        for (let i = 0; i < remaining.length; i++) {
            if (done[i]) continue;
            const { index, reverse, distance } = entryOf(remaining[i], head, searchVertices);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = i;
                bestEntry = index;
                bestReverse = reverse;
            }
        }
        done[best] = 1;
        const trace = traceOf(remaining[best], bestEntry, bestReverse);
        result.push(trace);
        head = trace[trace.length - 1];
    }
    return result;
}

function squared(a: Pt, b: Pt): number {
    return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function entryOf(path: LaserPath, head: Pt, searchVertices: boolean) {
    const pts = path.points;
    if (!path.closed) {
        const first = squared(pts[0], head);
        const last = squared(pts[pts.length - 1], head);
        return last < first
            ? { index: pts.length - 1, reverse: true, distance: last }
            : { index: 0, reverse: false, distance: first };
    }
    let index = 0;
    let distance = squared(pts[0], head);
    if (searchVertices) {
        for (let k = 1; k < pts.length; k++) {
            const d = squared(pts[k], head);
            if (d < distance) {
                distance = d;
                index = k;
            }
        }
    }
    return { index, reverse: false, distance };
}

function traceOf(path: LaserPath, entry: number, reverse: boolean): Pt[] {
    const pts = path.points;
    if (!path.closed) return reverse ? [...pts].reverse() : [...pts];
    const trace: Pt[] = [];
    for (let k = 0; k <= pts.length; k++) trace.push(pts[(entry + k) % pts.length]);
    return trace;
}
