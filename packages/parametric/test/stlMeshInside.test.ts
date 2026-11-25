// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { MeshInside } from "../src/stlRebuild/meshInside";

/** A closed box [0,a]×[0,b]×[0,c] as a triangle soup. */
function box(a: number, b: number, c: number): number[] {
    const v = [
        [0, 0, 0],
        [a, 0, 0],
        [a, b, 0],
        [0, b, 0],
        [0, 0, c],
        [a, 0, c],
        [a, b, c],
        [0, b, c],
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

describe("MeshInside", () => {
    const inside = new MeshInside(box(10, 20, 5));

    test("points inside, outside, beside, above and below", () => {
        expect(inside.contains(3.3, 7.1, 2.2)).toBe(true);
        expect(inside.contains(9.9, 19.9, 0.1)).toBe(true);
        expect(inside.contains(11, 7, 2)).toBe(false);
        expect(inside.contains(3.3, 7.1, 6)).toBe(false);
        expect(inside.contains(3.3, 7.1, -1)).toBe(false);
        expect(inside.contains(-50, -50, 2)).toBe(false);
    });

    test("a ray along the diagonal edge of the cap triangles is not trusted, never wrong", () => {
        // (5, 10) lies on the diagonal splitting the top and bottom quads
        const r = inside.contains(5, 10, 2);
        expect(r === undefined || r === true).toBe(true);
    });

    test("a mesh with a hole gives no answer where the rays disagree", () => {
        const open = box(10, 10, 10).slice(0, 9 * 10); // the last face (two triangles) missing
        const m = new MeshInside(open);
        // a vertical ray through the open side's shadow still crosses top and bottom: agrees
        expect(m.contains(5.1, 5.3, 5)).toBe(true);
        const top = new MeshInside(box(10, 10, 10).slice(9 * 2)); // the bottom missing
        expect(top.contains(5.1, 5.3, 5)).toBeUndefined();
    });
});
