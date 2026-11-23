// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import type { LaserJobData, LaserObject } from "../../src/laser/laserData";
import {
    anglePulses,
    clipPolylineY,
    defaultRotaryAxis,
    mmPerDegree,
    type RotaryJob,
    rotarySteps,
} from "../../src/laser/rotary";

function box(id: string, y: number, height: number, rotaryAngle?: number): LaserObject {
    return {
        id,
        name: id,
        kind: "vector",
        x: 0,
        y,
        width: 10,
        height,
        angle: 0,
        lockAspect: true,
        rotaryAngle,
        paths: [],
        sourceWidth: 10,
        sourceHeight: height,
        op: {} as never,
    } as LaserObject;
}

const job = (...objects: LaserObject[]): LaserJobData => ({ version: 1, origin: "center", objects });

describe("rotary chuck", () => {
    test("strips: the job's Y range in bands, each turned to its centre and moved onto the field's centre line", () => {
        const rotary: RotaryJob = { enabled: true, mode: "strips", diameter: 360 / Math.PI, stripWidth: 4 };
        // one turn = 360 mm, so 1 mm = 1°
        expect(mmPerDegree(rotary.diameter)).toBeCloseTo(1, 9);
        const steps = rotarySteps(job(box("a", 0, 10)), rotary, 0);
        expect(steps.length).toBe(3); // 10 mm in 4 mm bands
        expect(steps.map((s) => s.angle)).toEqual([0, 4, 8]);
        expect(steps[0].clipY).toEqual([0, 4]);
        expect(steps[0].shiftY).toBe(-2);
        expect(steps[2].clipY).toEqual([8, 12]);
    });

    test("index: objects grouped by their angle, in order", () => {
        const rotary: RotaryJob = { enabled: true, mode: "index", diameter: 20, stripWidth: 4 };
        const steps = rotarySteps(
            job(box("a", 0, 5, 180), box("b", 0, 5), box("c", 0, 5, 90), box("d", 0, 5, 180)),
            rotary,
            0,
        );
        expect(steps.map((s) => s.angle)).toEqual([0, 90, 180]);
        expect([...steps[2].objects!]).toEqual(["a", "d"]);
        expect(steps.every((s) => s.shiftY === 0 && s.clipY === undefined)).toBe(true);
    });

    test("a line across a band is cut at its edges; a point on the upper edge is the next band's", () => {
        const line = [
            { x: 0, y: -2 },
            { x: 10, y: 8 },
        ];
        const parts = clipPolylineY(line, 0, 4);
        expect(parts.length).toBe(1);
        expect(parts[0][0].x).toBeCloseTo(2, 9);
        expect(parts[0][0].y).toBeCloseTo(0, 9);
        expect(parts[0][1].x).toBeCloseTo(6, 9);
        expect(parts[0][1].y).toBeCloseTo(4, 9);
        // leaves and comes back: two pieces
        const zig = [
            { x: 0, y: 1 },
            { x: 1, y: 6 },
            { x: 2, y: 1 },
        ];
        expect(clipPolylineY(zig, 0, 4).length).toBe(2);
        // a line along the band's upper edge belongs to the next band
        const edge = [
            { x: 0, y: 4 },
            { x: 5, y: 4 },
        ];
        expect(clipPolylineY(edge, 0, 4).length).toBe(0);
        expect(clipPolylineY(edge, 4, 8).length).toBe(1);
    });

    test("angle to pulses, with the direction", () => {
        const axis = { ...defaultRotaryAxis(), pulsesPerRev: 3200 };
        expect(anglePulses(90, axis)).toBe(800);
        expect(anglePulses(90, { ...axis, invert: true })).toBe(-800);
    });
});
