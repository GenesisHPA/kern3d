// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { estimateSeconds, programLines, programPath } from "../src/gcodePath";

describe("programPath", () => {
    test("rapids and cuts, absolute, with bounds from the cuts only", () => {
        const p = programPath(["G21 G90", "G0 X10 Y0 Z5", "G1 Z-1 F300", "X20", "Y15", "G0 Z50"]);
        expect(p.segments.map((s) => s.rapid)).toEqual([true, false, false, false, true]);
        expect(p.segments[3].to).toEqual([20, 15, -1]);
        expect(p.min).toEqual([10, 0, -1]);
        expect(p.max).toEqual([20, 15, 5]);
    });

    test("relative moves and inches", () => {
        const p = programPath(["G20 G91", "G1 X1 Y1", "X1"]);
        expect(p.segments[1].to[0]).toBeCloseTo(50.8, 6);
        expect(p.segments[1].to[1]).toBeCloseTo(25.4, 6);
    });

    test("a clockwise half circle is cut into short pieces ending exactly at the target", () => {
        const p = programPath(["G90 G1 X0 Y0", "G2 X20 Y0 I10 J0"]);
        const arc = p.segments.filter((s) => s.line === 1);
        expect(arc.length).toBeGreaterThan(20);
        expect(arc.at(-1)!.to).toEqual([20, 0, 0]);
        // clockwise from (0,0) round (10,0) to (20,0) passes over the top
        expect(Math.max(...arc.map((s) => s.to[1]))).toBeCloseTo(10, 0);
    });

    test("machine-coordinate moves and probing are left out", () => {
        const p = programPath(["G53 G0 Z-5", "G38.2 Z-20 F100", "G1 X5"]);
        expect(p.segments).toHaveLength(1);
        expect(p.segments[0].line).toBe(2);
    });

    test("comments are ignored", () => {
        const p = programPath(["G1 X5 (X99 not this) ; Y77 nor this"]);
        expect(p.segments[0].to).toEqual([5, 0, 0]);
    });
});

describe("programLines / estimateSeconds", () => {
    test("blank lines and % are dropped", () => {
        expect(programLines("%\r\nG0 X1\n\n  G1 Y2  \n%")).toEqual(["G0 X1", "G1 Y2"]);
    });

    test("60 mm at F600 takes 6 s", () => {
        expect(estimateSeconds(["G1 X60 F600"])).toBeCloseTo(6, 6);
    });
});
