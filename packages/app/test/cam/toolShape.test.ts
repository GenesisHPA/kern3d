import { describe, expect, test } from "@rstest/core";
import { toolIconSvg, toolProfile, toolSvg } from "../../src/cam/camToolShape";
import { type CamTool, defaultTools } from "../../src/cam/camTools";

const base = defaultTools()[0];
const tool = (more: Partial<CamTool>): CamTool => ({ ...base, ...more });

describe("tool profile", () => {
    test("flat: square tip, flutes to the flute length, 1/8 shank", () => {
        const p = toolProfile(tool({ kind: "flat", diameter: 3, fluteLength: 12 }));
        expect(p.points[0]).toEqual({ r: 0, z: 0 });
        expect(p.points[1]).toEqual({ r: 1.5, z: 0 });
        expect(p.fluteEnd).toBe(12);
        expect(p.tipLength).toBe(0);
        expect(p.shankRadius).toBeCloseTo(3.175 / 2);
        expect(p.points.at(-1)).toEqual({ r: 0, z: p.length });
    });

    test("ball: a quarter circle of radius d/2", () => {
        const p = toolProfile(tool({ kind: "ball", diameter: 4, fluteLength: 10 }), 8);
        expect(p.tipLength).toBe(2);
        for (const q of p.points.slice(1, 9)) expect(Math.hypot(q.r, q.z - 2)).toBeCloseTo(2);
    });

    test("bull: corner radius respected", () => {
        const p = toolProfile(tool({ kind: "bull", diameter: 6, cornerRadius: 1, fluteLength: 10 }), 4);
        expect(p.points[1]).toEqual({ r: 2, z: 0 });
        expect(p.tipLength).toBe(1);
        expect(p.points[5].r).toBeCloseTo(3);
        expect(p.points[5].z).toBeCloseTo(1);
    });

    test("V-bit: cone height from the angle", () => {
        const p = toolProfile(tool({ kind: "vbit", diameter: 6, angle: 90, fluteLength: 2 }));
        expect(p.tipLength).toBeCloseTo(3);
        expect(p.fluteEnd).toBeCloseTo(3);
        expect(p.points[1].r).toBe(3);
    });

    test("radii never go negative and z rises", () => {
        for (const kind of ["flat", "ball", "bull", "vbit", "drill", "chamfer"] as const) {
            const p = toolProfile(tool({ kind, diameter: 5, cornerRadius: 1, angle: 60, fluteLength: 8 }));
            for (let i = 1; i < p.points.length; i++) {
                expect(p.points[i].r).toBeGreaterThanOrEqual(0);
                expect(p.points[i].z).toBeGreaterThanOrEqual(p.points[i - 1].z - 1e-9);
            }
        }
    });
});

describe("tool svg", () => {
    test("carries the dimensions", () => {
        const s = toolSvg(tool({ kind: "vbit", diameter: 6, angle: 60, fluteLength: 6 }));
        expect(s.startsWith("<svg")).toBe(true);
        expect(s).toContain("Ø6");
        expect(s).toContain("60°");
        expect(toolIconSvg(tool({ kind: "ball" }))).not.toContain("<marker");
    });
});
