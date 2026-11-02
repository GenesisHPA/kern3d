// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IFace, type IView, Plane, ShapeTypes, XY, XYZ } from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { faceSketchFrame } from "../src/sketch/commands/faceFrame";
import { applyLocalFrame, localFrameOf, sketchPlaneOfFace } from "../src/sketch/planeRef";

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

/** Top face (+Z) of a 100 × 60 × 20 box laid out on `plane`. */
function topFace(plane: Plane): IFace {
    const box = shapeFactory.box(plane, 100, 60, 20).value;
    const faces = box.findSubShapes(ShapeTypes.face) as IFace[];
    const top = faces.find((face) => face.normal(0, 0)[1].isEqualTo(plane.normal));
    expect(top).toBeDefined();
    return top!;
}

/** A top-down view at 1 px per mm: the snap radius is then 12 mm. */
const topView = { worldToScreen: (p: XYZ) => new XY({ x: p.x, y: -p.y }) } as unknown as IView;

const ALL = { originAtPick: true, axesAlongEdge: true };

describe("faceSketchFrame", () => {
    test("puts the origin at the picked point when nothing is near enough to snap", () => {
        const face = topFace(Plane.XY);
        const base = sketchPlaneOfFace(face);
        const frame = faceSketchFrame(face, base, new XYZ({ x: 50, y: 30, z: 20 }), topView, {
            originAtPick: true,
            axesAlongEdge: false,
        });
        expect(frame.origin.isEqualTo(new XYZ({ x: 50, y: 30, z: 20 }))).toBe(true);
        expect(frame.xvec.isEqualTo(base.xvec)).toBe(true);
    });

    test("snaps the origin onto a nearby corner", () => {
        const face = topFace(Plane.XY);
        const frame = faceSketchFrame(
            face,
            sketchPlaneOfFace(face),
            new XYZ({ x: 3, y: 4, z: 20 }),
            topView,
            ALL,
        );
        expect(frame.origin.isEqualTo(new XYZ({ x: 0, y: 0, z: 20 }))).toBe(true);
    });

    test("snaps the origin onto an edge midpoint", () => {
        const face = topFace(Plane.XY);
        const frame = faceSketchFrame(
            face,
            sketchPlaneOfFace(face),
            new XYZ({ x: 52, y: 2, z: 20 }),
            topView,
            ALL,
        );
        expect(frame.origin.isEqualTo(new XYZ({ x: 50, y: 0, z: 20 }))).toBe(true);
    });

    test("turns the axes onto the nearest straight edge of a rotated face", () => {
        const angle = (30 * Math.PI) / 180;
        const xvec = new XYZ({ x: Math.cos(angle), y: Math.sin(angle), z: 0 });
        const face = topFace(new Plane({ origin: XYZ.zero, normal: XYZ.unitZ, xvec }));
        const base = sketchPlaneOfFace(face);
        // a point well inside, nearest the box's first long edge
        const pick = xvec
            .multiply(50)
            .add(new XYZ({ x: -Math.sin(angle), y: Math.cos(angle), z: 0 }).multiply(15));
        const frame = faceSketchFrame(face, base, pick.add(new XYZ({ x: 0, y: 0, z: 20 })), topView, {
            originAtPick: false,
            axesAlongEdge: true,
        });
        expect(Math.abs(frame.xvec.dot(xvec))).toBeCloseTo(1, 9);
        expect(frame.origin.isEqualTo(base.origin)).toBe(true);
    });

    test("gives the base frame back with both options off", () => {
        const face = topFace(Plane.XY);
        const base = sketchPlaneOfFace(face);
        const frame = faceSketchFrame(face, base, new XYZ({ x: 3, y: 4, z: 20 }), topView, {
            originAtPick: false,
            axesAlongEdge: false,
        });
        expect(frame).toBe(base);
    });
});

describe("local frame", () => {
    test("round-trips a shifted, turned frame through its base", () => {
        const base = new Plane({ origin: new XYZ({ x: 0, y: 0, z: 5 }), normal: XYZ.unitZ, xvec: XYZ.unitX });
        const plane = new Plane({
            origin: new XYZ({ x: 12, y: -7, z: 5 }),
            normal: XYZ.unitZ,
            xvec: new XYZ({ x: 1, y: 1, z: 0 }),
        });
        const back = applyLocalFrame(base, localFrameOf(base, plane));
        expect(back.origin.isEqualTo(plane.origin)).toBe(true);
        expect(back.xvec.isEqualTo(plane.xvec)).toBe(true);
    });

    test("follows the base when it moves along its normal", () => {
        const local = { u: 10, v: 20, angle: Math.PI / 4 };
        const lifted = applyLocalFrame(Plane.XY.offsetAlongNormal(30), local);
        expect(lifted.origin.isEqualTo(new XYZ({ x: 10, y: 20, z: 30 }))).toBe(true);
    });
});
