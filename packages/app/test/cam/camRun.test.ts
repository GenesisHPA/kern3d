// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import {
    calibratedTip,
    clock,
    frameLines,
    outsideTravel,
    parseOffsetLine,
    runFromLine,
    timeLeft,
} from "../../src/cam/camRun";

describe("program helpers", () => {
    test("offsets from $#", () => {
        expect(parseOffsetLine("[G54:-100.000,-50.500,-20.000]")).toEqual({
            name: "G54",
            values: [-100, -50.5, -20],
        });
        expect(parseOffsetLine("[TLO:1.500]")).toEqual({ name: "TLO", values: [1.5] });
        expect(parseOffsetLine("ok")).toBeUndefined();
    });

    test("run from a line restores the state and the position", () => {
        const g = [
            "G21 G90 G55",
            "S12000 M3",
            "M8",
            "G0 X10 Y20",
            "G1 Z-2 F300",
            "G1 X30 F800",
            "G1 Y40",
            "M5",
        ];
        const out = runFromLine(g, 6, 5, 200);
        expect(out).toEqual([
            "G21 G90 G55 G17 G94",
            "G0 Z5",
            "S12000 M3",
            "G4 P3",
            "M8",
            "G0 X30 Y20",
            "G1 Z-2 F200",
            "G1 F800",
            "G1 Y40",
            "M5",
        ]);
    });

    test("frame, travel check, time", () => {
        expect(frameLines({ minX: 0, minY: 0, maxX: 10, maxY: 5 }, 5, 1000)).toEqual([
            "G21 G90",
            "G0 Z5",
            "G0 X0 Y0",
            "G1 X10 F1000",
            "G1 Y5",
            "G1 X0",
            "G1 Y0",
        ]);
        const b = { minX: 0, minY: 0, minZ: -10, maxX: 100, maxY: 50 };
        expect(outsideTravel(b, [-300, -200, -30], { x: 300, y: 200, z: 60 })).toEqual([]);
        expect(outsideTravel(b, [-50, -200, -55], { x: 300, y: 200, z: 60 })).toEqual(["X", "Z"]);
        expect(timeLeft(100, 50, 100, 60)).toBeCloseTo(60);
        expect(clock(3725)).toBe("1:02:05");
        expect(calibratedTip(2, 20, 19.9)).toBe(2.1);
    });
});
