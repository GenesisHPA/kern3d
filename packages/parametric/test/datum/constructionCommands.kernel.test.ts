// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommandStore, PropertyUtils, XYZ } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { rs } from "@rstest/core";
import { AxisCommand } from "../../src/commands/axisCommand";
import { AXIS_OR_MODEL_NODES } from "../../src/commands/patternSources";
import { PlaneCommand } from "../../src/commands/planeCommand";
import { PointCommand } from "../../src/commands/pointCommand";
import { AxisNode, DatumPointNode } from "../../src/datum";
import { PlaneNode } from "../../src/plane/planeNode";

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
    if (previousFactory !== undefined) {
        Object.defineProperty(globalThis, "shapeFactory", previousFactory);
    } else {
        delete (globalThis as { shapeFactory?: unknown }).shapeFactory;
    }
});

function setup<T>(make: () => T) {
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
    const cmd = make() as any;
    cmd._application = app;
    return { cmd, doc };
}

const XY = { kind: "datum", name: "XY" } as const;
const YZ = { kind: "datum", name: "YZ" } as const;
const ZX = { kind: "datum", name: "ZX" } as const;

describe("construction commands", () => {
    test("the ribbon keys resolve to the commands", () => {
        expect(CommandStore.getCommand("feature.axis")).toBe(AxisCommand);
        expect(CommandStore.getCommand("feature.point")).toBe(PointCommand);
    });

    test("the panels show the type rows", () => {
        expect(PropertyUtils.getProperties(new AxisCommand()).map((x) => x.name)).toEqual(
            expect.arrayContaining(["axisType", "flip"]),
        );
        expect(PropertyUtils.getProperties(new PointCommand()).map((x) => x.name)).toEqual(
            expect.arrayContaining(["pointType", "ratio"]),
        );
        expect(PropertyUtils.getProperties(new PlaneCommand()).map((x) => x.name)).toEqual(
            expect.arrayContaining(["tangentAngle"]),
        );
    });

    test("the axis command commits an axis node where two planes meet", () => {
        const { cmd, doc } = setup(() => new AxisCommand());
        cmd.setPrivateValue("axisType", "feature.axis.twoPlanes");
        cmd.setRefs({ first: XY, second: ZX, anchors: {} });
        expect(cmd.previewMeshes()).toHaveLength(1);

        cmd.executeMainTask();
        const node = doc.modelManager.findNode((n) => n instanceof AxisNode) as AxisNode | undefined;
        expect(node).toBeDefined();
        expect(node!.definition.kind).toBe("twoPlanes");
        expect(Math.abs(node!.worldAxis()!.direction.dot(XYZ.unitX))).toBeCloseTo(1, 6);
        expect(node!.isReferenceGeometry).toBe(true);
        // A datum axis is admitted where a revolve/pattern axis is picked; a datum plane is not.
        expect(AXIS_OR_MODEL_NODES.allow(node!)).toBe(true);
        expect(AXIS_OR_MODEL_NODES.allow(new PlaneNode({ document: doc }))).toBe(false);
    });

    test("an axis command without its picks is an error, not a node", () => {
        const { cmd, doc } = setup(() => new AxisCommand());
        cmd.setPrivateValue("axisType", "feature.axis.edge");
        cmd.setRefs({ anchors: {} });
        expect(cmd.buildDefinition().isOk).toBe(false);
        cmd.executeMainTask();
        expect(doc.modelManager.findNode((n) => n instanceof AxisNode)).toBeUndefined();
    });

    test("the point command commits a point where three planes meet", () => {
        const { cmd, doc } = setup(() => new PointCommand());
        cmd.setPrivateValue("pointType", "feature.point.threePlanes");
        cmd.setRefs({ planes: [XY, YZ, ZX], anchors: {} });
        expect(cmd.previewMeshes()).toHaveLength(1);

        cmd.executeMainTask();
        const node = doc.modelManager.findNode((n) => n instanceof DatumPointNode) as
            | DatumPointNode
            | undefined;
        expect(node).toBeDefined();
        expect(node!.worldPoint()!.isEqualTo(XYZ.zero)).toBe(true);
    });

    test("the on-edge ratio reaches the definition", () => {
        const { cmd } = setup(() => new PointCommand());
        cmd.setPrivateValue("pointType", "feature.point.onEdge");
        cmd.setRefs({
            edge: {
                nodeId: "b",
                edge: { kind: "line", start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 } },
            },
            anchors: {},
        });
        cmd.ratio = 0.3;
        const definition = cmd.buildDefinition();
        expect(definition.isOk).toBe(true);
        expect(definition.value).toMatchObject({ kind: "onEdge", ratio: 0.3 });
    });

    test("the plane command builds a tangent definition from a face pick", () => {
        const { cmd } = setup(() => new PlaneCommand());
        cmd.setPrivateValue("planeType", "feature.plane.tangent");
        cmd.setRefs({
            face: { nodeId: "b", face: { edges: [] } },
            at: { x: 5, y: 0, z: 0 },
            anchors: {},
        });
        cmd.tangentAngle = 45;
        const definition = cmd.buildDefinition();
        expect(definition.isOk).toBe(true);
        expect(definition.value).toMatchObject({ kind: "tangent", angle: 45, at: { x: 5, y: 0, z: 0 } });
    });
});
