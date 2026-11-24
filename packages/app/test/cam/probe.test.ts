// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import {
    correctedSteps,
    defaultProbeSettings,
    lengthOffset,
    measureTool,
    type ProbeIO,
    parsePrb,
    probeBlock,
    probeBoss,
    probeCorner,
    probeEdge,
    probeHole,
    splitAtToolChanges,
    type Vec3,
} from "../../src/cam/camProbe";

/** Where the ball centre stops moving from `from` along `axis` by `dist`, or undefined. */
type World = (from: Vec3, axis: number, dist: number) => number | undefined;

/** A fake machine: G0 / G53 / G90 / G91 / G38.2 over a world; work offsets are zero. */
function machine(world: World, start: Vec3) {
    const pos: Vec3 = [...start];
    let relative = false;
    const zeros: string[] = [];
    const axes = { X: 0, Y: 1, Z: 2 } as const;
    const words = (line: string) =>
        [...line.matchAll(/([XYZ])(-?[\d.]+)/g)].map((m) => [axes[m[1] as "X"], Number(m[2])] as const);
    const io: ProbeIO = {
        async send(lines) {
            for (const line of lines) {
                if (/G91/.test(line)) relative = true;
                if (/G90/.test(line)) relative = false;
                if (/G10/.test(line)) {
                    zeros.push(line);
                    continue;
                }
                if (/G0\b/.test(line)) {
                    const abs = /G53/.test(line) || !relative;
                    for (const [i, v] of words(line)) pos[i] = abs ? v : pos[i] + v;
                }
            }
        },
        async probe(line) {
            if (/G91/.test(line)) relative = true;
            const [[i, v]] = words(line);
            const dist = relative ? v : v - pos[i];
            const hit = world(pos, i, dist);
            if (hit === undefined) throw new Error("no touch");
            pos[i] = hit;
            return [...pos] as Vec3;
        },
    };
    return { io, pos, zeros };
}

/** A box part, the ball of radius r. */
function box(min: Vec3, max: Vec3, r: number): World {
    return (from, axis, dist) => {
        // the ball's centre in X / Y, its bottom in Z
        const lo = min.map((v, k) => (k === 2 ? v : v - r));
        const hi = max.map((v, k) => (k === 2 ? v : v + r));
        for (let k = 0; k < 3; k++) if (k !== axis && (from[k] < lo[k] || from[k] > hi[k])) return undefined;
        const face = dist > 0 ? lo[axis] : hi[axis];
        const inside = from[axis] > lo[axis] && from[axis] < hi[axis];
        if (inside) return undefined;
        const travel = face - from[axis];
        return Math.sign(travel) === Math.sign(dist) && Math.abs(travel) <= Math.abs(dist) ? face : undefined;
    };
}

function near(a: number, b: number) {
    expect(Math.abs(a - b)).toBeLessThan(1e-6);
}

describe("probing", () => {
    const s = { ...defaultProbeSettings(), tip: 2, setter: { enabled: true, x: 10, y: 10, z: -5 } };

    test("PRB reports", () => {
        expect(parsePrb("[PRB:1.000,-2.500,-30.125:1]")).toEqual({ pos: [1, -2.5, -30.125], ok: true });
        expect(parsePrb("[PRB:0,0,0:0]")?.ok).toBe(false);
        expect(parsePrb("ok")).toBeUndefined();
    });

    test("tool length on the setter, the offset against the reference", async () => {
        // setter top at Z -40; a tool touches when its tip (pos Z) reaches it
        const world: World = (from, axis, dist) =>
            axis === 2 && dist < 0 && from[2] + dist <= -40 ? -40 : undefined;
        const m = machine(world, [0, 0, 0]);
        near(await measureTool(m.io, s), -40);
        near(lengthOffset(-37.5, -40), 2.5);
    });

    test("an edge allows for the ball", async () => {
        // part's left face at X 50; probe left of it, moving +X
        const m = machine(box([50, -100, -100], [150, 100, 0], 1), [40, 0, -2]);
        near(await probeEdge(m.io, s, "X", 1), 50);
        expect(m.zeros.at(-1)).toBe("G10 L2 P0 X50");
    });

    test("a corner from above finds both faces", async () => {
        // stock 20..120 × 30..90, top at Z 0; probe over it near the front-left corner
        const m = machine(box([20, 30, -20], [120, 90, 0], 1), [25, 35, 2]);
        const c = await probeCorner(m.io, s, "frontLeft", true, 0);
        near(c.x, 20);
        near(c.y, 30);
        near(c.z ?? NaN, 0);
    });

    test("hole and boss centres", async () => {
        const R = 10;
        const hole: World = (from, axis, dist) => {
            if (axis === 2) return undefined;
            const o = axis === 0 ? from[1] - 5 : from[0] - 7;
            const half = Math.sqrt((R - 1) ** 2 - o ** 2);
            const c = axis === 0 ? 7 : 5;
            return c + Math.sign(dist) * half;
        };
        const m = machine(hole, [8, 4, -3]);
        const h = await probeHole(m.io, s, true);
        near(h.x, 7);
        near(h.y, 5);
        near(h.d, 20);

        const b = machine(box([-15, -10, -10], [15, 10, 0], 1), [0, 0, 1]);
        const boss = await probeBoss(b.io, s, 30, true);
        near(boss.x, 0);
        near(boss.y, 0);
        near(boss.d, 30);
    });

    test("a program cut at its tool changes", () => {
        const g = [
            "G21 G90",
            "(op1)",
            "S1000 M3",
            "G1 X1",
            "M5",
            "G0 Z5",
            "(change to T2 Mill, set Z0)",
            "M0",
            "S2000 M3",
            "G1 X2",
            "M30",
        ];
        const seg = splitAtToolChanges(g);
        expect(seg.length).toBe(2);
        expect(seg[0].lines).toEqual(["G21 G90", "S1000 M3", "G1 X1", "M5", "G0 Z5"]);
        expect(seg[1]).toEqual({ tool: 2, lines: ["S2000 M3", "G1 X2", "M30"] });
        expect(splitAtToolChanges(["G1 X1", "T3 M6", "G1 X2"])[1]).toEqual({ tool: 3, lines: ["G1 X2"] });
    });

    test("XYZ block on a corner, steps per mm", async () => {
        // stock corner at (20, 30), top 0; block walls 10 mm outside, top 15 mm above; cutter Ø6
        const block = box([10, 20, -20], [60, 70, 15], 3);
        const m = machine(block, [15, 25, 20]);
        const r = await probeBlock(m.io, s, "frontLeft", {
            thickness: 15,
            wallX: 10,
            wallY: 10,
            diameter: 6,
        });
        near(r.x, 20);
        near(r.y, 30);
        near(r.z, 0);
        expect(correctedSteps(800, 100, 99.5)).toBe(804.02);
    });
});
