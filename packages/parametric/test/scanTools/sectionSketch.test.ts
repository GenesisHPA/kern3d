// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { estimateNoise, scanTolerance } from "../../src/scanTools/noise";
import { fitNoisyProfile } from "../../src/scanTools/robustFit2d";
import { meshSectionLoops, sectionProfiles } from "../../src/scanTools/sectionSketch";
import { type Profile2D, profileArea } from "../../src/stlRebuild/fit2d";
import { meshVolume, weldTriangles } from "../../src/stlRebuild/mesh";
import type { Loop2D } from "../../src/stlRebuild/slices";
import { gaussian, plateWithHole, seeded, withHole, withNoise } from "./meshes";

const plate = () => weldTriangles(plateWithHole(40, 10, 6, 64, 4, 4));
const denseNoisy = (sigma: number) =>
    withNoise(weldTriangles(plateWithHole(40, 10, 6, 128, 12, 12)), sigma, 7);

const XY = {
    origin: [0, 0, 5] as [number, number, number],
    normal: [0, 0, 1] as [number, number, number],
    xvec: [1, 0, 0] as [number, number, number],
};

function kinds(p: Profile2D): string {
    return p.kind === "circle" ? "circle" : p.curves.map((c) => c.kind).join(",");
}

describe("synthetic plate", () => {
    test("is closed with outward normals: volume = plate − hole", () => {
        const v = meshVolume(plate());
        // the hole is a 64-gon, a hair under the circle's area
        const polygon = 0.5 * 64 * 36 * Math.sin((2 * Math.PI) / 64);
        expect(v).toBeCloseTo((1600 - polygon) * 10, 6);
    });
});

describe("meshSectionLoops", () => {
    test("a mid-height cut gives the square and the hole, in the plane's own coordinates", () => {
        const loops = meshSectionLoops(plate(), { ...XY, origin: [5, -3, 5] });
        expect(loops.length).toBe(2);
        const xs = loops.flatMap((l) => l.map((p) => p[0]));
        // the plate spans x ∈ [-20, 20]; measured from the origin at x = 5
        expect(Math.min(...xs)).toBeCloseTo(-25, 6);
        expect(Math.max(...xs)).toBeCloseTo(15, 6);
    });

    test("a plane off the part cuts nothing", () => {
        expect(meshSectionLoops(plate(), { ...XY, origin: [0, 0, 20] })).toEqual([]);
    });

    test("a vertical plane through the hole gives two rectangles", () => {
        const loops = meshSectionLoops(plate(), { origin: [0, 0, 0], normal: [0, 1, 0], xvec: [1, 0, 0] });
        expect(loops.length).toBe(2);
    });
});

describe("sectionProfiles on a CAD mesh", () => {
    test("the square as four lines and the hole as one circle of r 6", () => {
        const result = sectionProfiles(plate(), XY);
        expect(result.noise).toBe(0);
        expect(result.unfitted).toBe(0);
        const circle = result.profiles.find((p) => p.kind === "circle");
        const square = result.profiles.find((p) => p.kind === "chain");
        expect(circle).toBeDefined();
        expect(square).toBeDefined();
        expect(kinds(square!)).toBe("line,line,line,line");
        // a 64-gon's vertices lie on r = 6 exactly; the fit passes them
        expect(circle!.kind === "circle" && circle!.r).toBeCloseTo(6, 2);
        expect(Math.abs(profileArea(square!))).toBeCloseTo(1600, 3);
    });
});

describe("noise", () => {
    test("a CAD mesh reads no noise; a noisy copy reads about its σ", () => {
        const clean = weldTriangles(plateWithHole(40, 10, 6, 128, 12, 12));
        expect(estimateNoise(clean)).toBeLessThan(1e-3);
        const sigma = 0.05;
        const noisy = withNoise(clean, sigma, 3);
        const est = estimateNoise(noisy);
        expect(est).toBeGreaterThan(sigma * 0.6);
        expect(est).toBeLessThan(sigma * 1.6);
        expect(scanTolerance(noisy)).toBeCloseTo(3 * est, 9);
    });
});

describe("fitNoisyProfile", () => {
    const random = seeded(11);
    const jitter = (loop: Loop2D, s: number): Loop2D =>
        loop.map(([x, y]) => [x + gaussian(random) * s, y + gaussian(random) * s]);

    test("a noisy rectangle is four lines with its corners close to the true ones", () => {
        const loop: Loop2D = [];
        const corners: [number, number][] = [
            [0, 0],
            [30, 0],
            [30, 20],
            [0, 20],
        ];
        for (let c = 0; c < 4; c++) {
            const a = corners[c];
            const b = corners[(c + 1) % 4];
            for (let i = 0; i < 100; i++)
                loop.push([a[0] + ((b[0] - a[0]) * i) / 100, a[1] + ((b[1] - a[1]) * i) / 100]);
        }
        const profile = fitNoisyProfile(jitter(loop, 0.03), 0.12);
        expect(profile?.kind).toBe("chain");
        expect(kinds(profile!)).toBe("line,line,line,line");
        expect(Math.abs(profileArea(profile!))).toBeGreaterThan(600 * 0.99);
        expect(Math.abs(profileArea(profile!))).toBeLessThan(600 * 1.01);
    });

    test("a noisy circle is one circle", () => {
        const loop: Loop2D = Array.from({ length: 300 }, (_, i) => {
            const a = (2 * Math.PI * i) / 300;
            return [10 + 8 * Math.cos(a), -4 + 8 * Math.sin(a)];
        });
        const profile = fitNoisyProfile(jitter(loop, 0.02), 0.08);
        expect(profile?.kind).toBe("circle");
        expect(profile!.kind === "circle" && profile!.r).toBeCloseTo(8, 1);
    });

    test("a noisy slot is two lines and two arcs that share their ends", () => {
        const loop: Loop2D = [];
        for (let i = 0; i < 100; i++) loop.push([(20 * i) / 100, -5]);
        for (let i = 0; i < 60; i++) {
            const a = -Math.PI / 2 + (Math.PI * i) / 60;
            loop.push([20 + 5 * Math.cos(a), 5 * Math.sin(a)]);
        }
        for (let i = 0; i < 100; i++) loop.push([20 - (20 * i) / 100, 5]);
        for (let i = 0; i < 60; i++) {
            const a = Math.PI / 2 + (Math.PI * i) / 60;
            loop.push([5 * Math.cos(a), 5 * Math.sin(a)]);
        }
        const profile = fitNoisyProfile(jitter(loop, 0.02), 0.08);
        expect(profile?.kind).toBe("chain");
        if (profile?.kind !== "chain") return;
        expect(profile.curves.filter((c) => c.kind === "arc").length).toBe(2);
        expect(profile.curves.filter((c) => c.kind === "line").length).toBe(2);
        for (let i = 0; i < profile.curves.length; i++) {
            const end = profile.curves[i].b;
            const next = profile.curves[(i + 1) % profile.curves.length].a;
            expect(Math.hypot(end[0] - next[0], end[1] - next[1])).toBeLessThan(1e-9);
        }
        for (const c of profile.curves) if (c.kind === "arc") expect(c.r).toBeCloseTo(5, 0);
        // area of a 20 × 10 slot with round ends: 200 + π·25
        expect(Math.abs(profileArea(profile))).toBeCloseTo(200 + Math.PI * 25, -1);
    });
});

describe("sectionProfiles on a noisy scan", () => {
    test("σ 0.03 mm: still the square's four lines and the hole's circle", () => {
        const mesh = denseNoisy(0.03);
        const result = sectionProfiles(mesh, XY);
        expect(result.noise).toBeGreaterThan(0.015);
        expect(result.profiles.length).toBe(2);
        const circle = result.profiles.find((p) => p.kind === "circle");
        const square = result.profiles.find((p) => p.kind === "chain");
        expect(circle!.kind === "circle" && circle!.r).toBeCloseTo(6, 0);
        expect(kinds(square!)).toBe("line,line,line,line");
        // the walls are exactly square to the sketch axes, so the sketch marks them H / V
        if (square!.kind !== "chain") return;
        for (const c of square!.curves) {
            expect(Math.min(Math.abs(c.a[0] - c.b[0]), Math.abs(c.a[1] - c.b[1]))).toBeLessThan(1e-9);
        }
    });
});

describe("a section through a scan with holes", () => {
    test("a hole in the outer wall and one in the bore, both cut by the plane: still the square and the circle", () => {
        const holed = withHole(
            withHole(weldTriangles(plateWithHole(40, 10, 6, 128, 12, 12)), [20, 3, 5], 1.2),
            [-6, 0, 5],
            0.8,
        );
        const loops = meshSectionLoops(holed, XY);
        expect(loops.length).toBe(2);
        const result = sectionProfiles(holed, XY);
        const circle = result.profiles.find((p) => p.kind === "circle");
        const square = result.profiles.find((p) => p.kind === "chain");
        expect(circle!.kind === "circle" && circle!.r).toBeCloseTo(6, 1);
        expect(kinds(square!)).toBe("line,line,line,line");
        expect(Math.abs(profileArea(square!))).toBeCloseTo(1600, 0);
    });

    test("a gap wider than 5% of the part is not bridged", () => {
        const holed = withHole(weldTriangles(plateWithHole(40, 10, 6, 128, 12, 12)), [20, 3, 5], 4);
        const loops = meshSectionLoops(holed, XY);
        // the outer square is open by 8 mm (> 5% of 57 mm): only the bore closes
        expect(loops.length).toBe(1);
    });
});
