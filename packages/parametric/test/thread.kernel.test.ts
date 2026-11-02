// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommandStore, type IFace, type IShape, Matrix4, ShapeTypes, XYZ } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { rs } from "@rstest/core";
import { ThreadFeatureCommand } from "../src/commands/threadCommand";
import type { FeatureData, PrimitiveFeatureData, ThreadFeatureData } from "../src/features/feature";
import { featureHandler } from "../src/features/feature";
import { captureProfileRef } from "../src/features/profileRef";
import { cylinderOfFace } from "../src/features/threadGeometry";
import { threadRow } from "../src/features/threadStandards";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import "../src/features/thread";

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

const shapeOf = (body: ParametricBodyNode): IShape => body.shape.unchecked()!;
const facesOf = (body: ParametricBodyNode) => shapeOf(body).findSubShapes(ShapeTypes.face) as IFace[];
const errors = (body: ParametricBodyNode) => body.featureItems().map((x) => x.error);
const solidsOf = (shape: IShape) => shape.findSubShapes(ShapeTypes.solid).length;

/** The body's cylindrical face of radius `radius`, with its tracked id. */
function cylinderFace(body: ParametricBodyNode, radius: number): { face: IFace; id: string | undefined } {
    const faces = facesOf(body);
    const index = faces.findIndex((face) => {
        const frame = cylinderOfFace(face);
        return frame.isOk && Math.abs(frame.value.radius - radius) < 1e-6;
    });
    expect(index).toBeGreaterThanOrEqual(0);
    return { face: faces[index], id: body.faceIdAt(index) };
}

function body(features: FeatureData[]): ParametricBodyNode {
    const doc = new TestDocument({ application: createMockApplication() });
    const node = new ParametricBodyNode({ document: doc, features });
    doc.modelManager.addNode(node);
    return node;
}

/** A Ø`2r` rod, `height` long, standing on the origin along +z. */
const rod = (r: number, height: number): PrimitiveFeatureData => ({
    id: "rod",
    type: "primitive",
    primitive: "cylinder",
    radius: r,
    height,
});

/** A 20 × 20 × 15 block with a Ø`2r` bore straight through it along z. */
function block(r: number): FeatureData[] {
    return [
        {
            id: "block",
            type: "primitive",
            primitive: "box",
            origin: { x: -10, y: -10, z: 0 },
            dx: 20,
            dy: 20,
            dz: 15,
        },
        {
            id: "bore",
            type: "primitive",
            primitive: "cylinder",
            origin: { x: 0, y: 0, z: -1 },
            radius: r,
            height: 17,
            operation: "cut",
        },
    ];
}

/** Appends a thread of preset `size` on the body's face of radius `radius`. */
function threaded(
    node: ParametricBodyNode,
    radius: number,
    size: string,
    patch: Partial<ThreadFeatureData> = {},
): ParametricBodyNode {
    const row = threadRow(size)!;
    const { face, id } = cylinderFace(node, radius);
    node.setFeaturesEmitShapeChanged([
        ...node.features,
        {
            id: "t1",
            type: "thread",
            face: captureProfileRef(face, id, node.faceIdIsShared(id)),
            size,
            form: row.form,
            diameter: row.diameter,
            pitch: row.pitch,
            modeled: true,
            ...patch,
        } satisfies ThreadFeatureData,
    ]);
    return node;
}

/**
 * The groove's cross-section area inside the material and the radius its centroid runs at, from
 * the basic profile: material removed per turn ≈ area · 2π · centroid radius (Pappus).
 */
function expectedPerTurn(form: "iso" | "whitworth", pitch: number, faceR: number, internal: boolean): number {
    const half = ((form === "whitworth" ? 55 : 60) / 2) * (Math.PI / 180);
    const sharp = pitch / (2 * Math.tan(half));
    const depth = form === "whitworth" ? (2 * sharp) / 3 : (5 * sharp) / 8;
    const flat = form === "whitworth" ? pitch / 6 : internal ? pitch / 8 : pitch / 4;
    // The modelled faces here sit exactly on the basic major (external) / minor (internal) radius.
    const wide = flat + 2 * depth * Math.tan(half);
    const area = ((flat + wide) / 2) * depth;
    const centroid = internal ? faceR + depth / 2 : faceR - depth / 2;
    return area * 2 * Math.PI * centroid;
}

describe("thread feature (real kernel)", () => {
    test("an external M8 on a Ø8 rod cuts a full-depth helical groove and stays one valid solid", () => {
        const node = body([rod(4, 20)]);
        const before = shapeOf(node).volume();
        threaded(node, 4, "M8");
        expect(errors(node)).toEqual([undefined, undefined]);
        const shape = shapeOf(node);
        expect(shape.checkShape()).toBe(true);
        expect(solidsOf(shape)).toBe(1);

        // The groove runs the face minus half a section at each end; the turn count is the
        // helix's rise over the pitch (see `helixRange`).
        const removed = before - shape.volume();
        const pitch = 1.25;
        const halfWidth = (0.94 * pitch) / 2;
        const turns = (20 - 2 * (halfWidth + 0.02 * pitch)) / pitch;
        const expected = turns * expectedPerTurn("iso", pitch, 4, false);
        expect(removed).toBeGreaterThan(0.9 * expected);
        expect(removed).toBeLessThan(1.1 * expected);

        // Nothing is left outside the rod, and the deepest point is the minor diameter.
        const box = shape.boundingBox();
        expect(box.max.z).toBeCloseTo(20, 6);
        expect(box.min.z).toBeCloseTo(0, 6);
        expect(Math.max(box.max.x, box.max.y)).toBeLessThanOrEqual(4 + 1e-6);
    });

    test("an internal M8 in a Ø6.75 bore cuts outward into the wall and stays one valid solid", () => {
        const node = body(block(3.375));
        const before = shapeOf(node).volume();
        threaded(node, 3.375, "M8");
        expect(errors(node)).toEqual([undefined, undefined, undefined]);
        const shape = shapeOf(node);
        expect(shape.checkShape()).toBe(true);
        expect(solidsOf(shape)).toBe(1);
        const removed = before - shape.volume();
        // Bore at the tap drill (D − P), not at the basic minor diameter: the groove only reaches
        // from 3.375 out to the major radius 4, a little less than the basic profile's depth.
        const pitch = 1.25;
        const turns = (15 - 2 * ((0.94 * pitch) / 2 + 0.02 * pitch)) / pitch;
        const tan = Math.tan(Math.PI / 6);
        const inner = 0.625; // 4 − 3.375
        const wideAtBore = pitch / 8 + 2 * inner * tan;
        const area = ((pitch / 8 + wideAtBore) / 2) * inner;
        const expected = turns * area * 2 * Math.PI * (3.375 + inner / 2);
        expect(removed).toBeGreaterThan(0.9 * expected);
        expect(removed).toBeLessThan(1.1 * expected);
        // The block's outside is untouched.
        const box = shape.boundingBox();
        expect(box.max.x).toBeCloseTo(10, 6);
        expect(box.min.z).toBeCloseTo(0, 6);
    });

    test("a G1/4 BSP thread (55°) on its Ø13.157 rod", () => {
        const node = body([rod(13.157 / 2, 12)]);
        const before = shapeOf(node).volume();
        threaded(node, 13.157 / 2, "G1/4");
        expect(errors(node)).toEqual([undefined, undefined]);
        const shape = shapeOf(node);
        expect(shape.checkShape()).toBe(true);
        expect(solidsOf(shape)).toBe(1);
        const pitch = threadRow("G1/4")!.pitch;
        const turns = (12 - 2 * ((0.94 * pitch) / 2 + 0.02 * pitch)) / pitch;
        const expected = turns * expectedPerTurn("whitworth", pitch, 13.157 / 2, false);
        const removed = before - shape.volume();
        expect(removed).toBeGreaterThan(0.9 * expected);
        expect(removed).toBeLessThan(1.1 * expected);
    });

    test("a given length and offset confine the groove to that span, from either end", () => {
        const full = threaded(body([rod(4, 30)]), 4, "M8");
        const span = threaded(body([rod(4, 30)]), 4, "M8", { length: 10, offset: 5 });
        const flipped = threaded(body([rod(4, 30)]), 4, "M8", { length: 10, offset: 5, flip: true });
        expect(errors(span)).toEqual([undefined, undefined]);
        expect(errors(flipped)).toEqual([undefined, undefined]);
        const solid = Math.PI * 16 * 30;
        const removedFull = solid - shapeOf(full).volume();
        const removedSpan = solid - shapeOf(span).volume();
        const removedFlipped = solid - shapeOf(flipped).volume();
        expect(removedSpan).toBeLessThan(0.4 * removedFull);
        expect(removedFlipped).toBeCloseTo(removedSpan, 1);

        // A slice at z = 2 (inside the offset) is the full round rod; at z = 10 it is grooved.
        // Measured by the rod's section: the threaded one has less material at z = 10.
        const isFullAt = (node: ParametricBodyNode, z: number) =>
            shapeOf(node).containsPoint(new XYZ(3.9, 0, z), true) &&
            shapeOf(node).containsPoint(new XYZ(0, 3.9, z), true) &&
            shapeOf(node).containsPoint(new XYZ(-3.9, 0, z), true) &&
            shapeOf(node).containsPoint(new XYZ(0, -3.9, z), true);
        expect(isFullAt(span, 2)).toBe(true);
        expect(isFullAt(span, 27)).toBe(true);
        expect(isFullAt(flipped, 2)).toBe(true);
        expect(isFullAt(flipped, 27)).toBe(true);
    });

    test("clearance cuts an external thread deeper", () => {
        const plain = threaded(body([rod(4, 20)]), 4, "M8");
        const loose = threaded(body([rod(4, 20)]), 4, "M8", { clearance: 0.2 });
        expect(errors(loose)).toEqual([undefined, undefined]);
        expect(shapeOf(loose).volume()).toBeLessThan(shapeOf(plain).volume() - 1);
    });

    test("a cosmetic thread leaves the body and its ids exactly as they were", () => {
        const node = body([rod(4, 20)]);
        const before = shapeOf(node).volume();
        const idsBefore = facesOf(node).map((_, i) => node.faceIdAt(i));
        threaded(node, 4, "M8", { modeled: false });
        expect(errors(node)).toEqual([undefined, undefined]);
        expect(shapeOf(node).volume()).toBeCloseTo(before, 9);
        expect(facesOf(node).map((_, i) => node.faceIdAt(i))).toEqual(idsBefore);
        expect(featureHandler("thread")!.display).toBeInstanceOf(Function);
    });

    test("switching a cosmetic thread to modelled cuts it, and back again restores the rod", () => {
        const node = threaded(body([rod(4, 20)]), 4, "M8", { modeled: false });
        const handler = featureHandler("thread")!;
        const setModeled = (value: boolean) =>
            node.setFeaturesEmitShapeChanged(
                node.features.map((f) =>
                    f.type === "thread" ? handler.setParameter(f, "modeled", value) : f,
                ),
            );
        const solid = Math.PI * 16 * 20;
        setModeled(true);
        expect(shapeOf(node).volume()).toBeLessThan(solid - 50);
        setModeled(false);
        expect(shapeOf(node).volume()).toBeCloseTo(solid, 6);
    });

    test("the thread follows the rod when an upstream edit makes it longer", () => {
        const node = threaded(body([rod(4, 20)]), 4, "M8");
        const shorter = shapeOf(node).volume();
        node.setFeaturesEmitShapeChanged(
            node.features.map((f) => (f.type === "primitive" ? { ...f, height: 30 } : f)),
        );
        expect(errors(node)).toEqual([undefined, undefined]);
        // 10 mm more rod, 8 more turns of groove: more material and more removed.
        const removed = Math.PI * 16 * 30 - shapeOf(node).volume();
        expect(removed).toBeGreaterThan(Math.PI * 16 * 20 - shorter + 50);
        expect(shapeOf(node).checkShape()).toBe(true);
    });

    test.each([
        ["a size far too big for the rod", "M20", {}, "too small"],
        ["a size far too small for the rod", "M3", {}, "too large"],
        ["an offset past the end of the face", "M8", { offset: 25 }, "does not fit"],
        ["a length longer than the face", "M8", { length: 30 }, "does not fit"],
        ["a span shorter than one section", "M8", { length: 1 }, "too short"],
        ["a pitch larger than the radius", "M8", { pitch: 5 }, "pitch is too large"],
        ["a clearance beyond 0.3 pitch", "M8", { clearance: 1 }, "clearance"],
    ] as const)("refuses %s before any kernel call", (_name, size, patch, message) => {
        const node = threaded(body([rod(4, 20)]), 4, size, patch);
        expect(errors(node)[1]).toContain(message);
        // The failed feature leaves the rod as it was.
        expect(shapeOf(node).volume()).toBeCloseTo(Math.PI * 16 * 20, 6);
    });

    test("refuses a face that is not a cylinder", () => {
        const node = body([rod(4, 20)]);
        const planar = facesOf(node).find((face) => !cylinderOfFace(face).isOk)!;
        node.setFeaturesEmitShapeChanged([
            ...node.features,
            {
                id: "t1",
                type: "thread",
                face: captureProfileRef(planar),
                size: "M8",
                form: "iso",
                diameter: 8,
                pitch: 1.25,
                modeled: true,
            } satisfies ThreadFeatureData,
        ]);
        expect(errors(node)[1]).toContain("cylindrical face");
    });

    test("the rod's own faces keep their ids through the cut, and the groove's faces get names", () => {
        const node = body([rod(4, 20)]);
        const idsBefore = facesOf(node).map((_, i) => node.faceIdAt(i));
        threaded(node, 4, "M8");
        const idsAfter = facesOf(node).map((_, i) => node.faceIdAt(i));
        for (const id of idsBefore) expect(idsAfter.some((x) => x?.includes(id!))).toBe(true);
        expect(idsAfter.filter((id) => id?.startsWith("thread:t1:flank")).length).toBeGreaterThan(10);
    });

    test("tells a shaft from a bore by the face's orientation", () => {
        const shaft = cylinderOfFace(cylinderFace(body([rod(4, 20)]), 4).face);
        const bore = cylinderOfFace(cylinderFace(body(block(3.4)), 3.4).face);
        expect(shaft.isOk && !shaft.value.internal).toBe(true);
        expect(bore.isOk && bore.value.internal).toBe(true);
        expect(shaft.isOk && shaft.value.end - shaft.value.start).toBeCloseTo(20, 6);
        expect(bore.isOk && bore.value.end - bore.value.start).toBeCloseTo(15, 6);
    });
});

describe("ThreadFeatureCommand (real kernel)", () => {
    /** A command running against `node`'s document with the face of radius `radius` picked. */
    function commandOn(node: ParametricBodyNode, radius: number) {
        const doc = node.document as TestDocument;
        const app = doc.application as any;
        app.activeView = { document: doc };
        const displayMesh = rs.fn((_meshes: unknown[], _options?: unknown) => 7);
        doc.visual = createMockVisualWithDocument(doc, { context: { displayMesh } as any });
        const faces = facesOf(node);
        const { face } = cylinderFace(node, radius);
        const index = faces.findIndex((x) => x.isSame(face));
        const picked = { shape: face, owner: { node }, transform: Matrix4.identity(), indexes: [index] };
        doc.selection = {
            getSelectedShapes: () => [picked],
            onShapeChanged: { sub: rs.fn(), remove: rs.fn() },
        } as any;
        const cmd = new ThreadFeatureCommand() as any;
        cmd._application = app;
        return { cmd, displayMesh, picked };
    }

    test("is registered under the key the ribbon names", () => {
        expect(CommandStore.getCommand("feature.thread")).toBe(ThreadFeatureCommand);
    });

    test.each([
        ["a Ø8 rod", "M8", 1.25, [rod(4, 20)], 4],
        ["a Ø6.8 bore", "M8", 1.25, block(3.4), 3.4],
        ["a Ø13.16 rod", "G1/4", 1.337, [rod(6.58, 12)], 6.58],
        ["a Ø20 rod", "M20", 2.5, [rod(10, 30)], 10],
    ])("picking %s suggests %s and previews it", (_name, size, pitch, features, radius) => {
        const node = body(features as FeatureData[]);
        const { cmd, displayMesh } = commandOn(node, radius as number);
        cmd.updatePreview();
        expect(cmd.size).toBe(size);
        expect(cmd.pitch).toBe(pitch);
        expect(displayMesh).toHaveBeenCalledTimes(1);
    });

    test("a size the user picks after the suggestion is kept by later previews", () => {
        const node = body([rod(4, 20)]);
        const { cmd } = commandOn(node, 4);
        cmd.updatePreview();
        cmd.size = "M8×1";
        cmd.updatePreview();
        expect(cmd.size).toBe("M8×1");
        expect(cmd.pitch).toBe(1);
    });

    test("confirming appends one thread feature on the picked face", () => {
        const node = body([rod(4, 20)]);
        const { cmd, picked } = commandOn(node, 4);
        cmd.updatePreview();
        cmd.stepDatas = [{ shapes: [picked], nodes: [node] }];
        cmd.executeMainTask();
        const thread = node.features.at(-1) as ThreadFeatureData;
        expect(thread.type).toBe("thread");
        expect(thread).toMatchObject({ size: "M8", form: "iso", diameter: 8, pitch: 1.25, modeled: true });
        expect(errors(node)).toEqual([undefined, undefined]);
        expect(shapeOf(node).volume()).toBeLessThan(Math.PI * 16 * 20 - 50);
    });
});
