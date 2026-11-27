// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { dot, type TriMesh, vertex } from "../stlRebuild/mesh";
import type { Loop2D, SliceFrame } from "../stlRebuild/slices";

/**
 * A plane's section through a mesh that is not closed — a scan with holes the clean-up left
 * open. `sectionLoops` drops a chain that does not close; here the chains are walked the same
 * way (each crossing triangle one segment, material on its left, joined through the edges they
 * cross), then an open chain's end is joined to the nearest open start within `maxGap` (its own
 * start closes it), until no end can reach a start. What still does not close is dropped.
 */
export function openSectionLoops(mesh: TriMesh, frame: SliceFrame, h: number, maxGap: number): Loop2D[] {
    const { segments, next } = crossings(mesh, frame, h);
    const chains = walk(segments, next);
    return joinChains(chains, maxGap);
}

interface Segment {
    readonly from: number;
    readonly to: number;
    readonly point: [number, number];
    readonly end: [number, number];
}

function crossings(mesh: TriMesh, frame: SliceFrame, h: number) {
    const { axis, xvec, yvec } = frame;
    const t = mesh.triangles;
    const nv = mesh.positions.length / 3;
    const heights = new Float64Array(nv);
    for (let i = 0; i < nv; i++) heights[i] = dot(vertex(mesh, i), axis) - h;
    const at = (a: number, b: number): [number, number] => {
        const s = heights[a] / (heights[a] - heights[b]);
        const pa = vertex(mesh, a);
        const pb = vertex(mesh, b);
        const p: [number, number, number] = [
            pa[0] + (pb[0] - pa[0]) * s,
            pa[1] + (pb[1] - pa[1]) * s,
            pa[2] + (pb[2] - pa[2]) * s,
        ];
        return [dot(p, xvec), dot(p, yvec)];
    };
    const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
    const segments: Segment[] = [];
    /** Edge → the segment that starts on it. */
    const next = new Map<number, number>();
    for (let k = 0; k < t.length / 3; k++) {
        const v = [t[3 * k], t[3 * k + 1], t[3 * k + 2]];
        const cut: { edge: number; p: [number, number]; down: boolean }[] = [];
        for (let e = 0; e < 3; e++) {
            const a = v[e];
            const b = v[(e + 1) % 3];
            if (heights[a] < 0 !== heights[b] < 0)
                cut.push({ edge: key(a, b), p: at(a, b), down: heights[b] < 0 });
        }
        if (cut.length !== 2) continue;
        const [from, to] = cut[0].down ? [cut[0], cut[1]] : [cut[1], cut[0]];
        next.set(from.edge, segments.length);
        segments.push({ from: from.edge, to: to.edge, point: from.p, end: to.p });
    }
    return { segments, next };
}

interface Chain {
    points: [number, number][];
    /** Where the chain's last segment ends (the point its successor would start at). */
    tail: [number, number];
    closed: boolean;
}

/** The segments chained through their shared edges: open chains from their true starts first. */
function walk(segments: readonly Segment[], next: Map<number, number>): Chain[] {
    const used = new Uint8Array(segments.length);
    const startsSomething = new Set(segments.map((s) => s.to));
    const all = Array.from(segments.keys());
    const order = [...all.filter((i) => !startsSomething.has(segments[i].from)), ...all];
    const chains: Chain[] = [];
    for (const first of order) {
        if (used[first]) continue;
        const points: [number, number][] = [];
        let i: number | undefined = first;
        let tail = segments[first].end;
        let closed = false;
        while (i !== undefined && !used[i]) {
            used[i] = 1;
            points.push(segments[i].point);
            tail = segments[i].end;
            const following = next.get(segments[i].to);
            if (following === first) {
                closed = true;
                break;
            }
            i = following;
        }
        chains.push({ points, tail, closed });
    }
    return chains;
}

const gap = (a: readonly [number, number], b: readonly [number, number]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Open chains joined end to start across gaps up to `maxGap`, nearest first; the closed ones as loops. */
function joinChains(chains: Chain[], maxGap: number): Loop2D[] {
    const loops: Loop2D[] = chains.filter((c) => c.closed && c.points.length >= 3).map((c) => c.points);
    let open = chains.filter((c) => !c.closed);
    while (open.length > 0) {
        const chain = open[0];
        let best = -1;
        let bestGap = maxGap;
        for (let j = 0; j < open.length; j++) {
            const d = gap(chain.tail, open[j].points[0]);
            if (d <= bestGap) {
                bestGap = d;
                best = j;
            }
        }
        if (best < 0) {
            open = open.slice(1);
            continue;
        }
        if (best === 0) {
            const loop = [...chain.points, chain.tail];
            if (loop.length >= 3) loops.push(loop);
            open = open.slice(1);
            continue;
        }
        const other = open[best];
        const merged: Chain = {
            points: [...chain.points, chain.tail, ...other.points],
            tail: other.tail,
            closed: false,
        };
        open = [merged, ...open.filter((_, j) => j !== 0 && j !== best)];
    }
    return loops;
}
