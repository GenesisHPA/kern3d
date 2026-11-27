// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { ClosestPointGrid, closestOnTriangle } from "../../src/scanTools/closestPoint";
import { weldTriangles } from "../../src/stlRebuild/mesh";
import { plateWithHole, seeded, soupOf } from "./meshes";

function bruteForce(soup: Float64Array, x: number, y: number, z: number): number {
    let best = Number.POSITIVE_INFINITY;
    const q: [number, number, number] = [0, 0, 0];
    for (let o = 0; o < soup.length; o += 9) {
        closestOnTriangle(soup, o, x, y, z, q);
        best = Math.min(best, Math.hypot(x - q[0], y - q[1], z - q[2]));
    }
    return best;
}

describe("closestOnTriangle", () => {
    const tri = [0, 0, 0, 10, 0, 0, 0, 10, 0];
    test.each([
        [
            [2, 2, 5],
            [2, 2, 0],
        ],
        [
            [-3, -3, 1],
            [0, 0, 0],
        ],
        [
            [20, -1, 0],
            [10, 0, 0],
        ],
        [
            [5, -4, 0],
            [5, 0, 0],
        ],
        [
            [8, 8, 0],
            [5, 5, 0],
        ],
    ])("%j → %j", (p, expected) => {
        const out: [number, number, number] = [0, 0, 0];
        closestOnTriangle(tri, 0, p[0], p[1], p[2], out);
        for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(expected[k], 9);
    });
});

describe("ClosestPointGrid", () => {
    const soup = soupOf(weldTriangles(plateWithHole(40, 10, 6, 32, 2, 2)));
    const grid = new ClosestPointGrid(soup);

    test("matches a brute-force search, inside, outside and far away", () => {
        const random = seeded(5);
        for (let i = 0; i < 300; i++) {
            const span = i < 200 ? 50 : 400;
            const [x, y, z] = [
                (random() - 0.5) * span,
                (random() - 0.5) * span,
                (random() - 0.5) * span * 0.5,
            ];
            const hit = grid.closest(x, y, z)!;
            expect(hit.distance).toBeCloseTo(bruteForce(soup, x, y, z), 9);
        }
    });

    test("the sign: negative inside the material, positive outside and in the hole", () => {
        expect(grid.closest(15, 15, 5)!.signed).toBeCloseTo(-5, 9);
        expect(grid.closest(15, 15, 12)!.signed).toBeCloseTo(2, 9);
        expect(grid.closest(0, 0, 5)!.signed).toBeGreaterThan(5);
        // beyond a corner of the plate: the corner itself is nearest, the side is outside
        expect(grid.closest(22, 22, 11)!.signed).toBeGreaterThan(0);
        expect(grid.closest(19.5, 19.5, 9.5)!.signed).toBeLessThan(0);
    });

    test("maxDistance: nothing that far", () => {
        expect(grid.closest(100, 100, 100, 10)).toBeUndefined();
        expect(new ClosestPointGrid(new Float64Array(0)).closest(0, 0, 0)).toBeUndefined();
    });
});
