// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AssemblyComponentNode,
    ancestorTransform,
    BoundingBox,
    GroupNode,
    type I18nKeys,
    type IDocument,
    Matrix4,
    owningComponent,
    Serializer,
    Transaction,
    VisualNode,
    XYZ,
} from "../src";
import { TestDocument } from "../test-utils";

/** A visual node that belongs to its document. */
class Body extends VisualNode {
    constructor(document: IDocument) {
        super(document, "body", "body-id");
    }
    display(): I18nKeys {
        return "common.ok";
    }
    boundingBox() {
        return new BoundingBox(XYZ.zero, XYZ.zero);
    }
}

const xyz = (x: number, y: number, z: number) => new XYZ({ x, y, z });

describe("AssemblyComponentNode", () => {
    test("is a group: it carries a placement and holds nodes", () => {
        const doc = new TestDocument();
        const component = new AssemblyComponentNode({ document: doc, name: "C" });
        expect(component).toBeInstanceOf(GroupNode);
        expect(component.grounded).toBe(false);
        expect(component.transformMode).toBe("direct");
    });

    test("grounding swaps the icon and tells the row", () => {
        const doc = new TestDocument();
        const component = new AssemblyComponentNode({ document: doc, name: "C" });
        const changed: string[] = [];
        component.onPropertyChanged((property) => changed.push(property as string));
        expect(component.icon).toBe("icon-group");
        component.grounded = true;
        expect(component.icon).toBe("icon-lock");
        expect(changed).toContain("grounded");
        expect(changed).toContain("icon");
    });

    test("grounded is undoable and survives serialization", () => {
        const doc = new TestDocument();
        const component = new AssemblyComponentNode({ document: doc, name: "C" });
        Transaction.execute(doc, "ground", () => {
            component.grounded = true;
        });
        const copy = Serializer.deserializeObject(doc, Serializer.serializeObject(component));
        expect((copy as AssemblyComponentNode).grounded).toBe(true);
        doc.history.undo();
        expect(component.grounded).toBe(false);
    });

    test("a world-space move of a nested component lands in world space", () => {
        const doc = new TestDocument();
        const parent = new AssemblyComponentNode({ document: doc, name: "P" });
        const child = new AssemblyComponentNode({ document: doc, name: "C" });
        doc.modelManager.rootNode.add(parent);
        parent.add(child);
        // The parent is turned a quarter about Z: the child's local X is world Y.
        parent.transform = Matrix4.fromAxisRad(XYZ.zero, XYZ.unitZ, Math.PI / 2);
        expect(child.applyTransform(Matrix4.fromTranslation(10, 0, 0))).toBe(true);
        const world = child.transform.multiply(ancestorTransform(child));
        expect(world.ofPoint(XYZ.zero).distanceTo(xyz(10, 0, 0))).toBeLessThan(1e-9);
    });

    test("a body's world placement composes every group above it, displayed or not", () => {
        const doc = new TestDocument();
        const outer = new AssemblyComponentNode({ document: doc, name: "O" });
        const inner = new AssemblyComponentNode({ document: doc, name: "I" });
        const body = new Body(doc);
        doc.modelManager.rootNode.add(outer);
        outer.add(inner);
        inner.add(body);
        outer.transform = Matrix4.fromTranslation(0, 0, 100);
        inner.transform = Matrix4.fromTranslation(5, 0, 0);
        expect(
            body
                .worldTransform()
                .ofPoint(XYZ.zero)
                .distanceTo(xyz(5, 0, 100)),
        ).toBeLessThan(1e-9);
        expect(owningComponent(body)).toBe(inner);
        expect(owningComponent(inner)).toBe(outer);
        expect(
            ancestorTransform(body, outer)
                .ofPoint(XYZ.zero)
                .distanceTo(xyz(5, 0, 0)),
        ).toBeLessThan(1e-9);
    });
});
