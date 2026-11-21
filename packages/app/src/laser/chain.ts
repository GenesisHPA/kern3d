// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { cleanPath, distance, type LaserPath, type Pt } from "./geometry";

function key(p: Pt, eps: number): string {
    return `${Math.round(p.x / eps)}_${Math.round(p.y / eps)}`;
}

/**
 * Joins open pieces whose ends meet (within `eps`) into longer polylines, closing a chain that
 * comes back to its start: the edges a projection hands over one by one become the outlines a
 * fill needs and a laser traces without stopping. Closed paths pass through untouched.
 */
export function chainPaths(paths: readonly LaserPath[], eps = 0.01): LaserPath[] {
    const result: LaserPath[] = [];
    const open: Pt[][] = [];
    for (const p of paths) {
        if (p.closed) result.push(p);
        else if (p.points.length > 1) open.push([...p.points]);
    }
    const byEnd = new Map<string, number[]>();
    const add = (p: Pt, i: number) => {
        const k = key(p, eps);
        const list = byEnd.get(k);
        if (list === undefined) byEnd.set(k, [i]);
        else list.push(i);
    };
    open.forEach((pts, i) => {
        add(pts[0], i);
        add(pts[pts.length - 1], i);
    });
    const used = new Uint8Array(open.length);
    const takeAt = (p: Pt): Pt[] | undefined => {
        const list = byEnd.get(key(p, eps));
        if (list === undefined) return undefined;
        for (const i of list) {
            if (used[i]) continue;
            const pts = open[i];
            if (distance(pts[0], p) <= eps * 1.5) {
                used[i] = 1;
                return pts;
            }
            if (distance(pts[pts.length - 1], p) <= eps * 1.5) {
                used[i] = 1;
                return [...pts].reverse();
            }
        }
        return undefined;
    };
    for (let i = 0; i < open.length; i++) {
        if (used[i]) continue;
        used[i] = 1;
        const chain = [...open[i]];
        // grow forward, then backward
        for (
            let next = takeAt(chain[chain.length - 1]);
            next !== undefined;
            next = takeAt(chain[chain.length - 1])
        ) {
            chain.push(...next.slice(1));
        }
        for (let prev = takeAt(chain[0]); prev !== undefined; prev = takeAt(chain[0])) {
            chain.unshift(...prev.reverse().slice(0, -1));
        }
        const closed = chain.length > 2 && distance(chain[0], chain[chain.length - 1]) <= eps * 1.5;
        if (closed) chain.pop();
        result.push(cleanPath({ points: chain, closed }, eps / 10));
    }
    return result;
}
