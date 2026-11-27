// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { defaultMillMachine, isKnifeJob, millProgram } from "../../src/cam/camGcode";
import { runFromLine, startsSpindle, withoutSpindle } from "../../src/cam/camRun";
import {
    type CamTool,
    defaultKnife,
    defaultTools,
    type KnifeSettings,
    parseTool,
} from "../../src/cam/camTools";
import { bladeTrace, knifeLineMoves, knifeRingMoves } from "../../src/cam/dragKnife";
import type { Pt } from "../../src/cam/offset";
import { type CamOperation, type MillMove, operationMoves } from "../../src/cam/toolpath";

const h = { safeZ: 5, clearance: 1 };
const k: KnifeSettings = { ...defaultKnife(), offset: 0.25, cornerAngle: 30, overcut: 1, corners: "loop" };
const square: Pt[] = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
];
const triangle: Pt[] = [
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    { x: 15, y: 25 },
];
const circle = (r: number, n: number): Pt[] =>
    Array.from({ length: n }, (_, i) => ({
        x: r * Math.cos((2 * Math.PI * i) / n),
        y: r * Math.sin((2 * Math.PI * i) / n),
    }));

const tools = defaultTools();
const mill = tools.find((x) => x.kind === "flat")!;
const knife = tools.find((x) => x.kind === "knife")!;

function op(more: Partial<CamOperation>): CamOperation {
    return {
        id: "o",
        name: "cut",
        kind: "profile",
        toolId: knife.id,
        depth: 0.3,
        side: "on",
        climb: true,
        ramp: false,
        allowance: 0,
        tabs: { count: 0, width: 3, height: 1 },
        peck: 0,
        rings: [square],
        points: [],
        ...more,
    };
}

/** Distance from p to the closed (or open) polyline. */
function distanceTo(p: Pt, pts: Pt[], closed = true): number {
    let best = Infinity;
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
    }
    return best;
}

/** The blade's tip on every cutting move (below the top), followed finely. */
function cutTrace(moves: MillMove[], offset: number) {
    return bladeTrace(moves, offset, 0.005).filter((p) => p.cutting);
}

/** Axis points of the moves at depth z that lie on a circle of the offset about `corner`. */
function swivelPoints(moves: MillMove[], corner: Pt, offset: number) {
    return moves.filter(
        (m) => m.type === "feed" && Math.abs(Math.hypot(m.x - corner.x, m.y - corner.y) - offset) < 1e-6,
    );
}

describe("drag knife compensation", () => {
    test.each([
        ["square", square],
        ["triangle", triangle],
    ])("the blade's tip follows a %s's outline, corners included", (_name, ring) => {
        const moves = knifeRingMoves(ring, [-0.3], k, h);
        const trace = cutTrace(moves, k.offset);
        expect(trace.length).toBeGreaterThan(ring.length * 4);
        const worst = Math.max(...trace.map((p) => distanceTo(p, ring)));
        expect(worst).toBeLessThan(0.02);
        // the tip reaches every corner (the blade swivels on it), not cutting it short
        for (const c of ring)
            expect(Math.min(...trace.map((p) => Math.hypot(p.x - c.x, p.y - c.y)))).toBeLessThan(0.02);
    });

    test("the axis runs ahead of the tip by the offset and loops round sharp corners", () => {
        const moves = knifeRingMoves(square, [-0.3], k, h);
        // on the bottom edge (going +x) the axis is 0.25 ahead: it reaches x = 20.25 at y = 0
        expect(
            moves.some((m) => m.type === "feed" && Math.abs(m.x - 20.25) < 1e-9 && Math.abs(m.y) < 1e-9),
        ).toBe(true);
        // each 90° corner: a quarter arc of radius 0.25 about the corner, in the material
        for (const c of square) {
            const arc = swivelPoints(moves, c, 0.25).filter((m) => m.z === -0.3);
            expect(arc.length).toBeGreaterThanOrEqual(3);
        }
    });

    test("a circle in short steps needs no loops: the tip still stays on it", () => {
        const ring = circle(10, 120);
        const moves = knifeRingMoves(ring, [-0.3], k, h);
        const cutting = moves.filter((m) => m.type === "feed" && m.z === -0.3);
        for (const m of cutting) {
            const r = Math.hypot(m.x, m.y);
            // never inside the polygon's sides (their middles are at R cos(π/n))
            expect(r).toBeGreaterThan(10 * Math.cos(Math.PI / 120) - 1e-6);
            expect(r).toBeLessThan(10.25);
        }
        // no swivel arcs: two points per step (end of one stretch, start of the next), plus the overcut
        expect(cutting.length).toBeLessThan(120 * 2 + 10);
        const trace = cutTrace(moves, k.offset);
        expect(Math.max(...trace.map((p) => Math.abs(Math.hypot(p.x, p.y) - 10)))).toBeLessThan(0.02);
    });

    test("a corner at the threshold goes straight on, one past it swivels", () => {
        const bend = (deg: number): Pt[] => {
            const a = (deg * Math.PI) / 180;
            return [
                { x: -10, y: 0 },
                { x: 0, y: 0 },
                { x: 10 * Math.cos(a), y: 10 * Math.sin(a) },
            ];
        };
        const corner = { x: 0, y: 0 };
        const at = knifeLineMoves(bend(30), [-0.3], k, h);
        const past = knifeLineMoves(bend(31), [-0.3], k, h);
        // at 30°: only the two ends of the stretches touch the circle about the corner
        expect(swivelPoints(at, corner, 0.25).length).toBe(2);
        expect(swivelPoints(past, corner, 0.25).length).toBeGreaterThan(2);
    });

    test("lift mode: up to the top at a sharp corner, swivel there, straight down again", () => {
        const moves = knifeRingMoves(square, [-0.3], { ...k, corners: "lift" }, h);
        const corner = { x: 20, y: 0 };
        const arc = swivelPoints(moves, corner, 0.25);
        // the arc's inner points are at Z 0 (the surface), not in the material
        const inner = arc.filter((m) => m.z === 0);
        expect(inner.length).toBeGreaterThanOrEqual(2);
        const i = moves.indexOf(inner.at(-1)!);
        expect(moves[i + 1]).toMatchObject({ type: "plunge", z: -0.3 });
        // the tip still turns on the corner
        const trace = cutTrace(moves, k.offset);
        expect(Math.max(...trace.map((p) => distanceTo(p, square)))).toBeLessThan(0.02);
    });

    test("a closed outline: lined up on the surface along its longest side, cut on past the start", () => {
        const moves = knifeRingMoves(triangle, [-0.3], k, h);
        const firstDown = moves.findIndex((m) => m.type === "plunge");
        // down to the surface first (Z 0), dragged along the first side, then into the material
        expect(moves[firstDown].z).toBe(0);
        expect(moves[firstDown + 1]).toMatchObject({ type: "feed", z: 0 });
        expect(moves[firstDown + 2]).toMatchObject({ type: "plunge", z: -0.3 });
        // the start: the middle of the longest side (the base, 30 mm) — y 0, x 15 + offset
        expect(moves[firstDown + 1].x).toBeCloseTo(15.25, 9);
        expect(moves[firstDown + 1].y).toBeCloseTo(0, 9);
        // the overcut: the last cut ends 1 mm past the start along the base
        const lastCut = moves.filter((m) => m.type === "feed" && m.z === -0.3).at(-1)!;
        expect(lastCut.x).toBeCloseTo(16.25, 6);
        expect(moves.at(-1)?.z).toBe(5);
        // no ramps: every way down is straight down
        for (let j = 1; j < moves.length; j++)
            if (moves[j].z < moves[j - 1].z - 1e-9) {
                expect(moves[j].x).toBeCloseTo(moves[j - 1].x, 9);
                expect(moves[j].y).toBeCloseTo(moves[j - 1].y, 9);
            }
    });

    test("several passes: each one round, deeper; the overcut only after the last", () => {
        const moves = knifeRingMoves(square, [-0.5, -1], k, h);
        const zs = [...new Set(moves.filter((m) => m.type === "feed" && m.z < 0).map((m) => m.z))];
        expect(zs).toEqual([-0.5, -1]);
        const plunges = moves.filter((m) => m.type === "plunge").map((m) => m.z);
        expect(plunges).toEqual([0, -0.5, -1]);
    });

    test("operations: a knife cuts profiles and engravings, ramps ignored; outside / inside by the allowance", () => {
        const on = operationMoves(op({ ramp: true }), knife, h);
        const out = operationMoves(op({ side: "outside", allowance: 1 }), knife, h);
        const maxX = (m: MillMove[]) => Math.max(...m.filter((x) => x.z < 0).map((x) => x.x));
        expect(maxX(on)).toBeCloseTo(20.25, 6);
        expect(maxX(out)).toBeGreaterThan(21);
        const line = operationMoves(
            op({
                kind: "engrave",
                rings: [
                    [
                        { x: 0, y: 0 },
                        { x: 10, y: 0 },
                    ],
                ],
            }),
            knife,
            h,
        );
        expect(line.filter((m) => m.z < 0).length).toBeGreaterThan(0);
        for (const kind of ["pocket", "drill", "facing", "helix", "vcarve"] as const)
            expect(operationMoves(op({ kind, points: [{ x: 5, y: 5 }] }), knife, h)).toEqual([]);
    });
});

describe("drag knife: the spindle is never switched on", () => {
    const loud = { ...defaultMillMachine(), air: "m8" as const, coolant: true, spindleDelay: 3 };

    test("a knife's program has no M3 / M4 / S, no spin-up wait, no coolant or air", () => {
        const p = millProgram([op({}), op({ id: "e", kind: "engrave", rings: [triangle] })], tools, loud);
        expect(p.knife).toBe(true);
        const code = p.gcode.split("\n");
        expect(code.filter(startsSpindle)).toEqual([]);
        expect(p.gcode).not.toMatch(/\bM0*[3478](?!\d)/);
        expect(p.gcode).not.toMatch(/\bG4\b/);
        expect(p.gcode).toContain("(drag knife: the spindle stays off)");
        expect(p.gcode).toMatch(/\nZ-0\.3 F300\n/);
        expect(p.skipped).toEqual([]);
    });

    test.each(["grbl", "mach3", "linuxcnc"] as const)("the same with the %s post", (post) => {
        const p = millProgram([op({})], tools, { ...loud, post, toolChange: "m6" });
        expect(p.gcode.split("\n").filter(startsSpindle)).toEqual([]);
    });

    test("a milling job still starts its spindle", () => {
        const p = millProgram([op({ toolId: mill.id, depth: 2 })], tools, loud);
        expect(p.knife).toBe(false);
        expect(p.gcode).toContain("S18000 M3");
        expect(p.gcode).toContain("G4 P3");
        expect(p.gcode).toContain("M8");
    });

    test("refused: a knife pocket or drilling, and a milling cutter in a knife job", () => {
        const p = millProgram(
            [
                op({}),
                op({ id: "p", kind: "pocket" }),
                op({ id: "d", kind: "drill", points: [{ x: 5, y: 5 }] }),
                op({ id: "m", toolId: mill.id, depth: 2 }),
            ],
            tools,
            loud,
        );
        expect(p.skipped.map((s) => [s.op.id, s.reason])).toEqual([
            ["p", "knifeOp"],
            ["d", "knifeOp"],
            ["m", "knifeJob"],
        ]);
        expect(p.gcode.split("\n").filter(startsSpindle)).toEqual([]);
        expect(p.moves.map((m) => m.op.id)).toEqual(["o"]);
    });

    test("a hidden knife operation does not make the job a knife's", () => {
        expect(isKnifeJob([op({ hidden: true }), op({ id: "m", toolId: mill.id })], tools)).toBe(false);
        expect(isKnifeJob([op({}), op({ id: "m", toolId: mill.id })], tools)).toBe(true);
    });

    test("the run path strips any spindle word, run-from-line included", () => {
        const lines = ["G21 G90", "S12000 M3", "G4 P3", "M8", "G1 X1 F500 S9000", "M03", "M4 S100", "M30"];
        const clean = withoutSpindle(lines);
        expect(clean.filter(startsSpindle)).toEqual([]);
        expect(clean).toEqual(["G21 G90", "G4 P3", "G1 X1 F500", "M30"]);
        const resumed = withoutSpindle(runFromLine(lines, 5, 5));
        expect(resumed.filter(startsSpindle)).toEqual([]);
    });

    test("startsSpindle reads words, not letters in comments or other codes", () => {
        expect(startsSpindle("M3 S1000")).toBe(true);
        expect(startsSpindle("m03")).toBe(true);
        expect(startsSpindle("S500")).toBe(true);
        expect(startsSpindle("M30")).toBe(false);
        expect(startsSpindle("M5")).toBe(false);
        expect(startsSpindle("(Speed S1000 M3)")).toBe(false);
        expect(startsSpindle("G1 X3 Y4 F300")).toBe(false);
    });
});

describe("drag knife tools", () => {
    test("the library has a knife, and its settings survive a round trip", () => {
        expect(knife.knife).toEqual(defaultKnife());
        const raw = JSON.parse(
            JSON.stringify({ ...knife, knife: { ...defaultKnife(), offset: 0.5, corners: "lift" } }),
        );
        expect(parseTool(raw)?.knife).toMatchObject({ offset: 0.5, corners: "lift", cornerAngle: 30 });
    });

    test("an older file's knife without settings gets the defaults; a cutter has none", () => {
        const { knife: _drop, ...bare } = knife;
        expect(parseTool(bare)?.knife).toEqual(defaultKnife());
        expect(parseTool(mill)?.knife).toBeUndefined();
        expect(
            parseTool({ ...bare, knife: { offset: -1, corners: "spin", cornerAngle: 400 } })?.knife,
        ).toMatchObject({
            offset: 0,
            corners: "loop",
            cornerAngle: 179,
        });
    });

    test("a tool of an unknown kind (a newer file) loads as a flat end mill", () => {
        const t: CamTool | undefined = parseTool({ ...mill, kind: "laser" });
        expect(t?.kind).toBe("flat");
    });
});
