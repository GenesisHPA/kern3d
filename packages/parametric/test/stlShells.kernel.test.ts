// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { I18n, type IFace, type IShape, Plane, ShapeTypes, XYZ } from "@chili3d/core";
import {
    binaryStl,
    boxTriangles,
    createMockApplication,
    createMockVisualWithDocument,
    sliverTriangles,
    TestDocument,
} from "@chili3d/core/test-utils";
import { initWasm, OccShapeConverter, ShapeFactory, stlToShape } from "@chili3d/wasm";
import { mergePlanarFaces, meshToSolid } from "../src/commands/meshToSolid";
import type { OffsetFaceFeatureData } from "../src/features/feature";
import { CAVITY_WALL_STATUS, offsetFacesKeepingCavities } from "../src/features/offsetCavity";
import { captureProfileRef } from "../src/features/profileRef";
import { ParametricBodyNode } from "../src/parametricBodyNode";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/chili-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    for (const [name, value] of [
        ["shapeFactory", new ShapeFactory()],
        ["shapeConverter", new OccShapeConverter()],
    ] as const) {
        Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
    }
});

const fromStl = (triangles: number[][] | readonly (readonly number[])[]) =>
    meshToSolid(stlToShape(binaryStl(triangles)).value, "never").value;
const count = (shape: IShape, type: (typeof ShapeTypes)[keyof typeof ShapeTypes]) =>
    shape.findSubShapes(type).length;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b));

describe("an STL's closed shells made solids", () => {
    test("a sliver bubble cut off by the sewing is dropped, not kept as a sealed cavity", () => {
        // the 23.stl case in miniature: the part plus a closed 0.05 mm × 1e-4 mm sliver beside it
        const solid = fromStl([...boxTriangles([0, 0, 0], [10, 10, 10]), ...sliverTriangles([12, 0, 0])]);
        expect(solid.shapeType).toBe(ShapeTypes.solid);
        expect(count(solid, ShapeTypes.shell)).toBe(1);
        expect(near(solid.volume(), 1000)).toBe(true);
        expect(solid.checkShape()).toBe(true);
    });

    test("a real void stays a void: one solid, two shells, the void's volume taken out", () => {
        const solid = fromStl([
            ...boxTriangles([0, 0, 0], [10, 10, 10]),
            ...boxTriangles([3, 3, 3], [7, 7, 7], true),
        ]);
        expect(solid.shapeType).toBe(ShapeTypes.solid);
        expect(count(solid, ShapeTypes.shell)).toBe(2);
        expect(near(solid.volume(), 1000 - 64)).toBe(true);
        expect(solid.checkShape()).toBe(true);
    });

    test("two separate parts in one file are two solids, neither a cavity of the other", () => {
        const shape = fromStl([
            ...boxTriangles([0, 0, 0], [10, 10, 10]),
            ...boxTriangles([20, 0, 0], [25, 5, 5]),
        ]);
        const solids = shape.findSubShapes(ShapeTypes.solid);
        expect(solids.map((s) => s.findSubShapes(ShapeTypes.shell).length)).toEqual([1, 1]);
        expect(solids.map((s) => Math.round(s.volume())).sort((a, b) => a - b)).toEqual([125, 1000]);
    });

    test("an open mesh stays a surface", () => {
        const shape = fromStl(boxTriangles([0, 0, 0], [10, 10, 10]).slice(2)); // no bottom
        expect(count(shape, ShapeTypes.solid)).toBe(0);
        expect(count(shape, ShapeTypes.shell)).toBe(1);
    });
});

/** A 40 × 40 × 20 block with a sealed 10 × 10 × 10 void in its middle (z 5..15). */
function blockWithVoid(): IShape {
    const at = (x: number, y: number, z: number) => new XYZ({ x, y, z });
    const box = (o: XYZ, dx: number, dy: number, dz: number) =>
        shapeFactory.box(new Plane({ origin: o, normal: XYZ.unitZ, xvec: XYZ.unitX }), dx, dy, dz).value;
    const block = shapeFactory.booleanCut(
        [box(at(0, 0, 0), 40, 40, 20)],
        [box(at(15, 15, 5), 10, 10, 10)],
    ).value;
    expect(count(block, ShapeTypes.shell)).toBe(2);
    return block;
}

const faceAt = (shape: IShape, test: (center: XYZ, normal: XYZ) => boolean) =>
    (shape.findSubShapes(ShapeTypes.face) as IFace[]).find((face) => {
        const [center, normal] = face.normal(0.5, 0.5);
        const box = face.boundingBox();
        const mid = new XYZ({
            x: (box.min.x + box.max.x) / 2,
            y: (box.min.y + box.max.y) / 2,
            z: (box.min.z + box.max.z) / 2,
        });
        return center !== undefined && test(mid, normal);
    })!;

describe("Offset Face on a body with a sealed cavity", () => {
    test("the outer top face moves; the cavity is kept exactly as it was", () => {
        const block = blockWithVoid();
        const top = faceAt(block, (c, n) => n.z > 0.99 && Math.abs(c.z - 20) < 1e-6);
        const moved = offsetFacesKeepingCavities(block, [top], 5, [], false);
        expect(moved.isOk).toBe(true);
        const shape = moved.value.shape;
        expect(count(shape, ShapeTypes.shell)).toBe(2);
        expect(shape.checkShape()).toBe(true);
        expect(near(shape.volume(), 40 * 40 * 25 - 1000)).toBe(true);
        expect(shape.boundingBox().max.z).toBeCloseTo(25, 6);
        // the cavity's faces derive from themselves, the moved top from the top
        const outputs = shape.findSubShapes(ShapeTypes.face) as IFace[];
        const inputs = block.findSubShapes(ShapeTypes.face) as IFace[];
        const pairs = moved.value.faceAncestors;
        const ancestorOf = (out: number) => {
            for (let i = 0; i < pairs.length; i += 2) if (pairs[i] === out) return pairs[i + 1];
            return -1;
        };
        const newTop = outputs.findIndex((f) => f.boundingBox().min.z > 24.9);
        expect(inputs[ancestorOf(newTop)].isSame(top)).toBe(true);
        const cavityFloor = outputs.findIndex(
            (f) => Math.abs(f.boundingBox().max.z - 5) < 1e-6 && f.area() < 101,
        );
        expect(cavityFloor).toBeGreaterThanOrEqual(0);
        expect(inputs[ancestorOf(cavityFloor)].isSame(outputs[cavityFloor])).toBe(true);
    });

    test("a move that reaches the cavity is refused as a cavity problem, not some other failure", () => {
        const block = blockWithVoid();
        const top = faceAt(block, (c, n) => n.z > 0.99 && Math.abs(c.z - 20) < 1e-6);
        const moved = offsetFacesKeepingCavities(block, [top], -8, [], false); // top to z 12, inside the void
        expect(moved.isOk).toBe(false);
        expect(moved.error.status).toBe(4);
    });

    test("a body an older import left with a sliver 'cavity' offsets, and loses the sliver", () => {
        // what `meshToSolid` made before: the part's shell and the sliver's in ONE solid
        const sewn = shapeFactory.sewing([
            stlToShape(binaryStl([...boxTriangles([0, 0, 0], [10, 10, 10]), ...sliverTriangles([12, 0, 0])]))
                .value,
        ]).value;
        const old = mergePlanarFaces(shapeFactory.solid(sewn.findSubShapes(ShapeTypes.shell) as never).value);
        expect(count(old, ShapeTypes.shell)).toBe(2);
        const top = faceAt(old, (c, n) => n.z > 0.99 && Math.abs(c.z - 10) < 1e-6);
        const moved = offsetFacesKeepingCavities(old, [top], 2, [], false);
        expect(
            moved.isOk ? "ok" : `${JSON.stringify(moved.error)} faces ${count(old, ShapeTypes.face)}`,
        ).toBe("ok");
        expect(count(moved.value.shape, ShapeTypes.shell)).toBe(1);
        expect(near(moved.value.shape.volume(), 1200)).toBe(true);
    });

    test("a pick on the cavity's own wall is refused with its own status", () => {
        const block = blockWithVoid();
        const floor = faceAt(block, (c) => Math.abs(c.z - 5) < 1e-6);
        const moved = offsetFacesKeepingCavities(block, [floor], 1, [], false);
        expect(moved.isOk).toBe(false);
        expect(moved.error.status).toBe(CAVITY_WALL_STATUS);
    });

    test("through the feature: the body rebuilds, and a refusal is worded in the user's language", () => {
        const doc = new TestDocument({ application: createMockApplication() });
        doc.visual = createMockVisualWithDocument(doc) as any;
        const brep = shapeConverter.convertToBrep(blockWithVoid()).value;
        const body = new ParametricBodyNode({
            document: doc,
            features: [{ id: "i1", type: "imported", brep }],
        });
        doc.modelManager.addNode(body);
        const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
        const index = faces.findIndex((f) => f.normal(0.5, 0.5)[1].z > 0.99 && f.boundingBox().min.z > 19.9);
        const offset = (distance: number): OffsetFaceFeatureData => ({
            id: "o1",
            type: "offsetFace",
            faces: [
                captureProfileRef(
                    faces[index],
                    body.faceIdAt(index),
                    body.faceIdIsShared(body.faceIdAt(index)),
                ),
            ],
            distance,
        });
        body.setFeaturesEmitShapeChanged([...body.features, offset(3)]);
        expect(body.featureItems().map((x) => x.error)).toEqual([undefined, undefined]);
        expect(near(body.shape.value.volume(), 40 * 40 * 23 - 1000)).toBe(true);
        const topNow = (body.shape.value.findSubShapes(ShapeTypes.face) as IFace[]).findIndex(
            (f) => f.boundingBox().min.z > 22.9,
        );
        expect(body.faceIdAt(topNow)).toBe(body.faceIdAt(index) ?? "i1:f-missing");

        body.setFeaturesEmitShapeChanged([body.features[0], offset(-8)]);
        expect(body.featureItems()[1].error).toBe(I18n.translate("error.offsetFace.cavity"));
    });
});

/**
 * The user's STL files, which are not committed: `KERN3D_STL_FILES` lists them (`;`-separated).
 * Each takes minutes (the sewing of ~130 000 triangles alone is 3-6 minutes).
 */
const REAL_FILES = (process.env["KERN3D_STL_FILES"] ?? "").split(";").filter((f) => f && existsSync(f));

describe.skipIf(REAL_FILES.length === 0)("the user's STL files", () => {
    test.each(REAL_FILES)("%s: every solid one shell, nothing a sliver cavity", (file) => {
        const shape = meshToSolid(stlToShape(new Uint8Array(readFileSync(file))).value, "never").value;
        for (const solid of shape.findSubShapes(ShapeTypes.solid)) {
            expect(solid.findSubShapes(ShapeTypes.shell).length).toBe(1);
        }
    }, 1_800_000);
});
