// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { AssemblyComponentNode, EditableShapeNode, Matrix4, Plane, XYZ } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { beforeAll, describe, expect, test } from "@rstest/core";
import { worldShapeOf } from "../../../src/commands/inspect/inspectUtils";
import { findInterferences } from "../../../src/commands/inspect/interference";

beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(path.resolve(import.meta.dirname, "../../../../wasm/lib/chili-wasm.wasm")),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

function boxIn(doc: TestDocument, component: AssemblyComponentNode, x: number): EditableShapeNode {
    const plane = Plane.XY.translateTo(new XYZ({ x, y: 0, z: 0 }));
    const node = new EditableShapeNode({
        document: doc,
        name: "box",
        shape: shapeFactory.box(plane, 10, 10, 10).value,
    });
    component.add(node);
    return node;
}

describe("interference between assembly components", () => {
    test("bodies are checked where their components place them", () => {
        const doc = new TestDocument();
        const a = new AssemblyComponentNode({ document: doc, name: "A" });
        const b = new AssemblyComponentNode({ document: doc, name: "B" });
        doc.modelManager.rootNode.add(a, b);
        const first = boxIn(doc, a, 0);
        const second = boxIn(doc, b, 50);

        const check = () => {
            const shapes = [first, second].map(worldShapeOf);
            const found = findInterferences(shapes);
            shapes.forEach((s) => s.dispose());
            return found;
        };
        // Apart in their own spaces…
        expect(check()).toHaveLength(0);
        // …and overlapping by half once component B is moved 45 mm back towards A.
        b.transform = Matrix4.fromTranslation(-45, 0, 0);
        const found = check();
        expect(found).toHaveLength(1);
        expect(found[0].volume).toBeCloseTo(5 * 10 * 10, 3);
        found.forEach((item) => item.overlap.dispose());
    });
});
