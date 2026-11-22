// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { profileArea } from "../src/stlRebuild/fit2d";
import { dot, normalize, type Vec3, weldTriangles } from "../src/stlRebuild/mesh";
import { axisThrough, clipHalf, planRevolve, radiusOf } from "../src/stlRebuild/revolve";

/**
 * A closed solid of revolution about `axis` through `at`: the profile [(h, r), …] from the axis
 * up and back to it, turned in `n` steps, as a triangle soup.
 */
function revolved(profile: [number, number][], axis: Vec3, at: Vec3, n: number): number[] {
    const z = normalize(axis);
    const x = normalize(Math.abs(z[0]) < 0.9 ? [0, z[2], -z[1]] : [z[2], 0, -z[0]]);
    const y: Vec3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const p = ([h, r]: [number, number], i: number): number[] => {
        const a = (2 * Math.PI * i) / n;
        return [0, 1, 2].map((d) => at[d] + z[d] * h + (x[d] * Math.cos(a) + y[d] * Math.sin(a)) * r);
    };
    const soup: number[] = [];
    for (let k = 0; k + 1 < profile.length; k++) {
        const a = profile[k];
        const b = profile[k + 1];
        for (let i = 0; i < n; i++) {
            const j = i + 1;
            if (a[1] > 0) soup.push(...p(a, i), ...p(a, j), ...p(b, j));
            if (b[1] > 0) soup.push(...p(a, i), ...p(b, j), ...p(b, i));
        }
    }
    return soup;
}

// a stepped shaft with a cone between the steps: r 6 for 0..10, cone to r 4 at 14, r 4 to 24
const SHAFT: [number, number][] = [
    [0, 0],
    [0, 6],
    [10, 6],
    [14, 4],
    [24, 4],
    [24, 0],
];

describe("STL revolve pieces", () => {
    test("the axis of an oblique shaft is found where its normals meet", () => {
        const axis = normalize([1, 2, 3]);
        const at: Vec3 = [5, -3, 7];
        const mesh = weldTriangles(revolved(SHAFT, axis, at, 48));
        const fit = axisThrough(mesh, axis)!;
        expect(fit.rms).toBeLessThan(1e-9);
        expect(radiusOf(fit.point, at, axis)).toBeLessThan(1e-9);
    });

    test("a polygon clipped to one side of the axis", () => {
        const half = clipHalf(
            [
                [0, -2],
                [4, -2],
                [4, 2],
                [0, 2],
            ],
            0,
        );
        expect(half).toEqual([
            [4, 0],
            [4, 2],
            [0, 2],
            [0, 0],
        ]);
    });

    test("the shaft is planned as its half-section revolved, about the right axis", () => {
        const axis = normalize([0, 1, 1]);
        const at: Vec3 = [2, 0, -1];
        const mesh = weldTriangles(revolved(SHAFT, axis, at, 96));
        const plan = planRevolve(mesh, 0.01)!;
        expect(plan).toBeDefined();
        expect(Math.abs(dot(plan.direction, axis))).toBeGreaterThan(0.999999);
        expect(radiusOf(plan.point, at, axis)).toBeLessThan(1e-6);
        // half-section area: 10·6 + (6+4)/2·4 + 10·4 = 120, the facets' chords taking a little
        const area = plan.profiles.reduce((s, p) => s + Math.abs(profileArea(p)), 0);
        expect(area).toBeGreaterThan(118);
        expect(area).toBeLessThan(120.5);
    });

    test("a box is no surface of revolution", () => {
        const box: number[] = [];
        const v = (x: number, y: number, z: number) => [x * 10, y * 6, z * 4];
        const quad = (a: number[], b: number[], c: number[], d: number[]) =>
            box.push(...a, ...b, ...c, ...a, ...c, ...d);
        quad(v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0));
        quad(v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1));
        quad(v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1));
        quad(v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0));
        quad(v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0));
        quad(v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1));
        expect(planRevolve(weldTriangles(box), 0.01)).toBeUndefined();
    });
});
