// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EditableShapeNode, Matrix4, Plane, ShapeTypes, XYZ, type XYZLike } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, OccShapeConverter, ShapeFactory } from "@chili3d/wasm";
import { makeEditable } from "../src/commands/makeEditableCommand";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import "./sketch/setup";

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

function documentWith(node: (doc: TestDocument) => EditableShapeNode) {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    const imported = node(doc);
    doc.modelManager.addNode(imported);
    return { doc, imported };
}

const round = (b: { min: XYZLike; max: XYZLike }) =>
    [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((x) => Math.round(x * 1000) / 1000);

describe("imported bodies made editable", () => {
    test("a part placed by its own location (as STEP brings it) keeps its place", () => {
        // a 40 × 20 × 10 box turned 90° about Z and moved: the placement lives in the shape
        const box = shapeFactory.box(Plane.XY, 40, 20, 10).value;
        const placed = box.transformedMul(
            Matrix4.fromAxisRad(XYZ.zero, XYZ.unitZ, Math.PI / 2).multiply(Matrix4.fromTranslation(5, 7, 3)),
        );
        const { doc, imported } = documentWith(
            (d) => new EditableShapeNode({ document: d, name: "part", shape: placed }),
        );
        const before = round(imported.shape.value.boundingBox()!);
        expect(makeEditable([doc.modelManager.rootNode])).toBe(1);
        const body = doc.modelManager.findNodes(
            (n) => n instanceof ParametricBodyNode,
        )[0] as ParametricBodyNode;
        expect(body.name).toBe("part");
        expect(body.shape.isOk).toBe(true);
        expect(round(body.shape.value.boundingBox()!)).toEqual(before);
        expect(body.features.map((f) => f.type)).toEqual(["imported"]);
    });

    test("a hole drilled into it: an ordinary feature on top of the imported shape", () => {
        const { doc } = documentWith(
            (d) =>
                new EditableShapeNode({
                    document: d,
                    name: "plate",
                    shape: shapeFactory.box(Plane.XY, 40, 20, 10).value,
                }),
        );
        makeEditable([doc.modelManager.rootNode]);
        const body = doc.modelManager.findNodes(
            (n) => n instanceof ParametricBodyNode,
        )[0] as ParametricBodyNode;
        const volume = body.shape.value.volume();
        body.setFeaturesEmitShapeChanged([
            ...body.features,
            {
                id: "c1",
                type: "primitive",
                primitive: "cylinder",
                origin: { x: 20, y: 10, z: -5 },
                radius: 4,
                height: 30,
                operation: "cut",
            } as any,
        ]);
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeLessThan(volume - 1);
        expect(body.features.map((f) => f.type)).toEqual(["imported", "primitive"]);
    });
});

const STEP = process.env["KERN3D_STEP"];

describe.skipIf(!STEP)("a real STEP part made editable", () => {
    test("a chamfer on every straight edge of each part, one at a time", async () => {
        const { OccShape } = await import("../../wasm/src/shape");
        const { captureEdgeRef } = await import("../src/features/edgeRef");
        const root = (globalThis as any).wasm.Converter.convertFromStep(new Uint8Array(readFileSync(STEP!)));
        const nodes: any[] = [];
        const walk = (n: any) => {
            if (n.shape && !n.shape.isNull()) nodes.push({ name: n.name, shape: OccShape.wrap(n.shape) });
            for (const c of n.getChildren()) walk(c);
        };
        walk(root);
        const report: string[] = [];
        for (const { name, shape } of nodes) {
            const { doc } = documentWith((d) => new EditableShapeNode({ document: d, name, shape }));
            makeEditable([doc.modelManager.rootNode]);
            const body = doc.modelManager.findNodes(
                (n) => n instanceof ParametricBodyNode,
            )[0] as ParametricBodyNode;
            const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as any[];
            const k = edges.findIndex((e) => {
                try {
                    return e.curve.basisCurve.curveType === "line";
                } catch {
                    return false;
                }
            });
            if (k < 0) continue;
            const id = body.edgeIdAt(k);
            body.setFeaturesEmitShapeChanged([
                ...body.features,
                {
                    id: "ch",
                    type: "chamfer",
                    distance: Number(process.env["CH"] ?? 0.2),
                    edges: [captureEdgeRef(edges[k], id, body.edgeIdIsShared(id))],
                } as any,
            ]);
            report.push(`${name}: ${body.shape.isOk ? "ok" : body.shape.error}`);
        }
        require("node:fs").writeFileSync(process.env["PROBE_OUT"] ?? "probe.out", report.join("\n"));
    });
});
