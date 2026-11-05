// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IFace, Plane, ShapeTypes, XYZ } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { isOpeningCenterOf } from "../src/commands/holeCommand";
import type { HoleFeatureData } from "../src/features/feature";
import { captureProfileRef } from "../src/features/profileRef";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { captureFaceRef } from "../src/sketch/planeRef";
import type { SketchData } from "../src/sketch/sketchModel";
import { SketchNode } from "../src/sketch/sketchNode";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/chili-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

const rect: SketchData = {
    entities: [
        { id: 1, type: "line", params: [-20, -20, 20, -20] },
        { id: 2, type: "line", params: [20, -20, 20, 20] },
        { id: 3, type: "line", params: [20, 20, -20, 20] },
        { id: 4, type: "line", params: [-20, 20, -20, -20] },
    ],
    constraints: [],
};

const facesOf = (body: ParametricBodyNode) =>
    body.shape.unchecked()!.findSubShapes(ShapeTypes.face) as IFace[];
const errors = (body: ParametricBodyNode) => body.featureItems().map((x) => x.error);

/** The top (z = 20, +Z) planar face of the body as it is now, with its stable id. */
function topFace(body: ParametricBodyNode) {
    const faces = facesOf(body);
    const index = faces.findIndex(
        (f) => f.surface().isPlanar() && f.normal(0, 0)[1].z > 1 - 1e-6 && f.boundingBox().max.z > 19.9,
    );
    return { face: faces[index], id: body.faceIdAt(index) };
}

function plate() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    const sketchNode = new SketchNode({ document: doc, plane: Plane.XY, data: rect });
    doc.modelManager.addNode(sketchNode);
    const profiles = sketchNode.mesh.faces?.range.filter((x) => x.shape.shapeType === ShapeTypes.face) ?? [];
    const body = new ParametricBodyNode({
        document: doc,
        features: [
            {
                id: "e1",
                type: "extrude",
                sketchId: sketchNode.id,
                depth: 20,
                profiles: [captureProfileRef(profiles[0].shape as unknown as IFace)],
            },
        ],
    });
    doc.modelManager.addNode(body);
    return body;
}

function addHole(body: ParametricBodyNode, id: string, patch: Partial<HoleFeatureData>) {
    const top = topFace(body);
    body.setFeaturesEmitShapeChanged([
        ...body.features,
        {
            id,
            type: "hole",
            face: { ...captureFaceRef(body.id, top.face), faceId: top.id },
            points: [[8, 8]],
            style: "simple",
            diameter: 5,
            ...patch,
        } satisfies HoleFeatureData,
    ]);
}

describe("a second, wider and shallower hole on the same axis (a hand-made counterbore)", () => {
    test("through hole, then Ø10 × 5 on top of it", () => {
        const body = plate();
        addHole(body, "h1", { diameter: 5 });
        expect(errors(body)).toEqual([undefined, undefined]);
        addHole(body, "h2", { diameter: 10, depth: 5 });
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
    });

    test("blind hole, then Ø10 × 5 on top of it", () => {
        const body = plate();
        addHole(body, "h1", { diameter: 5, depth: 15 });
        expect(errors(body)).toEqual([undefined, undefined]);
        addHole(body, "h2", { diameter: 10, depth: 5 });
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
    });
});

describe("picking the center of an existing hole", () => {
    test("the hole's axis on the face counts as a center; plain empty space does not", () => {
        const body = plate();
        addHole(body, "h1", { diameter: 5 });
        const top = topFace(body).face;
        expect(isOpeningCenterOf(top, new XYZ({ x: 8, y: 8, z: 20 }))).toBe(true);
        expect(isOpeningCenterOf(top, new XYZ({ x: 9, y: 8, z: 20 }))).toBe(false);
    });
});
