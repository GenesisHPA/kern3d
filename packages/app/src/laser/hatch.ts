// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { apply, type LaserPath, type Pt, pathsBounds, rotation } from "./geometry";

export interface HatchSegment {
    from: Pt;
    to: Pt;
}

/**
 * Hatch lines filling the closed paths by the even-odd rule: scanlines `interval` apart at
 * `angleDeg` (0 = along x), each cut where it crosses the outlines and kept between alternate
 * crossings — so a hole inside a shape stays empty. Lines run bidirectionally (every other one
 * reversed) and come in scan order, which keeps the moves between them short. Open paths are
 * closed for the purpose of the fill.
 */
export function hatchPaths(paths: readonly LaserPath[], interval: number, angleDeg: number): HatchSegment[] {
    if (!(interval > 0)) return [];
    // turn the outlines so the hatch runs along x, hatch, and turn the result back
    const toLocal = rotation(-angleDeg);
    const toWorld = rotation(angleDeg);
    const local = paths
        .filter((p) => p.points.length > 2)
        .map((p) => ({ closed: true, points: p.points.map((q) => apply(toLocal, q)) }));
    const bounds = pathsBounds(local);
    if (!(bounds.minY <= bounds.maxY)) return [];
    const edges = edgesOf(local);
    const segments: HatchSegment[] = [];
    // the first line half an interval in, so a fill is centred on its outline
    const count = Math.floor((bounds.maxY - bounds.minY) / interval + 0.5);
    const start = bounds.minY + (bounds.maxY - bounds.minY - (count - 1) * interval) / 2;
    let row = 0;
    for (let k = 0; k < Math.max(count, 1); k++) {
        const y = count <= 0 ? (bounds.minY + bounds.maxY) / 2 : start + k * interval;
        const xs = crossings(edges, y);
        if (xs.length < 2) continue;
        const line: HatchSegment[] = [];
        for (let j = 0; j + 1 < xs.length; j += 2) {
            if (xs[j + 1] - xs[j] > 1e-9) line.push({ from: { x: xs[j], y }, to: { x: xs[j + 1], y } });
        }
        if (line.length === 0) continue;
        if (row % 2 === 1) {
            line.reverse();
            for (const s of line) [s.from, s.to] = [s.to, s.from];
        }
        row++;
        for (const s of line) segments.push({ from: apply(toWorld, s.from), to: apply(toWorld, s.to) });
    }
    return segments;
}

type Edge = [x1: number, y1: number, x2: number, y2: number];

function edgesOf(paths: readonly LaserPath[]): Edge[] {
    const edges: Edge[] = [];
    for (const path of paths) {
        const pts = path.points;
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i];
            const b = pts[(i + 1) % pts.length];
            if (a.y !== b.y) edges.push([a.x, a.y, b.x, b.y]);
        }
    }
    return edges;
}

/** Where the line at `y` crosses the edges, sorted; half-open in y so a vertex counts once. */
function crossings(edges: readonly Edge[], y: number): number[] {
    const xs: number[] = [];
    for (const [x1, y1, x2, y2] of edges) {
        if (y1 <= y === y2 <= y) continue;
        xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
    return xs.sort((a, b) => a - b);
}
