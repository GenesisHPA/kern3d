// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    AssemblyComponentNode,
    type IEdge,
    type IFace,
    type IShape,
    type IVertex,
    Matrix4,
    ShapeTypes,
    Transaction,
    XYZ,
} from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { AssemblyService, nodeWorldTransform } from "../../src/assembly/assemblyService";
import { createComponent } from "../../src/assembly/componentCommands";
import { JointNode } from "../../src/assembly/jointNode";
import { captureJointOrigin, snapFrame, snapOfPick } from "../../src/assembly/jointOrigin";
import type { FeatureData, PrimitiveFeatureData } from "../../src/features/feature";
import { ParametricBodyNode } from "../../src/parametricBodyNode";

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

function scene() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

/** A box body with its corner at `origin`. */
function box(doc: TestDocument, size: [number, number, number], origin = xyz(0, 0, 0)) {
    const feature: PrimitiveFeatureData = {
        id: "p1",
        type: "primitive",
        primitive: "box",
        origin: { x: origin.x, y: origin.y, z: origin.z },
        dx: size[0],
        dy: size[1],
        dz: size[2],
    };
    const node = new ParametricBodyNode({ document: doc, features: [feature as FeatureData] });
    doc.modelManager.addNode(node);
    expect(node.shape.isOk).toBe(true);
    return node;
}

function subShapes<T extends IShape>(body: ParametricBodyNode, type: number): T[] {
    return body.shape.unchecked()!.findSubShapes(type as never) as T[];
}

/** The index of the box face whose outward normal is `normal`. */
function faceIndex(body: ParametricBodyNode, normal: XYZ): number {
    return subShapes<IFace>(body, ShapeTypes.face).findIndex((f) => f.normal(0, 0)[1].isEqualTo(normal));
}

function faceOrigin(body: ParametricBodyNode, normal: XYZ) {
    const index = faceIndex(body, normal);
    const face = subShapes<IFace>(body, ShapeTypes.face)[index];
    return captureJointOrigin(body, face, index, undefined)!;
}

/** A base block at the root and a part in a component, the part's bottom jointed to the block's top. */
function stacked(doc: TestDocument) {
    const base = box(doc, [40, 40, 10]);
    const part = box(doc, [10, 10, 30], xyz(100, 0, 0));
    let component!: AssemblyComponentNode;
    Transaction.execute(doc, "component", () => {
        component = createComponent(doc, [part]);
    });
    const joint = new JointNode({
        document: doc,
        name: "Joint1",
        jointType: "revolute",
        origin1: faceOrigin(base, XYZ.unitZ),
        origin2: faceOrigin(part, xyz(0, 0, -1)),
    });
    Transaction.execute(doc, "joint", () => doc.modelManager.rootNode.add(joint));
    return { base, part, component, joint };
}

/** Where the part's bottom-centre point is in the world. */
function partBottom(component: AssemblyComponentNode) {
    return nodeWorldTransform(component).ofPoint(xyz(105, 5, 0));
}

describe("joint origins snap to the usual points", () => {
    test("a face: its centre, oriented by the outward normal", () => {
        const doc = scene();
        const body = box(doc, [40, 20, 10]);
        const ref = faceOrigin(body, XYZ.unitZ);
        expect(ref.snap).toBe("faceCenter");
        expect(new XYZ(ref.frame.origin).distanceTo(xyz(20, 10, 10))).toBeLessThan(1e-6);
        expect(new XYZ(ref.frame.z).isEqualTo(XYZ.unitZ)).toBe(true);
        expect(ref.subId).toBeDefined();
    });

    test("a face clicked near a corner snaps to the vertex, keeping the face's normal", () => {
        const doc = scene();
        const body = box(doc, [40, 20, 10]);
        const index = faceIndex(body, XYZ.unitZ);
        const face = subShapes<IFace>(body, ShapeTypes.face)[index];
        const ref = captureJointOrigin(body, face, index, xyz(39, 19, 10))!;
        expect(ref.snap).toBe("facePoint");
        expect(new XYZ(ref.frame.origin).distanceTo(xyz(40, 20, 10))).toBeLessThan(1e-6);
        expect(new XYZ(ref.frame.z).isEqualTo(XYZ.unitZ)).toBe(true);
    });

    test("a straight edge: the nearest of midpoint and ends, oriented along the edge", () => {
        const doc = scene();
        const body = box(doc, [40, 20, 10]);
        const edges = subShapes<IEdge>(body, ShapeTypes.edge);
        const edge = edges.find((e) => {
            const [s, t] = e.ends();
            return (
                Math.abs(s.z) < 1e-6 && Math.abs(t.z) < 1e-6 && Math.abs(s.y) < 1e-6 && Math.abs(t.y) < 1e-6
            );
        })!;
        expect(snapOfPick(edge, xyz(21, 0, 0))).toBe("edgeMid");
        expect(snapOfPick(edge, xyz(39, 0, 0))).not.toBe("edgeMid");
        const frame = snapFrame(edge, "edgeMid")!;
        expect(new XYZ(frame.origin).distanceTo(xyz(20, 0, 0))).toBeLessThan(1e-6);
        expect(Math.abs(new XYZ(frame.z).dot(XYZ.unitX))).toBeCloseTo(1, 9);
    });

    test("a circular edge: its centre, oriented along the axis; a cylinder face: its axis", () => {
        const cylinder = shapeFactory.cylinder(XYZ.unitZ, xyz(5, 5, 0), 3, 8).value;
        const circle = (cylinder.findSubShapes(ShapeTypes.edge) as IEdge[]).find(
            (e) => snapOfPick(e, undefined) === "circleCenter",
        )!;
        const frame = snapFrame(circle, "circleCenter")!;
        expect(new XYZ(frame.origin).x).toBeCloseTo(5, 6);
        expect(new XYZ(frame.origin).y).toBeCloseTo(5, 6);
        expect(Math.abs(new XYZ(frame.z).z)).toBeCloseTo(1, 9);

        const lateral = (cylinder.findSubShapes(ShapeTypes.face) as IFace[]).find(
            (f) => !f.surface().isPlanar(),
        )!;
        const axis = snapFrame(lateral, "faceCenter")!;
        expect(new XYZ(axis.origin).distanceTo(xyz(5, 5, 4))).toBeLessThan(1e-3);
        expect(Math.abs(new XYZ(axis.z).z)).toBeCloseTo(1, 9);
    });

    test("a vertex: the point itself", () => {
        const doc = scene();
        const body = box(doc, [4, 2, 1]);
        const vertex = subShapes<IVertex>(body, ShapeTypes.vertex)[0];
        const frame = snapFrame(vertex, "vertex")!;
        expect(new XYZ(frame.origin).isEqualTo(vertex.point())).toBe(true);
    });
});

describe("assembly solve", () => {
    test("a joint moves component 2 onto component 1's origin, faces mated", () => {
        const doc = scene();
        const { component, joint } = stacked(doc);
        expect(joint.status).toBe("ok");
        // The part's bottom centre (105, 5, 0) lands on the block's top centre (20, 20, 10).
        expect(partBottom(component).distanceTo(xyz(20, 20, 10))).toBeLessThan(1e-6);
        // Upright: the part's top is above its bottom.
        expect(nodeWorldTransform(component).ofVector(XYZ.unitZ).z).toBeCloseTo(1, 9);
    });

    test("editing the rotation turns the part; the limits hold it", () => {
        const doc = scene();
        const { component, joint } = stacked(doc);
        Transaction.execute(doc, "drive", () => {
            joint.rotation = 90;
        });
        const xAxis = nodeWorldTransform(component).ofVector(XYZ.unitX);
        expect(xAxis.distanceTo(XYZ.unitY)).toBeLessThan(1e-9);
        Transaction.execute(doc, "limit", () => {
            joint.rotationLimited = true;
            joint.rotationMin = 0;
            joint.rotationMax = 45;
            joint.rotation = 90;
        });
        expect(joint.rotation).toBe(45);
    });

    test("undo puts the joint's motion back with it, redo replays it", () => {
        const doc = scene();
        const { component, joint } = stacked(doc);
        const placed = component.transform;
        Transaction.execute(doc, "drive", () => {
            joint.rotation = 90;
        });
        expect(component.transform.equals(placed)).toBe(false);
        doc.history.undo();
        expect(joint.rotation).toBe(0);
        expect(component.transform.equals(placed)).toBe(true);
        doc.history.redo();
        expect(joint.rotation).toBe(90);
        expect(component.transform.equals(placed)).toBe(false);

        // Undoing the joint itself returns the part to where it was before.
        doc.history.undo();
        doc.history.undo();
        expect(doc.modelManager.findNode((n) => n === joint)).toBeUndefined();
        expect(component.transform.equals(Matrix4.identity())).toBe(true);
    });

    test("the joint follows a rebuild: a taller block lifts the part", () => {
        const doc = scene();
        const { base, component, joint } = stacked(doc);
        Transaction.execute(doc, "edit", () => base.setFeatureParameter("p1", "dz", 25));
        expect(joint.status).toBe("ok");
        expect(joint.originLost).toBe(false);
        expect(partBottom(component).distanceTo(xyz(20, 20, 25))).toBeLessThan(1e-6);
    });

    test("a grounded component is never moved; component 1 comes to it instead", () => {
        const doc = scene();
        const left = box(doc, [10, 10, 10]);
        const right = box(doc, [10, 10, 10], xyz(50, 0, 0));
        let a!: AssemblyComponentNode;
        let b!: AssemblyComponentNode;
        Transaction.execute(doc, "components", () => {
            a = createComponent(doc, [left]);
            b = createComponent(doc, [right]);
            b.grounded = true;
        });
        const joint = new JointNode({
            document: doc,
            name: "J",
            origin1: faceOrigin(left, XYZ.unitZ),
            origin2: faceOrigin(right, xyz(0, 0, -1)),
        });
        Transaction.execute(doc, "joint", () => doc.modelManager.rootNode.add(joint));
        expect(b.transform.equals(Matrix4.identity())).toBe(true);
        // a's top (5, 5, 10) meets b's bottom (55, 5, 0): a moves down by 10 and right by 50
        expect(
            nodeWorldTransform(a)
                .ofPoint(xyz(5, 5, 10))
                .distanceTo(xyz(55, 5, 0)),
        ).toBeLessThan(1e-6);
    });

    test("moving a free component 1 drags component 2 along", () => {
        const doc = scene();
        const base = box(doc, [10, 10, 10]);
        const part = box(doc, [10, 10, 10], xyz(50, 0, 0));
        let a!: AssemblyComponentNode;
        let b!: AssemblyComponentNode;
        Transaction.execute(doc, "components", () => {
            a = createComponent(doc, [base]);
            b = createComponent(doc, [part]);
        });
        const joint = new JointNode({
            document: doc,
            name: "J",
            origin1: faceOrigin(base, XYZ.unitZ),
            origin2: faceOrigin(part, xyz(0, 0, -1)),
        });
        Transaction.execute(doc, "joint", () => doc.modelManager.rootNode.add(joint));
        Transaction.execute(doc, "move", () => {
            a.transform = Matrix4.fromTranslation(0, 0, 100);
        });
        expect(
            nodeWorldTransform(b)
                .ofPoint(xyz(55, 5, 0))
                .distanceTo(xyz(5, 5, 110)),
        ).toBeLessThan(1e-6);
    });
});

describe("persistence", () => {
    test("components and joints survive a save/load round trip", async () => {
        const doc = scene();
        const { component, joint } = stacked(doc);
        Transaction.execute(doc, "edit", () => {
            component.grounded = false;
            joint.rotationLimited = true;
            joint.rotationMax = 120;
            joint.rotation = 30;
            joint.offset = 2;
        });
        const saved = JSON.parse(JSON.stringify(doc.modelManager.serialize()));

        const loaded = scene();
        await loaded.modelManager.deserialize(saved);
        const joints = loaded.modelManager.findNodes((n) => n instanceof JointNode) as JointNode[];
        const components = loaded.modelManager.findNodes((n) => n instanceof AssemblyComponentNode);
        expect(joints).toHaveLength(1);
        expect(components).toHaveLength(1);
        const copy = joints[0];
        expect(copy.jointType).toBe("revolute");
        expect(copy.rotation).toBe(30);
        expect(copy.rotationLimited).toBe(true);
        expect(copy.rotationMax).toBe(120);
        expect(copy.offset).toBe(2);
        expect(copy.originRef(1)).toEqual(joint.originRef(1));
        expect((components[0] as AssemblyComponentNode).transform.equals(component.transform)).toBe(true);

        // The loaded assembly is live: a drive edit moves the loaded part.
        await Promise.resolve();
        const before = (components[0] as AssemblyComponentNode).transform;
        Transaction.execute(loaded, "drive", () => {
            copy.rotation = 90;
        });
        expect(AssemblyService.of(loaded).joints()).toHaveLength(1);
        expect((components[0] as AssemblyComponentNode).transform.equals(before)).toBe(false);
    });

    test("a document without assembly nodes loads as before", async () => {
        const doc = scene();
        box(doc, [1, 2, 3]);
        const saved = JSON.parse(JSON.stringify(doc.modelManager.serialize()));
        const loaded = scene();
        await loaded.modelManager.deserialize(saved);
        expect(loaded.modelManager.findNodes((n) => n instanceof ParametricBodyNode)).toHaveLength(1);
    });
});
