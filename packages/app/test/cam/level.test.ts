// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { gridPoints, type HeightMap, heightAt, levelProgram } from "../../src/cam/camLevel";

describe("height map", () => {
    const m: HeightMap = { minX: 0, minY: 0, maxX: 10, maxY: 10, nx: 2, ny: 2, z: [0, 1, 0, 1] };

    test("grid in a snake", () => {
        const p = gridPoints({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 2, 2);
        expect(p).toEqual([
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
        ]);
    });

    test("bilinear, clamped outside", () => {
        expect(heightAt(m, 5, 5)).toBeCloseTo(0.5);
        expect(heightAt(m, 20, 0)).toBeCloseTo(1);
    });

    test("feeds are split and lifted", () => {
        const out = levelProgram(["G90", "G0 X0 Y0 Z1", "G1 Z-0.5 F100", "G1 X10 F500"], m, 5);
        expect(out).toEqual([
            "G90",
            "G0 X0 Y0 Z1",
            "G1 X0 Y0 Z-0.5 F100",
            "G1 X5 Y0 Z0 F500",
            "G1 X10 Y0 Z0.5",
        ]);
    });
});
