// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeUtils, Plane } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { afterAll, beforeAll, describe, expect, test } from "@rstest/core";
import { actionsFor } from "../../src/commands/scanFitRegionCommand";
import { frameOf, offsetPlane } from "../../src/commands/scanSectionCommand";
import { AxisNode } from "../../src/datum/axisNode";
import { DatumPointNode } from "../../src/datum/datumPointNode";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { PlaneNode } from "../../src/plane/planeNode";
import { fitRegionAt, rayHit } from "../../src/scanTools/fitRegion";
import { scanTolerance } from "../../src/scanTools/noise";
import { sectionProfiles } from "../../src/scanTools/sectionSketch";
import { SketchNode } from "../../src/sketch";
import { sketchDataOf } from "../../src/stlRebuild/build";
import { weldTriangles } from "../../src/stlRebuild/mesh";
import { solidVolume } from "../../src/stlRebuild/verify";
import { plateWithHole, revolved, withNoise } from "./meshes";
import "../sketch/setup";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
);
let previousFactory: PropertyDescriptor | undefined;

beforeAll(async () => {
    previousFactory = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

afterAll(() => {
    if (previousFactory !== undefined) Object.defineProperty(globalThis, "shapeFactory", previousFactory);
    else delete (globalThis as { shapeFactory?: unknown }).shapeFactory;
});

function scene() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as never;
    return doc;
}

/** The section's sketch extruded `depth` from the plane, as a body. */
function extrudeSection(
    doc: TestDocument,
    plane: Plane,
    profiles: Parameters<typeof sketchDataOf>[1],
    depth: number,
) {
    const sketch = new SketchNode({ document: doc, plane, data: sketchDataOf(plane, profiles, 1e-3) });
    doc.modelManager.addNode(sketch);
    const body = new ParametricBodyNode({
        document: doc,
        features: [{ id: "e", type: "extrude", sketchId: sketch.id, depth }],
    });
    doc.modelManager.addNode(body);
    return body;
}

describe("mesh section → sketch, extruded", () => {
    test("the plate's mid-height section extruded 10 mm from its bottom rebuilds the plate", () => {
        const doc = scene();
        const mesh = weldTriangles(plateWithHole(40, 10, 6, 64, 4, 4));
        const plane = offsetPlane(Plane.XY, 5);
        const result = sectionProfiles(mesh, frameOf(plane));
        expect(result.profiles.length).toBe(2);
        const body = extrudeSection(doc, Plane.XY, result.profiles, 10);
        expect(body.shape.isOk).toBe(true);
        // the hole fitted as a true circle of r 6: a hair more than the 64-gon took out
        expect(solidVolume(body.shape.value)).toBeCloseTo((1600 - Math.PI * 36) * 10, 0);
    });

    test("a noisy scan's section still extrudes to the plate within 1%", () => {
        const doc = scene();
        const mesh = withNoise(weldTriangles(plateWithHole(40, 10, 6, 128, 12, 12)), 0.03, 9);
        const result = sectionProfiles(mesh, frameOf(offsetPlane(Plane.XY, 5)));
        const body = extrudeSection(doc, Plane.XY, result.profiles, 10);
        expect(body.shape.isOk).toBe(true);
        const v = solidVolume(body.shape.value);
        const truth = (1600 - Math.PI * 36) * 10;
        expect(Math.abs(v - truth) / truth).toBeLessThan(0.01);
    });
});

describe("fit region actions", () => {
    const plate = weldTriangles(plateWithHole(40, 10, 6, 64, 4, 4));

    test("a plane: a sketch on it, a datum plane and a point, all at z = 10", () => {
        const doc = scene();
        const seed = rayHit(plate, [15, 12, 30], [0, 0, -1])!.triangle;
        const fit = fitRegionAt(plate, seed, scanTolerance(plate))!;
        const actions = actionsFor(fit);
        expect(actions.map((a) => a.content)).toEqual([
            "scan.fit.action.sketch",
            "scan.fit.action.plane",
            "scan.fit.action.point",
        ]);
        for (const a of actions) a.run(doc);
        const nodes = [...NodeUtils.children(doc.modelManager.rootNode)];
        const sketch = nodes.find((n) => n instanceof SketchNode) as SketchNode;
        expect(sketch.plane.origin.z).toBeCloseTo(10, 6);
        expect(sketch.plane.normal.z).toBeCloseTo(1, 6);
        const plane = nodes.find((n) => n instanceof PlaneNode) as PlaneNode;
        expect(plane.worldPlane()!.origin.z).toBeCloseTo(10, 6);
        const point = nodes.find((n) => n instanceof DatumPointNode) as DatumPointNode;
        expect(point.worldPoint()?.z).toBeCloseTo(10, 6);
    });

    test("a hole: an axis along z and a sketch of its Ø", () => {
        const doc = scene();
        const seed = rayHit(plate, [0, 0, 5], [1, 0, 0])!.triangle;
        const fit = fitRegionAt(plate, seed, scanTolerance(plate))!;
        const actions = actionsFor(fit);
        expect(actions.map((a) => a.content)).toEqual([
            "scan.fit.action.axis",
            "scan.fit.action.point",
            "scan.fit.action.holeSketch",
        ]);
        for (const a of actions) a.run(doc);
        const nodes = [...NodeUtils.children(doc.modelManager.rootNode)];
        const axis = (nodes.find((n) => n instanceof AxisNode) as AxisNode).worldAxis()!;
        expect(Math.abs(axis.direction.z)).toBeCloseTo(1, 4);
        expect(Math.hypot(axis.point.x, axis.point.y)).toBeLessThan(1e-3);
        const sketch = nodes.find((n) => n instanceof SketchNode) as SketchNode;
        expect(sketch.data.entities.length).toBe(1);
    });

    test("a boss: a body of the cylinder's Ø and length", () => {
        const doc = scene();
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
        const seed = rayHit(mesh, [20, 0.3, 7], [-1, 0, 0])!.triangle;
        const fit = fitRegionAt(mesh, seed, scanTolerance(mesh))!;
        const boss = actionsFor(fit).find((a) => a.content === "scan.fit.action.boss")!;
        boss.run(doc);
        const body = [...NodeUtils.children(doc.modelManager.rootNode)].find(
            (n) => n instanceof ParametricBodyNode,
        ) as ParametricBodyNode;
        expect(body.shape.isOk).toBe(true);
        expect(solidVolume(body.shape.value)).toBeCloseTo(Math.PI * 25 * 20, -1);
    });
});
