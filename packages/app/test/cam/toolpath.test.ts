import { describe, expect, test } from "@rstest/core";
import { defaultMillMachine, millProgram } from "../../src/cam/camGcode";
import { type CamTool, cutWidthAt, defaultTools } from "../../src/cam/camTools";
import { offsetRegion, ringArea } from "../../src/cam/offset";
import { type CamOperation, levels, operationMoves } from "../../src/cam/toolpath";

const square = (s: number, x = 0, y = 0) => [
    { x, y },
    { x: x + s, y },
    { x: x + s, y: y + s },
    { x, y: y + s },
];
const tool: CamTool = { ...defaultTools()[0], diameter: 2, stepDown: 1, stepOver: 0.8 };
const h = { safeZ: 5, clearance: 1 };

function op(more: Partial<CamOperation>): CamOperation {
    return {
        id: "o",
        name: "test",
        kind: "profile",
        toolId: tool.id,
        depth: 3,
        side: "outside",
        climb: true,
        ramp: false,
        allowance: 0,
        tabs: { count: 0, width: 3, height: 1 },
        peck: 0,
        rings: [square(10)],
        points: [],
        ...more,
    };
}

const cutting = <T extends { type: string }>(m: T[]) => m.filter((x) => x.type !== "rapid");
const xs = (m: { x: number }[]) => m.map((p) => p.x);

describe("cam toolpaths", () => {
    test("levels split the depth evenly", () => {
        expect(levels(3, 1)).toEqual([-1, -2, -3]);
        expect(levels(2.5, 1)).toEqual([-2.5 / 3, (-2.5 * 2) / 3, -2.5]);
        expect(levels(0, 1)).toEqual([]);
    });

    test("offset grows and shrinks by the tool radius", () => {
        expect(Math.abs(ringArea(offsetRegion([square(10)], -1)[0]))).toBeCloseTo(64, 3);
        const grown = Math.abs(ringArea(offsetRegion([square(10)], 1)[0]));
        expect(grown).toBeCloseTo(100 + 40 + Math.PI, 1);
    });

    test("profile outside: the centre a radius off the wall, down to the full depth", () => {
        const m = cutting(operationMoves(op({}), tool, h));
        expect(Math.min(...xs(m))).toBeCloseTo(-1, 3);
        expect(Math.max(...xs(m))).toBeCloseTo(11, 3);
        expect(Math.min(...m.map((p) => p.z))).toBeCloseTo(-3, 6);
        // inside: within the square
        const inner = cutting(operationMoves(op({ side: "inside" }), tool, h));
        expect(Math.min(...xs(inner))).toBeCloseTo(1, 3);
        expect(Math.max(...xs(inner))).toBeCloseTo(9, 3);
    });

    test("tabs lift the last passes to their height, only over their stretch", () => {
        const m = cutting(operationMoves(op({ tabs: { count: 4, width: 2, height: 1 } }), tool, h));
        const bottom = m.filter((p) => Math.abs(p.z + 3) < 1e-6);
        const onTab = m.filter((p) => Math.abs(p.z + 2) < 1e-6);
        expect(bottom.length).toBeGreaterThan(0);
        expect(onTab.length).toBeGreaterThan(8);
        expect(Math.min(...m.map((p) => p.z))).toBeCloseTo(-3, 6);
    });

    test("ramp: no straight plunge below the top, z never jumps by more than the slope allows", () => {
        const m = operationMoves(op({ ramp: true }), tool, h);
        expect(m.filter((x) => x.type === "plunge" && x.z < -1e-9).length).toBe(0);
        for (let i = 1; i < m.length; i++) {
            if (m[i].type !== "feed") continue;
            const run = Math.hypot(m[i].x - m[i - 1].x, m[i].y - m[i - 1].y);
            const drop = m[i - 1].z - m[i].z;
            if (drop > 1e-6) expect(drop).toBeLessThanOrEqual(run * Math.tan((4 * Math.PI) / 180) + 1e-6);
        }
    });

    test("pocket clears the inside: rings down to the middle", () => {
        const m = cutting(operationMoves(op({ kind: "pocket", depth: 1 }), tool, h));
        expect(Math.min(...xs(m))).toBeCloseTo(1, 3);
        const nearMiddle = m.some((p) => Math.abs(p.x - 5) < 0.9 && Math.abs(p.y - 5) < 0.9);
        expect(nearMiddle).toBe(true);
    });

    test("drill pecks and retracts", () => {
        const m = operationMoves(op({ kind: "drill", points: [{ x: 3, y: 4 }], depth: 3, peck: 1 }), tool, h);
        const plunges = m.filter((x) => x.type === "plunge").map((x) => x.z);
        expect(plunges).toEqual([-1, -2, -3]);
        expect(m.at(-1)?.z).toBe(5);
    });

    test("program: header, spindle, feeds and an end; tools changed with a pause", () => {
        const tools = defaultTools();
        const p = millProgram(
            [
                op({ toolId: tools[0].id }),
                op({ id: "b", toolId: tools[1].id, kind: "pocket", depth: 1 }),
                op({ id: "c", toolId: "none" }),
            ],
            tools,
            defaultMillMachine(),
        );
        expect(p.gcode.startsWith("(Kern3D milling)\nG21 G90")).toBe(true);
        expect(p.gcode).toContain("S18000 M3");
        expect(p.gcode).toContain("M0");
        expect(p.gcode.trim().endsWith("M30")).toBe(true);
        expect(p.skipped.map((s) => s.reason)).toEqual(["noTool"]);
        expect(p.seconds).toBeGreaterThan(0);
    });

    test("V-bit width grows with depth", () => {
        const v = { ...tool, kind: "vbit" as const, angle: 90, diameter: 6 };
        expect(cutWidthAt(v, 1)).toBeCloseTo(2, 6);
        expect(cutWidthAt(v, 10)).toBe(6);
    });
});
