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
});
