// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    expectedFaceDiameter,
    suggestThreadSize,
    THREAD_STANDARDS,
    threadDepth,
    threadFlankAngle,
    threadRow,
} from "../src/features/threadStandards";

describe("thread standards", () => {
    test("every designation is unique, so a stored size names one row", () => {
        const sizes = THREAD_STANDARDS.map((row) => row.size);
        expect(new Set(sizes).size).toBe(sizes.length);
    });

    test.each([
        ["M2", 2, 0.4],
        ["M8", 8, 1.25],
        ["M30", 30, 3.5],
        ["M10×1", 10, 1],
        ["G1/8", 9.728, 0.907],
        ["G1/4", 13.157, 1.337],
        ["G3/8", 16.662, 1.337],
        ["G1/2", 20.955, 1.814],
        ["1/4-28 UNF", 6.35, 0.907],
    ])("%s is ⌀%d × %d", (size, diameter, pitch) => {
        expect(threadRow(size)).toMatchObject({ diameter, pitch });
    });

    test("the forms' angles and basic depths (ISO 68-1, ISO 228)", () => {
        expect(threadFlankAngle("iso")).toBe(60);
        expect(threadFlankAngle("unified")).toBe(60);
        expect(threadFlankAngle("whitworth")).toBe(55);
        expect(threadDepth("iso", 1)).toBeCloseTo(0.541266, 5);
        expect(threadDepth("whitworth", 1)).toBeCloseTo(0.640327, 5);
    });

    test.each([
        [8, false, "M8"],
        [7.9, false, "M8"],
        [6.8, true, "M8"],
        [6.75, true, "M8"],
        [13.157, false, "G1/4"],
        [11.8, true, "G1/4"],
        [20, false, "M20"],
        [3, false, "M3"],
        [2.5, true, "M3"],
    ])("a ⌀%d face (internal: %s) suggests %s", (diameter, internal, size) => {
        expect(suggestThreadSize(diameter, internal)?.size).toBe(size);
    });

    test("a face far from every size suggests nothing", () => {
        expect(suggestThreadSize(60, false)).toBeUndefined();
        expect(suggestThreadSize(0.5, true)).toBeUndefined();
    });

    test("a bore is expected at the tap drill, a shaft at the major diameter", () => {
        const m8 = threadRow("M8")!;
        expect(expectedFaceDiameter(m8, false)).toBe(8);
        expect(expectedFaceDiameter(m8, true)).toBeCloseTo(6.75, 9);
    });
});
