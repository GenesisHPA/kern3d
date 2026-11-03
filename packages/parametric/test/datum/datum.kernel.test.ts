// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    CurveUtils,
    type IEdge,
    type IFace,
    type IVertex,
    Matrix4,
    Plane,
    ShapeTypes,
    XYZ,
} from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { type AxisDefinition, AxisNode, DatumPointNode, type PointDefinition } from "../../src/datum";
import { captureEdgeRef } from "../../src/features/edgeRef";
import type { FeatureData } from "../../src/features/feature";
import { captureVertexRef } from "../../src/features/vertexRef";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { captureVertexAnchors, type EdgeSourceRef, type PointRef } from "../../src/plane/planeDefinition";
import { PlaneNode } from "../../src/plane/planeNode";
import { captureFaceSource, type FaceSourceRef } from "../../src/plane/sourceRefs";
import { type SketchData, SketchNode } from "../../src/sketch";
import { captureFaceRef } from "../../src/sketch/planeRef";

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

function rect(x0: number, y0: number, x1: number, y1: number): SketchData {
    return {
        entities: [
            { id: 1, type: "line", params: [x0, y0, x1, y0] },
            { id: 2, type: "line", params: [x1, y0, x1, y1] },
            { id: 3, type: "line", params: [x1, y1, x0, y1] },
            { id: 4, type: "line", params: [x0, y1, x0, y0] },
        ],
        constraints: [],
    };
}

function scene() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

/** A 10 × 10 × `depth` block on the XY plane, corner at the origin (feature "f1"). */
function block(doc: TestDocument, depth = 10, sketch = rect(0, 0, 10, 10)) {
    const sketchNode = new SketchNode({ document: doc, plane: Plane.XY, data: sketch });
    doc.modelManager.addNode(sketchNode);
    const body = new ParametricBodyNode({
        document: doc,
        features: [{ id: "f1", type: "extrude", sketchId: sketchNode.id, depth }],
    });
    doc.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    return body;
}

/** A primitive body (feature "p1") standing at the origin along +Z. */
function primitive(
    doc: TestDocument,
    kind: "cylinder" | "cone" | "sphere",
    extra: Record<string, number> = {},
) {
    const body = new ParametricBodyNode({
        document: doc,
        features: [
            { id: "p1", type: "primitive", primitive: kind, radius: 5, height: 10, ...extra } as FeatureData,
        ],
    });
    doc.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    return body;
}

const facesOf = (body: ParametricBodyNode) => body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
const edgesOf = (body: ParametricBodyNode) => body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];

function faceRef(body: ParametricBodyNode, match: (face: IFace) => boolean): FaceSourceRef {
    const index = facesOf(body).findIndex(match);
    expect(index).toBeGreaterThanOrEqual(0);
    return { nodeId: body.id, face: captureFaceSource(facesOf(body)[index], body.faceIdAt(index)) };
}

function curvedFace(body: ParametricBodyNode): FaceSourceRef {
    return faceRef(body, (face) => {
        const surface = face.surface();
        try {
            return !surface.isPlanar();
        } finally {
            surface.dispose();
        }
    });
}

function planarFace(body: ParametricBodyNode, normal: XYZ): IFace {
    const face = facesOf(body).find((candidate) => candidate.normal(0, 0)[1].dot(normal) > 0.99);
    expect(face).toBeDefined();
    return face!;
}

function edgeRef(body: ParametricBodyNode, match: (edge: IEdge) => boolean): EdgeSourceRef {
    const index = edgesOf(body).findIndex(match);
    expect(index).toBeGreaterThanOrEqual(0);
    const edgeId = body.edgeIdAt(index);
    return { nodeId: body.id, edge: captureEdgeRef(edgesOf(body)[index], edgeId) };
}

/** The upright block edge through (x, y). */
function verticalEdge(body: ParametricBodyNode, x: number, y: number): EdgeSourceRef {
    return edgeRef(body, (edge) => {
        const start = edge.startPoint();
        const end = edge.endPoint();
        return (
            Math.abs(start.x - x) < 1e-6 &&
            Math.abs(start.y - y) < 1e-6 &&
            Math.abs(end.x - x) < 1e-6 &&
            Math.abs(end.y - y) < 1e-6
        );
    });
}

/** The vertex at `at`, captured with its incident edges (the command's capture). */
function vertexRef(body: ParametricBodyNode, at: XYZ): PointRef {
    const vertex = (body.shape.value.findSubShapes(ShapeTypes.vertex) as IVertex[]).find((candidate) =>
        candidate.point().isEqualTo(at),
    );
    expect(vertex).toBeDefined();
    const incident = captureVertexAnchors(body.shape.value, vertex!, (index) => body.edgeIdAt(index));
    return { nodeId: body.id, vertex: captureVertexRef(vertex!), incident };
}

function axisNode(doc: TestDocument, definition: AxisDefinition) {
    const node = new AxisNode({ document: doc, definition });
    doc.modelManager.addNode(node);
    return node;
}

function pointNode(doc: TestDocument, definition: PointDefinition) {
    const node = new DatumPointNode({ document: doc, definition });
    doc.modelManager.addNode(node);
    return node;
}

function expectPoint(actual: XYZ | undefined, x: number, y: number, z: number) {
    expect(actual).toBeDefined();
    expect(actual!.x).toBeCloseTo(x, 5);
    expect(actual!.y).toBeCloseTo(y, 5);
    expect(actual!.z).toBeCloseTo(z, 5);
}

function expectParallel(actual: XYZ | undefined, expected: XYZ) {
    expect(actual).toBeDefined();
    expect(Math.abs(actual!.normalize()!.dot(expected))).toBeCloseTo(1, 6);
}

/** Distance of `point` from the axis line. */
function offAxis(axis: { point: XYZ; direction: XYZ }, point: XYZ): number {
    const relative = point.sub(axis.point);
    return relative.sub(axis.direction.multiply(relative.dot(axis.direction))).length();
}

describe("construction axes", () => {
    test("through a cylinder's face: the cylinder's axis, drawn across its height", () => {
        const doc = scene();
        const body = primitive(doc, "cylinder");
        const node = axisNode(doc, { kind: "faceAxis", face: curvedFace(body) });

        const axis = node.worldAxis()!;
        expectParallel(axis.direction, XYZ.unitZ);
        expect(offAxis(axis, XYZ.zero)).toBeCloseTo(0, 6);
        const zs = [axis.start.z, axis.end.z].sort((a, b) => a - b);
        expect(zs[0]).toBeLessThan(0);
        expect(zs[1]).toBeGreaterThan(10);
        expect(node.shape.isOk).toBe(true);
        expect(node.shape.value.shapeType).toBe(ShapeTypes.edge);
    });

    test("through a cone's face", () => {
        const doc = scene();
        const body = primitive(doc, "cone", { radius2: 2 });
        const axis = axisNode(doc, { kind: "faceAxis", face: curvedFace(body) }).worldAxis()!;
        expectParallel(axis.direction, XYZ.unitZ);
        expect(offAxis(axis, XYZ.zero)).toBeCloseTo(0, 6);
    });

    test("a face axis follows the body when it moves", () => {
        const doc = scene();
        const body = primitive(doc, "cylinder");
        const node = axisNode(doc, { kind: "faceAxis", face: curvedFace(body) });
        expect(offAxis(node.worldAxis()!, XYZ.zero)).toBeCloseTo(0, 6);

        body.transform = Matrix4.fromTranslation(7, 0, 0);
        expect(offAxis(node.worldAxis()!, new XYZ(7, 0, 0))).toBeCloseTo(0, 6);
    });

    test("along a straight edge, following an upstream depth edit", () => {
        const doc = scene();
        const body = block(doc);
        const node = axisNode(doc, { kind: "edge", edge: verticalEdge(body, 10, 0) });
        const axis = node.worldAxis()!;
        expectParallel(axis.direction, XYZ.unitZ);
        expect(offAxis(axis, new XYZ(10, 0, 0))).toBeCloseTo(0, 6);
        expect(Math.max(axis.start.z, axis.end.z)).toBeLessThan(13);

        body.setFeatureParameter("f1", "depth", 30);
        const grown = node.worldAxis()!;
        expect(offAxis(grown, new XYZ(10, 0, 0))).toBeCloseTo(0, 6);
        expect(Math.max(grown.start.z, grown.end.z)).toBeGreaterThan(30);
        expect(node.warningCount).toBe(0);
    });

    test("a circular edge gives the circle's axis", () => {
        const doc = scene();
        const body = primitive(doc, "cylinder");
        const circle = edgeRef(body, (edge) => CurveUtils.isCircle(edge.curve.basisCurve));
        const axis = axisNode(doc, { kind: "edge", edge: circle }).worldAxis()!;
        expectParallel(axis.direction, XYZ.unitZ);
        expect(offAxis(axis, XYZ.zero)).toBeCloseTo(0, 6);
    });

    test("through two points, and flip reverses it in place", () => {
        const doc = scene();
        const body = block(doc);
        const node = axisNode(doc, {
            kind: "twoPoints",
            points: [vertexRef(body, new XYZ(0, 0, 0)), vertexRef(body, new XYZ(10, 10, 10))],
        });
        const axis = node.worldAxis()!;
        expect(axis.direction.dot(new XYZ(1, 1, 1).normalize()!)).toBeCloseTo(1, 6);

        node.flip = true;
        const flipped = node.worldAxis()!;
        expect(flipped.direction.dot(new XYZ(1, 1, 1).normalize()!)).toBeCloseTo(-1, 6);
        expect(offAxis(flipped, XYZ.zero)).toBeCloseTo(0, 6);
    });

    test("where two datum planes meet", () => {
        const doc = scene();
        const axis = axisNode(doc, {
            kind: "twoPlanes",
            first: { kind: "datum", name: "XY" },
            second: { kind: "datum", name: "ZX" },
        }).worldAxis()!;
        expectParallel(axis.direction, XYZ.unitX);
        expect(offAxis(axis, XYZ.zero)).toBeCloseTo(0, 6);
    });

    test("where two body faces meet", () => {
        const doc = scene();
        const body = block(doc);
        const top = captureFaceRef(body.id, planarFace(body, XYZ.unitZ));
        const front = captureFaceRef(body.id, planarFace(body, XYZ.unitY.reverse()));
        const axis = axisNode(doc, {
            kind: "twoPlanes",
            first: { kind: "face", ref: top },
            second: { kind: "face", ref: front },
        }).worldAxis()!;
        expectParallel(axis.direction, XYZ.unitX);
        expect(offAxis(axis, new XYZ(0, 0, 10))).toBeCloseTo(0, 6);
        // Drawn across the block, not as a default segment around the world origin's foot.
        const xs = [axis.start.x, axis.end.x].sort((a, b) => a - b);
        expect(xs[0]).toBeLessThan(0);
        expect(xs[1]).toBeGreaterThan(10);
    });

    test("parallel planes have no axis, and the node says so", () => {
        const doc = scene();
        const node = axisNode(doc, {
            kind: "twoPlanes",
            first: { kind: "datum", name: "XY" },
            second: { kind: "datum", name: "XY" },
        });
        expect(node.worldAxis()).toBeUndefined();
        expect(node.warningCount).toBe(1);
    });

    test("perpendicular to a face at a point", () => {
        const doc = scene();
        const body = block(doc);
        const top = faceRef(body, (face) => face.normal(0, 0)[1].dot(XYZ.unitZ) > 0.99);
        const axis = axisNode(doc, {
            kind: "faceNormal",
            face: top,
            point: vertexRef(body, new XYZ(10, 10, 10)),
        }).worldAxis()!;
        expect(axis.direction.dot(XYZ.unitZ)).toBeCloseTo(1, 6);
        expectPoint(axis.point, 10, 10, 10);
    });

    test("perpendicular to a cylinder at a point on its rim", () => {
        const doc = scene();
        const body = primitive(doc, "cylinder");
        const rimPoint = vertexRef(
            body,
            (body.shape.value.findSubShapes(ShapeTypes.vertex) as IVertex[])[0].point(),
        );
        const axis = axisNode(doc, {
            kind: "faceNormal",
            face: curvedFace(body),
            point: rimPoint,
        }).worldAxis()!;
        // A cylinder's normal is radial: perpendicular to its axis, pointing away from it.
        expect(axis.direction.dot(XYZ.unitZ)).toBeCloseTo(0, 6);
        expect(new XYZ(axis.point.x, axis.point.y, 0).length()).toBeCloseTo(5, 5);
    });

    test("through a point, perpendicular to a plane", () => {
        const doc = scene();
        const body = block(doc);
        const axis = axisNode(doc, {
            kind: "pointPlane",
            point: vertexRef(body, new XYZ(10, 0, 10)),
            plane: { kind: "datum", name: "XY" },
        }).worldAxis()!;
        expectParallel(axis.direction, XYZ.unitZ);
        expect(offAxis(axis, new XYZ(10, 0, 0))).toBeCloseTo(0, 6);
        // The segment reaches from the point down to the plane.
        expect(Math.min(axis.start.z, axis.end.z)).toBeLessThan(0);
        expect(Math.max(axis.start.z, axis.end.z)).toBeGreaterThan(10);
    });

    test("a lost source keeps the last axis and shows the warning", () => {
        const doc = scene();
        const body = block(doc);
        const node = axisNode(doc, { kind: "edge", edge: verticalEdge(body, 10, 0) });
        const before = node.worldAxis()!;
        expect(node.warningCount).toBe(0);

        body.parent?.remove(body);
        node.flip = true; // any definition edit re-resolves
        expect(node.warningCount).toBe(1);
        expect(node.worldAxis()!.start.isEqualTo(before.start)).toBe(true);
        expect(node.shape.isOk).toBe(true);
    });

    test("serialized fields restore the definition and the last axis", () => {
        const doc = scene();
        const node = axisNode(doc, {
            kind: "twoPlanes",
            first: { kind: "datum", name: "XY" },
            second: { kind: "datum", name: "YZ" },
        });
        const axis = node.worldAxis()!;
        const restored = new AxisNode({
            document: doc,
            definitionJson: node.definitionJson,
            axisLine: node.axisLine,
        });
        expect(restored.definition.kind).toBe("twoPlanes");
        expect(restored.worldAxis()!.direction.isEqualTo(axis.direction)).toBe(true);
    });
});

describe("construction points", () => {
    test("at a vertex, following an upstream depth edit", () => {
        const doc = scene();
        const body = block(doc);
        const node = pointNode(doc, { kind: "vertex", point: vertexRef(body, new XYZ(10, 0, 10)) });
        expectPoint(node.worldPoint(), 10, 0, 10);
        expect(node.shape.value.shapeType).toBe(ShapeTypes.vertex);

        body.setFeatureParameter("f1", "depth", 25);
        expectPoint(node.worldPoint(), 10, 0, 25);
    });

    test("the centre of a circular edge follows the cylinder's height", () => {
        const doc = scene();
        const body = primitive(doc, "cylinder");
        const top = edgeRef(
            body,
            (edge) => CurveUtils.isCircle(edge.curve.basisCurve) && edge.startPoint().z > 5,
        );
        const node = pointNode(doc, { kind: "center", edge: top });
        expectPoint(node.worldPoint(), 0, 0, 10);

        body.setFeatureParameter("p1", "height", 20);
        expectPoint(node.worldPoint(), 0, 0, 20);
    });

    test("the centre of a sphere", () => {
        const doc = scene();
        const body = primitive(doc, "sphere");
        body.transform = Matrix4.fromTranslation(3, 4, 5);
        const node = pointNode(doc, { kind: "center", face: curvedFace(body) });
        expectPoint(node.worldPoint(), 3, 4, 5);
    });

    test("where a straight edge crosses a datum plane", () => {
        const doc = scene();
        const body = block(doc);
        const plane = new PlaneNode({
            document: doc,
            definition: { kind: "offset", source: { kind: "datum", name: "XY" }, distance: 4 },
        });
        doc.modelManager.addNode(plane);
        const node = pointNode(doc, {
            kind: "edgePlane",
            edge: verticalEdge(body, 10, 10),
            plane: { kind: "planeNode", nodeId: plane.id },
        });
        expectPoint(node.worldPoint(), 10, 10, 4);

        // The datum plane moves; the point rides along.
        plane.distance = 7;
        expectPoint(node.worldPoint(), 10, 10, 7);
    });

    test("where a circle crosses a plane, nearest the pick", () => {
        const doc = scene();
        const body = primitive(doc, "cylinder");
        const top = edgeRef(
            body,
            (edge) => CurveUtils.isCircle(edge.curve.basisCurve) && edge.startPoint().z > 5,
        );
        const node = pointNode(doc, {
            kind: "edgePlane",
            edge: top,
            plane: { kind: "datum", name: "ZX" },
            anchor: { x: -4, y: 0, z: 10 },
        });
        expectPoint(node.worldPoint(), -5, 0, 10);
    });

    test("where three body faces meet", () => {
        const doc = scene();
        const body = block(doc);
        const face = (normal: XYZ) => ({
            kind: "face" as const,
            ref: captureFaceRef(body.id, planarFace(body, normal)),
        });
        const node = pointNode(doc, {
            kind: "threePlanes",
            planes: [face(XYZ.unitZ), face(XYZ.unitX), face(XYZ.unitY)],
        });
        expectPoint(node.worldPoint(), 10, 10, 10);
    });

    test("along an edge at a ratio of its length", () => {
        const doc = scene();
        const body = block(doc);
        const edge = verticalEdge(body, 0, 0);
        const start = new XYZ(edge.edge.kind === "line" ? edge.edge.start : { x: 0, y: 0, z: 0 });
        const node = pointNode(doc, { kind: "onEdge", edge, ratio: 0.25, start });
        const expectedZ = start.z < 5 ? 2.5 : 7.5;
        expectPoint(node.worldPoint(), 0, 0, expectedZ);

        node.ratio = 0.5;
        expectPoint(node.worldPoint(), 0, 0, 5);
    });
});

describe("tangent plane", () => {
    function tangent(angle: number) {
        const doc = scene();
        const body = primitive(doc, "cylinder");
        const plane = new PlaneNode({
            document: doc,
            definition: { kind: "tangent", face: curvedFace(body), at: { x: 5, y: 0, z: 5 }, angle },
        });
        doc.modelManager.addNode(plane);
        return { doc, body, plane };
    }

    test("touches the cylinder where it was picked, facing away from the axis", () => {
        const { plane } = tangent(0);
        const world = plane.worldPlane()!;
        expect(world.normal.dot(XYZ.unitX)).toBeCloseTo(1, 6);
        expect(world.normal.dot(world.origin.sub(new XYZ(5, 0, 0)))).toBeCloseTo(0, 5);
    });

    test("the angle rolls the plane around the axis", () => {
        const { plane } = tangent(90);
        const world = plane.worldPlane()!;
        expect(world.normal.dot(XYZ.unitY)).toBeCloseTo(1, 6);
        expect(world.normal.dot(world.origin.sub(new XYZ(0, 5, 0)))).toBeCloseTo(0, 5);
    });

    test("follows a radius edit", () => {
        const { body, plane } = tangent(0);
        body.setFeatureParameter("p1", "radius", 8);
        const world = plane.worldPlane()!;
        expect(world.normal.dot(world.origin.sub(new XYZ(8, 0, 0)))).toBeCloseTo(0, 5);
    });
});

describe("datums as references", () => {
    test("a three-point plane on datum points", () => {
        const doc = scene();
        // Three datum points, each where three datum planes meet; they share the z plane.
        const offsetPlane = (name: "XY" | "YZ" | "ZX", distance: number) => {
            const plane = new PlaneNode({
                document: doc,
                definition: { kind: "offset", source: { kind: "datum", name }, distance },
            });
            doc.modelManager.addNode(plane);
            return { kind: "planeNode" as const, nodeId: plane.id };
        };
        const z5 = offsetPlane("XY", 5);
        const p1 = pointNode(doc, {
            kind: "threePlanes",
            planes: [offsetPlane("YZ", 0), offsetPlane("ZX", 0), z5],
        });
        const p2 = pointNode(doc, {
            kind: "threePlanes",
            planes: [offsetPlane("YZ", 10), offsetPlane("ZX", 0), z5],
        });
        const p3 = pointNode(doc, {
            kind: "threePlanes",
            planes: [offsetPlane("YZ", 0), offsetPlane("ZX", 10), z5],
        });
        const ref = (node: DatumPointNode): PointRef => ({
            nodeId: node.id,
            vertex: captureVertexRef(node.shape.value as IVertex),
        });
        const plane = new PlaneNode({
            document: doc,
            definition: { kind: "threePoint", points: [ref(p1), ref(p2), ref(p3)] },
        });
        doc.modelManager.addNode(plane);
        const world = plane.worldPlane()!;
        expectParallel(world.normal, XYZ.unitZ);
        expect(world.origin.z).toBeCloseTo(5, 6);

        // Moving the datum points' shared plane carries the three-point plane with it.
        (doc.modelManager.findNode((n) => n.id === z5.nodeId) as PlaneNode).distance = 8;
        expect(plane.worldPlane()!.origin.z).toBeCloseTo(8, 6);
    });

    test("a line-angle plane through a datum axis", () => {
        const doc = scene();
        const axis = axisNode(doc, {
            kind: "twoPlanes",
            first: { kind: "datum", name: "XY" },
            second: { kind: "datum", name: "ZX" },
        });
        const axisEdge = axis.shape.value as IEdge;
        const plane = new PlaneNode({
            document: doc,
            definition: {
                kind: "lineAngle",
                line: { nodeId: axis.id, edge: captureEdgeRef(axisEdge) },
                reference: { kind: "datum", name: "XY" },
                angle: 90,
            },
        });
        doc.modelManager.addNode(plane);
        const world = plane.worldPlane()!;
        // Rotated 90° about the X axis from the XY plane's normal: the plane contains X.
        expect(world.normal.dot(XYZ.unitX)).toBeCloseTo(0, 6);
        expect(Math.abs(world.normal.dot(XYZ.unitY))).toBeCloseTo(1, 6);
    });

    test("a datum point referencing itself through another datum is refused, not recursed", () => {
        const doc = scene();
        const origin = { point: { x: 0, y: 0, z: 0 } };
        const first = pointNode(doc, {
            kind: "threePlanes",
            planes: [
                { kind: "datum", name: "XY" },
                { kind: "datum", name: "YZ" },
                { kind: "datum", name: "ZX" },
            ],
        });
        const second = pointNode(doc, { kind: "vertex", point: { nodeId: first.id, vertex: origin } });
        expectPoint(second.worldPoint(), 0, 0, 0);
        first.definitionJson = JSON.stringify({
            kind: "vertex",
            point: { nodeId: second.id, vertex: origin },
        });
        // Both keep their last value; neither overflows the stack.
        expectPoint(first.worldPoint(), 0, 0, 0);
        expectPoint(second.worldPoint(), 0, 0, 0);
    });

    test("a revolve about a datum axis follows the axis", () => {
        const doc = scene();
        const offset = new PlaneNode({
            document: doc,
            definition: { kind: "offset", source: { kind: "datum", name: "YZ" }, distance: 0 },
        });
        doc.modelManager.addNode(offset);
        // The axis runs along +Y where the offset YZ plane meets XY.
        const axis = axisNode(doc, {
            kind: "twoPlanes",
            first: { kind: "planeNode", nodeId: offset.id },
            second: { kind: "datum", name: "XY" },
        });
        const value = axis.worldAxis()!;
        expectParallel(value.direction, XYZ.unitY);

        const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: rect(5, 0, 10, 5) });
        doc.modelManager.addNode(sketch);
        const body = new ParametricBodyNode({
            document: doc,
            features: [
                {
                    id: "r1",
                    type: "revolve",
                    sketchId: sketch.id,
                    angle: 360,
                    axis: {
                        point: { x: value.point.x, y: value.point.y, z: value.point.z },
                        direction: { x: value.direction.x, y: value.direction.y, z: value.direction.z },
                    },
                    axisSource: { nodeId: axis.id, edge: captureEdgeRef(axis.shape.value as IEdge) },
                },
            ],
        });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.boundingBox().min.x).toBeCloseTo(-10, 1);

        // Moving the axis to x = 2 (ring radii 3..8 about it) moves the revolve.
        offset.distance = 2;
        expect(axis.worldAxis()!.point.x).toBeCloseTo(2, 6);
        const box = body.shape.value.boundingBox();
        expect(box.min.x).toBeCloseTo(-6, 1);
        expect(box.max.x).toBeCloseTo(10, 1);
    });

    test("a circular pattern about a datum axis", () => {
        const doc = scene();
        const offset = new PlaneNode({
            document: doc,
            definition: { kind: "offset", source: { kind: "datum", name: "YZ" }, distance: 0 },
        });
        doc.modelManager.addNode(offset);
        // The world Z axis (moved along X with the offset plane).
        const axis = axisNode(doc, {
            kind: "twoPlanes",
            first: { kind: "planeNode", nodeId: offset.id },
            second: { kind: "datum", name: "ZX" },
        });
        const body = block(doc, 10, rect(10, -10, 30, 10));
        body.setFeaturesEmitShapeChanged([
            ...body.features,
            {
                id: "pt1",
                type: "pattern",
                mode: "circular",
                count: 2,
                axis: { nodeId: axis.id, edge: captureEdgeRef(axis.shape.value as IEdge) },
            } as FeatureData,
        ]);
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
        expect(body.shape.value.boundingBox().min.x).toBeCloseTo(-30, 1);

        // Half a turn about x = 5: the copy lands at x ∈ [-20, 0].
        offset.distance = 5;
        expect(body.shape.value.boundingBox().min.x).toBeCloseTo(-20, 1);
    });
});
