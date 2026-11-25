// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { weldTriangles } from "../src/stlRebuild/mesh";
import { extentAlong, silhouette, silhouetteTrim } from "../src/stlRebuild/silhouette";
import { frameFor, loopArea } from "../src/stlRebuild/slices";

/** A closed box [x0,x1]×[y0,y1]×[z0,z1] as a triangle soup, outward facing. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
    const v = [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y1, z0],
        [x0, y1, z0],
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
    ];
    const quads = [
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [1, 2, 6, 5],
        [2, 3, 7, 6],
        [3, 0, 4, 7],
    ];
    const out: number[] = [];
    for (const [p, q, r, s] of quads) for (const i of [p, q, r, p, r, s]) out.push(...v[i]);
    return out;
}

describe("silhouette", () => {
    // an L: a 20×10×4 plate with a 4×10×12 upright at one end
    const mesh = weldTriangles([...box(0, 0, 0, 20, 10, 4), ...box(0, 0, 4, 4, 10, 16)]);

    test("seen along z it is the plate's 20×10 outline", () => {
        const loops = silhouette(mesh, frameFor(mesh, [0, 0, 1]));
        expect(loops).toHaveLength(1);
        expect(Math.abs(loopArea(loops[0]))).toBeCloseTo(200, 3);
    });

    test("seen along y it is the L: 20×4 + 4×12, counter-clockwise", () => {
        const loops = silhouette(mesh, frameFor(mesh, [0, 1, 0]));
        expect(loops).toHaveLength(1);
        expect(Math.abs(loopArea(loops[0]))).toBeCloseTo(128, 3);
        expect(loopArea(loops[0])).toBeGreaterThan(0);
        expect(extentAlong(mesh, [0, 1, 0])).toEqual([0, 10]);
    });

    test("the trim along y cuts the corner the L leaves out, through the whole part", () => {
        const trim = silhouetteTrim(mesh, frameFor(mesh, [0, 1, 0]), 0.01);
        expect(trim).toBeDefined();
        expect(trim?.operation).toBe("cut");
        expect(trim?.profiles).toHaveLength(2); // the box round it and the L
        expect(trim!.base).toBeLessThan(0);
        expect(trim!.base + trim!.depth).toBeGreaterThan(10);
        // along z the outline fills its own box: nothing to cut
        expect(silhouetteTrim(mesh, frameFor(mesh, [0, 0, 1]), 0.01)).toBeUndefined();
    });
});
