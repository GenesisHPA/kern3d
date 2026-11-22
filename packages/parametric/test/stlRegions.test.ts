// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { dot, normalize, type Vec3, weldTriangles } from "../src/stlRebuild/mesh";
import { regionAxes, regionAxis, smoothRegions, symmetricEigen } from "../src/stlRebuild/regions";
import { sliceFrames } from "../src/stlRebuild/slices";

/** A closed faceted cylinder of `n` sides along `axis`, as a triangle soup. */
function cylinder(axis: Vec3, r: number, h: number, n: number, at: Vec3 = [0, 0, 0]): number[] {
    const z = normalize(axis);
    const x = normalize(Math.abs(z[0]) < 0.9 ? [0, z[2], -z[1]] : [z[2], 0, -z[0]]);
    const y: Vec3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const p = (i: number, top: boolean): number[] => {
        const a = (2 * Math.PI * i) / n;
        const c = Math.cos(a) * r;
        const s = Math.sin(a) * r;
        const k = top ? h : 0;
        return [0, 1, 2].map((d) => at[d] + x[d] * c + y[d] * s + z[d] * k);
    };
    const centre = (top: boolean) => [0, 1, 2].map((d) => at[d] + (top ? z[d] * h : 0));
    const soup: number[] = [];
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        soup.push(...p(i, false), ...p(j, false), ...p(j, true));
        soup.push(...p(i, false), ...p(j, true), ...p(i, true));
        soup.push(...centre(true), ...p(i, true), ...p(j, true));
        soup.push(...centre(false), ...p(j, false), ...p(i, false));
    }
    return soup;
}

describe("STL regions", () => {
    test("Jacobi eigen of a diagonal-ish matrix, smallest first", () => {
        const { values, vectors } = symmetricEigen([
            [4, 1, 0],
            [1, 3, 0],
            [0, 0, 0.5],
        ]);
        expect(values[0]).toBeCloseTo(0.5, 9);
        expect(Math.abs(vectors[0][2])).toBeCloseTo(1, 9);
        expect(values[2]).toBeCloseTo((7 + Math.sqrt(5)) / 2, 9);
    });

    test("a 24-sided cylinder is three regions: the side and two caps", () => {
        const mesh = weldTriangles(cylinder([0, 0, 1], 5, 10, 24));
        const regions = smoothRegions(mesh);
        expect(regions).toHaveLength(3);
        const side = regions.find((r) => r.length === 48);
        expect(side).toBeDefined();
        const axis = regionAxis(mesh, side!)!.axis;
        expect(Math.abs(axis[2])).toBeCloseTo(1, 6);
    });

    test("an oblique cylinder names its own axis, and slicing is offered along it", () => {
        const tilt = normalize([1, 0, 2]);
        const mesh = weldTriangles(cylinder(tilt, 5, 20, 32));
        const axes = regionAxes(mesh);
        expect(axes.length).toBeGreaterThan(0);
        expect(Math.abs(dot(axes[0], tilt))).toBeGreaterThan(0.9999);
        const frames = sliceFrames(mesh);
        expect(Math.abs(dot(frames[0].axis, tilt))).toBeGreaterThan(0.9999);
    });

    test("an axis a degree off the world z is taken as z", () => {
        const off = normalize([Math.tan((1 * Math.PI) / 180), 0, 1]);
        const axes = regionAxes(weldTriangles(cylinder(off, 5, 20, 32)));
        expect(axes[0]).toEqual([0, 0, 1]);
    });
});
