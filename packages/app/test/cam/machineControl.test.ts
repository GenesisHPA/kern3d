// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { goZeroLines, jogLine, parseSetting, probeLines } from "../../src/cam/machineControl";
import { parseStatus } from "../../src/laser/grblController";

describe("machine control", () => {
    test("jog lines are relative mm with a feed", () => {
        expect(jogLine({ X: 1 }, 1000)).toBe("$J=G91 G21 X1 F1000");
        expect(jogLine({ X: -0.01, Y: 0.1 }, 500.4)).toBe("$J=G91 G21 X-0.01 Y0.1 F500");
        expect(jogLine({}, 1000)).toBeUndefined();
        expect(jogLine({ Z: 1 }, 0)).toBeUndefined();
    });

    test("probe sets Z to the plate and backs off", () => {
        const l = probeLines({ thickness: 20, travel: 30, feed: 100, retract: 5 });
        expect(l).toEqual(["G21 G91", "G38.2 Z-30 F100", "G10 L20 P0 Z20", "G0 Z5", "G90"]);
    });

    test("go to zero lifts first", () => {
        expect(goZeroLines(5, "xy")).toEqual(["G90 G21", "G0 Z5", "G0 X0 Y0"]);
    });

    test("settings and status fields", () => {
        expect(parseSetting("$100=800.000")).toEqual({ id: 100, value: "800.000" });
        expect(parseSetting("ok")).toBeUndefined();
        const s = parseStatus("<Idle|MPos:1,2,3|FS:0,0|Pn:XP|Ov:120,50,90|A:SM>");
        expect(s?.overrides).toEqual([120, 50, 90]);
        expect(s?.pins).toBe("XP");
        expect(s?.accessories).toBe("SM");
    });
});
