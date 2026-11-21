// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { chainPaths } from "../../src/laser/chain";
import { arcSegments, flattenCubic, flattenSvgArc } from "../../src/laser/flatten";
import type { LaserPath, Pt } from "../../src/laser/geometry";
import { hatchPaths } from "../../src/laser/hatch";
import { orderPaths } from "../../src/laser/pathOrder";

const square = (x: number, y: number, s: number): LaserPath => ({
    closed: true,
    points: [
        { x, y },
        { x: x + s, y },
        { x: x + s, y: y + s },
        { x, y: y + s },
    ],
});

function pointLineDistance(p: Pt, a: Pt, b: Pt) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / Math.hypot(dx, dy);
}

describe("flattening", () => {
    test("a cubic stays within tolerance of its chords", () => {
        const p0 = { x: 0, y: 0 };
        const out: Pt[] = [];
        flattenCubic(p0, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }, 0.05, out);
        expect(out[out.length - 1]).toEqual({ x: 10, y: 0 });
        expect(out.length).toBeGreaterThan(8);
        // sample the true curve and check it is near the polyline
        const pts = [p0, ...out];
        const bez = (t: number) => ({
            x: 3 * (1 - t) * t * t * 10 + t ** 3 * 10,
            y: 3 * (1 - t) ** 2 * t * 10 + 3 * (1 - t) * t * t * 10,
        });
        for (let k = 0; k <= 100; k++) {
            const q = bez(k / 100);
            let best = Infinity;
            for (let i = 0; i + 1 < pts.length; i++)
                best = Math.min(best, pointLineDistance(q, pts[i], pts[i + 1]));
            expect(best).toBeLessThan(0.06);
        }
    });

    test("a half circle arc ends on its end point and keeps to the radius", () => {
        const out: Pt[] = [];
        flattenSvgArc({ x: 0, y: 0 }, 5, 5, 0, false, true, { x: 10, y: 0 }, 0.05, out);
        expect(out[out.length - 1]).toEqual({ x: 10, y: 0 });
        for (const p of out) expect(Math.hypot(p.x - 5, p.y)).toBeCloseTo(5, 6);
        expect(out.length).toBe(arcSegments(5, Math.PI, 0.05));
    });
});

describe("path order", () => {
    test("nearest neighbour picks the closest path and reverses an open one", () => {
        const far: LaserPath = {
            closed: false,
            points: [
                { x: 100, y: 0 },
                { x: 101, y: 0 },
            ],
        };
        const near: LaserPath = {
            closed: false,
            points: [
                { x: 5, y: 0 },
                { x: 1, y: 0 },
            ],
        };
        const order = orderPaths([far, near], { x: 0, y: 0 });
        expect(order[0]).toEqual([
            { x: 1, y: 0 },
            { x: 5, y: 0 },
        ]);
        expect(order[1]).toEqual([
            { x: 100, y: 0 },
            { x: 101, y: 0 },
        ]);
    });

    test("a closed path is entered at its nearest vertex and returns to it", () => {
        const [trace] = orderPaths([square(0, 0, 10)], { x: 11, y: 11 });
        expect(trace[0]).toEqual({ x: 10, y: 10 });
        expect(trace[trace.length - 1]).toEqual({ x: 10, y: 10 });
        expect(trace).toHaveLength(5);
    });
});

describe("hatch", () => {
    test("a 10 mm square at 1 mm fills with 10 bidirectional lines", () => {
        const lines = hatchPaths([square(0, 0, 10)], 1, 0);
        expect(lines).toHaveLength(10);
        expect(lines[0]).toEqual({ from: { x: 0, y: 0.5 }, to: { x: 10, y: 0.5 } });
        expect(lines[1]).toEqual({ from: { x: 10, y: 1.5 }, to: { x: 0, y: 1.5 } });
    });

    test("even-odd leaves a hole empty", () => {
        const lines = hatchPaths([square(0, 0, 10), square(3, 3, 4)], 1, 0);
        const at5 = lines.filter((l) => Math.abs(l.from.y - 5.5) < 1e-9);
        expect(at5).toHaveLength(2);
        const xs = at5.flatMap((l) => [l.from.x, l.to.x]).sort((a, b) => a - b);
        expect(xs).toEqual([0, 3, 7, 10]);
    });

    test("a 90° hatch runs along y", () => {
        const lines = hatchPaths([square(0, 0, 10)], 2, 90);
        expect(lines).toHaveLength(5);
        for (const l of lines) expect(l.from.x).toBeCloseTo(l.to.x, 9);
    });
});

describe("chaining", () => {
    test("edges meeting end to end close into one outline", () => {
        const pieces: LaserPath[] = [
            {
                closed: false,
                points: [
                    { x: 0, y: 0 },
                    { x: 10, y: 0 },
                ],
            },
            {
                closed: false,
                points: [
                    { x: 10, y: 10 },
                    { x: 10, y: 0 },
                ],
            },
            {
                closed: false,
                points: [
                    { x: 10, y: 10 },
                    { x: 0, y: 10 },
                ],
            },
            {
                closed: false,
                points: [
                    { x: 0, y: 10 },
                    { x: 0, y: 0 },
                ],
            },
        ];
        const chained = chainPaths(pieces);
        expect(chained).toHaveLength(1);
        expect(chained[0].closed).toBe(true);
        expect(chained[0].points).toHaveLength(4);
    });
});
