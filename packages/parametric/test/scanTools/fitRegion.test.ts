// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { fitRegionAt, ransacPlane, rayHit, triangleNeighbours } from "../../src/scanTools/fitRegion";
import { scanTolerance } from "../../src/scanTools/noise";
import { meshVolume, type TriMesh, type Vec3, weldTriangles } from "../../src/stlRebuild/mesh";
import { gaussian, plateWithHole, revolved, seeded, sphere, withNoise } from "./meshes";

function seedAt(mesh: TriMesh, from: Vec3, direction: Vec3): number {
    const hit = rayHit(mesh, from, direction);
    expect(hit).toBeDefined();
    return hit!.triangle;
}

describe("rayHit", () => {
    test("the first triangle along the ray, or nothing", () => {
        const mesh = weldTriangles(plateWithHole(40, 10, 6, 32, 2, 2));
        const hit = rayHit(mesh, [15, 15, 50], [0, 0, -1])!;
        expect(hit.t).toBeCloseTo(40, 9);
        expect(rayHit(mesh, [0, 0, 50], [0, 0, -1])).toBeUndefined();
    });
});

describe("ransacPlane", () => {
    test("finds the plane most points lie on despite a third of outliers", () => {
        const random = seeded(3);
        const points: Vec3[] = [];
        for (let i = 0; i < 200; i++)
            points.push([random() * 10, random() * 10, 2 + gaussian(random) * 0.01]);
        for (let i = 0; i < 100; i++) points.push([random() * 10, random() * 10, random() * 10]);
        const plane = ransacPlane(points, 0.05)!;
        expect(plane.kind).toBe("plane");
        if (plane.kind !== "plane") return;
        expect(Math.abs(plane.normal[2])).toBeCloseTo(1, 3);
        expect(Math.abs(plane.d)).toBeCloseTo(2, 2);
    });
});

describe("fitRegionAt on a CAD mesh", () => {
    const mesh = weldTriangles(plateWithHole(40, 10, 6, 64, 4, 4));
    const adjacency = triangleNeighbours(mesh);
    const tol = scanTolerance(mesh);

    test("the top: a plane z = 10 over the whole top (minus the hole)", () => {
        const fit = fitRegionAt(mesh, seedAt(mesh, [15, 12, 30], [0, 0, -1]), tol, adjacency)!;
        expect(fit.primitive.kind).toBe("plane");
        if (fit.primitive.kind !== "plane") return;
        expect(Math.abs(fit.primitive.normal[2])).toBeCloseTo(1, 6);
        expect(fit.primitive.d * Math.sign(fit.primitive.normal[2])).toBeCloseTo(10, 6);
        expect(fit.outward[2]).toBeCloseTo(1, 6);
        expect(fit.area).toBeCloseTo(1600 - 0.5 * 64 * 36 * Math.sin((2 * Math.PI) / 64), 3);
    });

    test("the hole: a cylinder Ø 12 along z, 10 long, concave", () => {
        const fit = fitRegionAt(mesh, seedAt(mesh, [0, 0, 5], [1, 0, 0]), tol, adjacency)!;
        expect(fit.primitive.kind).toBe("cylinder");
        if (fit.primitive.kind !== "cylinder") return;
        expect(Math.abs(fit.primitive.axis[2])).toBeCloseTo(1, 4);
        expect(fit.primitive.radius).toBeCloseTo(6, 3);
        expect(fit.span!.max - fit.span!.min).toBeCloseTo(10, 3);
        expect(fit.concave).toBe(true);
    });
});

describe("fitRegionAt on shapes of revolution", () => {
    test("a sphere of r 8", () => {
        const mesh = weldTriangles(sphere(8, 48, 24));
        expect(meshVolume(mesh)).toBeGreaterThan(0);
        const fit = fitRegionAt(mesh, seedAt(mesh, [30, 1, 2], [-1, 0, 0]), scanTolerance(mesh))!;
        expect(fit.primitive.kind).toBe("sphere");
        if (fit.primitive.kind !== "sphere") return;
        expect(fit.primitive.radius).toBeCloseTo(8, 3);
    });

    test("a cone of 30° half-angle: its side, not the base", () => {
        const h = 10;
        const r = h * Math.tan(Math.PI / 6);
        const mesh = weldTriangles(
            revolved(
                [
                    [0, 0],
                    [r, 0],
                    [0, h],
                ],
                64,
                6,
            ),
        );
        const fit = fitRegionAt(mesh, seedAt(mesh, [20, 0.5, 3], [-1, 0, 0]), scanTolerance(mesh))!;
        expect(fit.primitive.kind).toBe("cone");
        if (fit.primitive.kind !== "cone") return;
        expect((fit.primitive.angle * 180) / Math.PI).toBeCloseTo(30, 1);
        expect(fit.concave).toBe(false);
    });

    test("a boss: convex cylinder Ø 10", () => {
        const mesh = weldTriangles(
            revolved(
                [
                    [0, 0],
                    [5, 0],
                    [5, 20],
                    [0, 20],
                ],
                64,
                8,
            ),
        );
        const fit = fitRegionAt(mesh, seedAt(mesh, [20, 0.3, 7], [-1, 0, 0]), scanTolerance(mesh))!;
        expect(fit.primitive.kind).toBe("cylinder");
        if (fit.primitive.kind !== "cylinder") return;
        expect(fit.primitive.radius).toBeCloseTo(5, 3);
        expect(fit.concave).toBe(false);
        expect(fit.span!.max - fit.span!.min).toBeCloseTo(20, 2);
    });
});

describe("fitRegionAt on a noisy scan (σ 0.03 mm)", () => {
    const mesh = withNoise(weldTriangles(plateWithHole(40, 10, 6, 128, 12, 12)), 0.03, 5);
    const tol = scanTolerance(mesh);

    test("the tolerance comes from the noise", () => {
        expect(tol).toBeGreaterThan(0.05);
        expect(tol).toBeLessThan(0.2);
    });

    test("the top is still a plane at z ≈ 10 covering most of the top", () => {
        const fit = fitRegionAt(mesh, seedAt(mesh, [15, 12, 30], [0, 0, -1]), tol)!;
        expect(fit.primitive.kind).toBe("plane");
        if (fit.primitive.kind !== "plane") return;
        expect(Math.abs(fit.primitive.normal[2])).toBeCloseTo(1, 3);
        expect(Math.abs(fit.primitive.d)).toBeCloseTo(10, 1);
        expect(fit.area).toBeGreaterThan(1400 * 0.8);
        expect(fit.rms).toBeLessThan(0.05);
    });

    test("the hole is still a cylinder of r ≈ 6", () => {
        const fit = fitRegionAt(mesh, seedAt(mesh, [0, 0, 5], [1, 0, 0]), tol)!;
        expect(fit.primitive.kind).toBe("cylinder");
        if (fit.primitive.kind !== "cylinder") return;
        expect(fit.primitive.radius).toBeCloseTo(6, 1);
        expect(Math.abs(fit.primitive.axis[2])).toBeCloseTo(1, 2);
    });
});
