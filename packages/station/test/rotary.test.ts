// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { parseStatus } from "@chili3d/app/src/laser/grblController";
import {
    controllerHasA,
    defaultRotary,
    fluidncLines,
    parseRotary,
    stepsPerDegree,
    surfacePerDegree,
} from "../src/rotary";

describe("the 4th axis", () => {
    test("steps per degree: 200 steps × 16 microsteps × 1:6 over 360°", () => {
        const s = { ...defaultRotary(), stepsPerRev: 200, microsteps: 16, ratio: 6 };
        expect(stepsPerDegree(s)).toBeCloseTo(53.333, 3);
        expect(surfacePerDegree({ ...s, diameter: 36 })).toBeCloseTo(0.31416, 4);
    });

    test("the FluidNC lines set A and save the config", () => {
        const lines = fluidncLines({
            ...defaultRotary(),
            stepsPerRev: 200,
            microsteps: 8,
            ratio: 1,
            maxRate: 7200,
        });
        expect(lines).toEqual([
            "$/axes/a/steps_per_mm=4.4444",
            "$/axes/a/max_rate_mm_per_min=7200",
            "$/axes/a/acceleration_mm_per_sec2=180",
            "$CD=config.yaml",
        ]);
    });

    test("settings from storage: bad values fall back, along is X or Y", () => {
        const s = parseRotary('{"installed":true,"along":"Z","ratio":-3,"microsteps":32}');
        expect(s).toMatchObject({ installed: true, along: "X", ratio: 6, microsteps: 32 });
        expect(parseRotary("not json")).toEqual(defaultRotary());
    });

    test("which controllers drive A", () => {
        expect(controllerHasA("Grbl 3.7 [FluidNC v3.7.8 (wifi) '$' for help]")).toBe(true);
        expect(controllerHasA("GrblHAL 1.1f ['$' or '$HELP' for help]")).toBe(true);
        expect(controllerHasA("Grbl 1.1h ['$' for help]")).toBe(false);
        expect(controllerHasA(undefined)).toBe(false);
    });

    test("a four-axis status gives A; a three-axis one does not", () => {
        const s = parseStatus("<Idle|MPos:1.000,2.000,3.000,90.000|FS:0,0|WCO:0.000,0.000,0.000,30.000>");
        expect(s?.mpos).toEqual([1, 2, 3]);
        expect(s?.a).toEqual({ m: 90, w: 60 });
        // WPos with the offset from an earlier report
        expect(parseStatus("<Idle|WPos:0,0,0,10|FS:0,0>", [0, 0, 0, 5])?.a).toEqual({ m: 15, w: 10 });
        expect(parseStatus("<Idle|MPos:1,2,3|FS:0,0>")?.a).toBeUndefined();
    });
});
