import { describe, expect, test } from "@rstest/core";
import { defaultTools } from "../../src/cam/camTools";
import { MillSimulation } from "../../src/cam/simulate";
import { operationMoves } from "../../src/cam/toolpath";

describe("mill simulation", () => {
    const tool = { ...defaultTools()[0], diameter: 2, stepDown: 1, stepOver: 0.8 };
    const square = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
    ];
    const base = {
        id: "p",
        name: "",
        toolId: tool.id,
        side: "outside" as const,
        climb: true,
        ramp: false,
        allowance: 0,
        tabs: { count: 0, width: 3, height: 1 },
        peck: 0,
        rings: [square],
        points: [],
    };
    const stock = { minX: -5, minY: -5, width: 20, height: 20, top: 0, bottom: -5 };

    test("a pocket removes about its area times depth", () => {
        const moves = operationMoves({ ...base, kind: "pocket", depth: 1 }, tool, { safeZ: 5, clearance: 1 });
        const sim = new MillSimulation(
            stock,
            moves.map((move) => ({ move, tool })),
            0.1,
        );
        sim.finish();
        expect(sim.removedVolume()).toBeGreaterThan(90);
        expect(sim.removedVolume()).toBeLessThan(105);
        expect(sim.heightAt(5, 5)).toBeCloseTo(-1, 3);
        expect(sim.heightAt(-3, -3)).toBe(0);
    });

    test("advance animates: partial, then the tip at the end", () => {
        const moves = operationMoves({ ...base, kind: "profile", depth: 2 }, tool, {
            safeZ: 5,
            clearance: 1,
        });
        const sim = new MillSimulation(
            stock,
            moves.map((move) => ({ move, tool })),
            0.2,
        );
        sim.advance(20);
        expect(sim.done).toBe(false);
        expect(sim.takeDirty()).toBeDefined();
        sim.finish();
        expect(sim.done).toBe(true);
        expect(sim.tip.z).toBe(5);
        expect(sim.heightAt(-1, 5)).toBeCloseTo(-2, 3);
        expect(sim.heightAt(5, 5)).toBe(0);
    });

    test("seek forward and back matches playing through", () => {
        const moves = operationMoves({ ...base, kind: "pocket", depth: 1 }, tool, { safeZ: 5, clearance: 1 });
        const list = moves.map((move) => ({ move, tool }));
        const sim = new MillSimulation(stock, list, 0.2);
        sim.finish();
        const full = sim.removedVolume();
        sim.seek(list.length);
        expect(sim.removedVolume()).toBeCloseTo(full, 3);
        const half = Math.floor(list.length / 2);
        sim.seek(half);
        expect(sim.progress).toBe(half);
        const v = sim.removedVolume();
        expect(v).toBeLessThan(full);
        sim.seek(0);
        expect(sim.removedVolume()).toBe(0);
        sim.seek(half);
        expect(sim.removedVolume()).toBeCloseTo(v, 3);
        sim.reset();
        expect(sim.progress).toBe(0);
    });
});

describe("drag knife simulation", () => {
    const knife = defaultTools().find((x) => x.kind === "knife")!;
    const square = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
    ];
    const op = {
        id: "k",
        name: "",
        kind: "profile" as const,
        toolId: knife.id,
        depth: 0.3,
        side: "on" as const,
        climb: true,
        ramp: false,
        allowance: 0,
        tabs: { count: 0, width: 3, height: 1 },
        peck: 0,
        rings: [square],
        points: [],
    };
    const stock = { minX: -5, minY: -5, width: 20, height: 20, top: 0, bottom: -5 };

    test("the blade's tip cuts a thin line on the outline, not the axis's path", () => {
        const moves = operationMoves(op, knife, { safeZ: 5, clearance: 1 });
        const sim = new MillSimulation(
            stock,
            moves.map((move) => ({ move, tool: knife })),
            0.1,
        );
        sim.finish();
        // on the outline: cut to the depth, the corners too
        for (const [x, y] of [
            [5, 0],
            [10, 5],
            [5, 10],
            [0, 5],
            [10, 0],
            [0, 10],
        ])
            expect(sim.heightAt(x, y)).toBeCloseTo(-0.3, 5);
        // a cell to either side untouched: a slit, not a groove
        expect(sim.heightAt(5, 0.3)).toBe(0);
        expect(sim.heightAt(5, -0.3)).toBe(0);
        // the loops the axis makes round the corners leave no mark beyond them
        expect(sim.heightAt(10.25, -0.2)).toBe(0);
        expect(sim.removedVolume()).toBeLessThan(40 * 0.1 * 0.3 * 1.5);
        // the blade ends where it trails the holder: never further than the offset
        const b = sim.blade!;
        expect(Math.hypot(b.x - sim.tip.x, b.y - sim.tip.y)).toBeLessThanOrEqual(0.25 + 1e-9);
    });
});
