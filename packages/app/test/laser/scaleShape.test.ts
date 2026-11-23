// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { defaultScale, scaleLabel, scalePaths, scaleTicks } from "../../src/laser/scaleShape";

const font = { family: "ГОСТ тип Б", stroke: "gost-b" };

describe("engraved scale", () => {
    test("a dial round a part: 0…355° every 5°, long every 10°, the 360° tick left out (it is 0°)", () => {
        const spec = defaultScale(94.2, true, font);
        const ticks = scaleTicks(spec);
        expect(ticks.length).toBe(72);
        expect(ticks[0]).toEqual({ y: 0, value: 0, kind: "major" });
        expect(ticks[1].kind).toBe("minor");
        expect(ticks[71].value).toBe(355);
        expect(ticks[71].y).toBeCloseTo((355 / 360) * 94.2, 9);
    });

    test("reversed: values grow the other way along it", () => {
        const spec = { ...defaultScale(100, false, font), reverse: true };
        const ticks = scaleTicks(spec);
        expect(ticks[0].y).toBe(100);
        expect(ticks.at(-1)!.y).toBeCloseTo(0, 9);
    });

    test("ticks are open strokes of their kind's length, the figures beside the long ones", () => {
        const spec = {
            ...defaultScale(36, true, font),
            to: 36,
            step: 6,
            majorEvery: 2,
            labelEvery: 1,
            skipLast: false,
        };
        // a stand-in for the font: every figure a 1 × size box
        const paths = scalePaths(spec, {} as never, (_text, size) => [
            {
                closed: true,
                points: [
                    { x: 0, y: 0 },
                    { x: 1, y: 0 },
                    { x: 1, y: size },
                ],
            },
        ]);
        const ticks = paths.filter((p) => !p.closed);
        expect(ticks.length).toBe(7);
        expect(ticks[0].points[1].x).toBe(spec.majorLength);
        expect(ticks[1].points[1].x).toBe(spec.minorLength);
        // 0, 12, 24, 36 are long and labelled
        expect(paths.filter((p) => p.closed).length).toBe(4);
    });

    test("figures: decimals, a minus sign, the suffix", () => {
        expect(scaleLabel(90, { decimals: 0, suffix: "°" })).toBe("90°");
        expect(scaleLabel(-2.5, { decimals: 1, suffix: " мм" })).toBe("−2.5 мм");
    });

    test("a thick line: passes side by side across the tick, the figures untouched", () => {
        const spec = {
            ...defaultScale(10, false, font),
            to: 10,
            step: 10,
            majorEvery: 1,
            labels: false,
            baseline: false,
            lineWidth: 0.2,
            linePitch: 0.05,
        };
        const paths = scalePaths(spec, undefined, () => []);
        // two ticks (0 and 10), each 0.2 / 0.05 + 1 = 5 passes
        expect(paths.length).toBe(10);
        const ys = paths.slice(0, 5).map((p) => p.points[0].y);
        expect(Math.min(...ys)).toBeCloseTo(-0.1, 9);
        expect(Math.max(...ys)).toBeCloseTo(0.1, 9);
    });
});
