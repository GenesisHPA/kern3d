// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { fitRegionAt, rayHit } from "../../src/scanTools/fitRegion";
import { estimateNoise, scanTolerance } from "../../src/scanTools/noise";
import {
    boundaryLoops,
    decimate,
    fillHoles,
    prepareScan,
    smoothMesh,
    weldSoup,
} from "../../src/scanTools/scanPrep";
import { sectionProfiles } from "../../src/scanTools/sectionSketch";
import { meshVolume, weldTriangles } from "../../src/stlRebuild/mesh";
import { plateWithHole, soupOf, withHole, withNoise } from "./meshes";

const TRUE_VOLUME = (1600 - Math.PI * 36) * 10;
const dense = () => weldTriangles(plateWithHole(40, 10, 6, 256, 24, 24));

describe("weldSoup", () => {
    test("welds an STL soup like weldTriangles does", () => {
        const soup = plateWithHole(40, 10, 6, 32, 2, 2);
        const a = weldSoup(soup);
        const b = weldTriangles(soup);
        expect(a.positions.length).toBe(b.positions.length);
        expect(a.triangles.length).toBe(b.triangles.length);
        expect(meshVolume(a)).toBeCloseTo(meshVolume(b), 6);
        expect(boundaryLoops(a)).toEqual([]);
    });
});

describe("decimate", () => {
    test("to a target within 10%, the volume kept within 1%, still closed", () => {
        const mesh = dense();
        expect(mesh.areas.length).toBeGreaterThan(40000);
        const out = decimate(mesh, 5000);
        expect(Math.abs(out.areas.length - 5000)).toBeLessThan(500);
        expect(Math.abs(meshVolume(out) - meshVolume(mesh)) / meshVolume(mesh)).toBeLessThan(0.01);
        expect(boundaryLoops(out).length).toBe(0);
    });

    test("leaves a mesh already under the target alone", () => {
        const mesh = weldTriangles(plateWithHole(40, 10, 6, 32, 2, 2));
        expect(decimate(mesh, 1_000_000)).toBe(mesh);
    });
});

describe("smoothMesh", () => {
    test("takes a scan's noise down without shrinking it", () => {
        const noisy = withNoise(dense(), 0.04, 2);
        const before = estimateNoise(noisy);
        const smooth = smoothMesh(noisy, 3);
        expect(estimateNoise(smooth)).toBeLessThan(before * 0.6);
        expect(Math.abs(meshVolume(smooth) - TRUE_VOLUME) / TRUE_VOLUME).toBeLessThan(0.01);
    });
});

describe("fillHoles", () => {
    test("closes a punched hole facing the right way; a hole too big is left", () => {
        const holed = withHole(weldTriangles(plateWithHole(40, 10, 6, 128, 12, 12)), [12, 12, 10], 2.5);
        expect(boundaryLoops(holed).length).toBe(1);
        const edges = boundaryLoops(holed)[0].length;
        const kept = fillHoles(holed, edges - 1);
        expect(kept.filled).toBe(0);
        expect(kept.left).toBe(1);
        const mended = fillHoles(holed, edges);
        expect(mended.filled).toBe(1);
        expect(boundaryLoops(mended.mesh)).toEqual([]);
        // the patch lies on the top: the volume is the plate's again
        expect(meshVolume(mended.mesh)).toBeCloseTo(
            meshVolume(weldTriangles(plateWithHole(40, 10, 6, 128, 12, 12))),
            1,
        );
    });
});

describe("prepareScan: a synthetic scan (noise σ 0.04 mm, two holes, 110k triangles)", () => {
    const clean = dense();
    const scan = withHole(withHole(withNoise(clean, 0.04, 4), [12, 12, 10], 2), [-15, -10, 0], 1.5);

    test("comes out closed, at the target count, with less noise", () => {
        const { mesh, report } = prepareScan(scan, {
            targetTriangles: 20000,
            smoothing: 2,
            maxHoleEdges: 200,
        });
        expect(report.holesFilled).toBe(2);
        expect(report.holesLeft).toBe(0);
        expect(Math.abs(report.trianglesAfter - 20000)).toBeLessThan(2000);
        expect(report.noiseAfter).toBeLessThan(report.noiseBefore);
        expect(boundaryLoops(mesh)).toEqual([]);
        expect(Math.abs(meshVolume(mesh) - TRUE_VOLUME) / TRUE_VOLUME).toBeLessThan(0.01);
    });

    test("the cleaned scan sections and fits as the part: a circle of r 6 and a plane at z 10", () => {
        const { mesh } = prepareScan(scan, { targetTriangles: 20000, smoothing: 2, maxHoleEdges: 200 });
        const section = sectionProfiles(mesh, { origin: [0, 0, 5], normal: [0, 0, 1], xvec: [1, 0, 0] });
        expect(section.profiles.length).toBe(2);
        const circle = section.profiles.find((p) => p.kind === "circle");
        expect(circle?.kind === "circle" && circle.r).toBeCloseTo(6, 1);
        const top = fitRegionAt(
            mesh,
            rayHit(mesh, [15, -12, 30], [0, 0, -1])!.triangle,
            scanTolerance(mesh),
        )!;
        expect(top.primitive.kind).toBe("plane");
        expect(top.primitive.kind === "plane" && Math.abs(top.primitive.d)).toBeCloseTo(10, 1);
    });

    test("an STL soup of the scan welds back to the same mesh", () => {
        expect(weldSoup(soupOf(scan)).positions.length).toBe(scan.positions.length);
    });
});
