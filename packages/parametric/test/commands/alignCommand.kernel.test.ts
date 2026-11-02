// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    CommandStore,
    EditableShapeNode,
    type IFace,
    type IShape,
    Matrix4,
    Plane,
    PropertyUtils,
    ShapeNode,
    ShapeTypes,
    XYZ,
} from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { rs } from "@rstest/core";
import { AlignCommand } from "../../src/commands/alignCommand";
import { MoveCopyCommand } from "../../src/commands/moveCopyCommand";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

const xyz = (x: number, y: number, z: number) => new XYZ({ x, y, z });

function box(corner: XYZ, dx: number, dy: number, dz: number): IShape {
    const plane = new Plane({ origin: corner, normal: XYZ.unitZ, xvec: XYZ.unitX });
    return shapeFactory.box(plane, dx, dy, dz).value;
}

function faceOf(shape: IShape, normal: XYZ): IFace {
    const faces = shape.findSubShapes(ShapeTypes.face) as IFace[];
    return faces.find((face) => face.normal(0, 0)[1].normalize()!.isEqualTo(normal))!;
}

/** A document holding A (10 × 20 × 30 at the origin) and B (40 × 40 × 10 at x = 100). */
function scene() {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app });
    (app as any).activeView = { document: doc };
    doc.visual = createMockVisualWithDocument(doc) as any;
    doc.selection = {
        getSelectedShapes: () => [],
        getSelectedNodes: () => [],
        setSelectedShapes: rs.fn(),
        setSelectedNodes: rs.fn(),
        clearSelection: () => {},
    } as any;
    const a = new EditableShapeNode({ document: doc, name: "A", shape: box(XYZ.zero, 10, 20, 30), id: "a" });
    const b = new EditableShapeNode({
        document: doc,
        name: "B",
        shape: box(xyz(100, 0, 0), 40, 40, 10),
        id: "b",
    });
    doc.modelManager.addNode(a);
    doc.modelManager.addNode(b);
    return { app, doc, a, b };
}

function worldBounds(node: ShapeNode) {
    return node.shape.value.transformedMul(node.transform).boundingBox();
}

function alignBottomOntoTop(app: unknown, a: EditableShapeNode, b: EditableShapeNode) {
    const cmd = new AlignCommand();
    (cmd as any)._application = app;
    cmd.setPicks(
        { shape: faceOf(a.shape.value, XYZ.unitNZ), transform: Matrix4.identity() },
        { shape: faceOf(b.shape.value, XYZ.unitZ), transform: Matrix4.identity() },
        a,
    );
    return cmd;
}

describe("AlignCommand", () => {
    test("is registered with its panel options", () => {
        expect(CommandStore.getCommand("modify.align")).toBe(AlignCommand);
        const names = PropertyUtils.getProperties(new AlignCommand()).map((x) => x.name);
        expect(names).toEqual(expect.arrayContaining(["flip", "angle", "snapToCenter", "isClone"]));
    });

    test("moves the picked part flush onto the target face", () => {
        const { app, a, b } = scene();
        const cmd = alignBottomOntoTop(app, a, b);

        (cmd as any).executeMainTask();

        const bounds = worldBounds(a);
        expect(bounds.min.z).toBeCloseTo(10, 3);
        expect(bounds.max.z).toBeCloseTo(40, 3);
        expect((bounds.min.x + bounds.max.x) / 2).toBeCloseTo(120, 3);
        expect(b.transform.equals(Matrix4.identity())).toBe(true);
    });

    test("copy leaves the original and inserts an aligned copy", () => {
        const { app, doc, a, b } = scene();
        const cmd = alignBottomOntoTop(app, a, b);
        cmd.isClone = true;

        (cmd as any).executeMainTask();

        expect(a.transform.equals(Matrix4.identity())).toBe(true);
        const nodes = doc.modelManager.findNodes((node) => node instanceof ShapeNode);
        expect(nodes).toHaveLength(3);
        const copy = nodes.find((node) => node !== a && node !== b) as ShapeNode;
        expect(worldBounds(copy).min.z).toBeCloseTo(10, 3);
    });

    test("an unresolvable angle refuses to commit", () => {
        const { app, a, b } = scene();
        const cmd = alignBottomOntoTop(app, a, b);
        cmd.angle = "no_such_variable * 2";

        expect(cmd.transform()).toBeUndefined();
        (cmd as any).executeMainTask();
        expect(a.transform.equals(Matrix4.identity())).toBe(true);
    });
});

describe("MoveCopyCommand", () => {
    function moveCopy(app: unknown, nodes: EditableShapeNode[]) {
        const cmd = new MoveCopyCommand();
        (cmd as any)._application = app;
        (cmd as any).stepDatas = [{ nodes, shapes: [], type: "node" }];
        return cmd;
    }

    test("is registered with its panel options", () => {
        expect(CommandStore.getCommand("modify.moveCopy")).toBe(MoveCopyCommand);
        const names = PropertyUtils.getProperties(new MoveCopyCommand()).map((x) => x.name);
        expect(names).toEqual(
            expect.arrayContaining(["dx", "dy", "dz", "rx", "ry", "rz", "pickPivot", "isClone"]),
        );
    });

    test("turns about the selection's centre, then moves by the typed values", () => {
        const { app, a } = scene();
        const cmd = moveCopy(app, [a]);
        cmd.dx = 50;
        cmd.dz = "5 + 5";
        cmd.rz = 90;

        expect(cmd.pivot().isEqualTo(xyz(5, 10, 15))).toBe(true);
        (cmd as any).executeMainTask();

        // 10 × 20 footprint turned to 20 × 10 about (5, 10), then +50 in X and +10 in Z.
        const bounds = worldBounds(a);
        expect(bounds.min.x).toBeCloseTo(45, 3);
        expect(bounds.max.x).toBeCloseTo(65, 3);
        expect(bounds.min.y).toBeCloseTo(5, 3);
        expect(bounds.max.y).toBeCloseTo(15, 3);
        expect(bounds.min.z).toBeCloseTo(10, 3);
    });

    test("copy keeps the original in place", () => {
        const { app, doc, a } = scene();
        const cmd = moveCopy(app, [a]);
        cmd.dy = -30;
        cmd.isClone = true;

        (cmd as any).executeMainTask();

        expect(a.transform.equals(Matrix4.identity())).toBe(true);
        const nodes = doc.modelManager.findNodes((node) => node instanceof ShapeNode);
        expect(nodes).toHaveLength(3);
        const copy = nodes.find((node) => node !== a && node.name !== "B") as ShapeNode;
        expect(worldBounds(copy).min.y).toBeCloseTo(-30, 3);
    });
});
