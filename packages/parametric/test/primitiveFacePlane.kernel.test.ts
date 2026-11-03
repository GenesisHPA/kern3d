// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IFace, type IView, Matrix4, Plane, ShapeTypes, type SnapResult, XYZ } from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { facePlaneOfPick } from "../src/commands/primitiveCommand";
import { primitiveFrameXvec } from "../src/features/primitive";

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

function pickOn(face: IFace, point: XYZ, transform = Matrix4.identity()): SnapResult {
    return {
        view: {} as IView,
        type: "onSurface",
        point,
        shapes: [{ shape: face, transform, point, owner: {} as never, indexes: [] } as never],
    };
}

function faceCenter(face: IFace): XYZ {
    const box = face.boundingBox();
    return new XYZ({
        x: (box.min.x + box.max.x) / 2,
        y: (box.min.y + box.max.y) / 2,
        z: (box.min.z + box.max.z) / 2,
    });
}

describe("facePlaneOfPick", () => {
    test("a slanted face gives its own plane, normal pointing out of the body", () => {
        // a box laid on a 45° tilted plane: its top face is slanted like a chamfer
        const normal = new XYZ({ x: 0, y: -1, z: 1 }).normalize()!;
        const plane = new Plane({ origin: XYZ.zero, normal, xvec: XYZ.unitX });
        const box = shapeFactory.box(plane, 40, 20, 10).value;
        const faces = box.findSubShapes(ShapeTypes.face) as IFace[];
        const top = faces.find((face) => face.normal(0, 0)[1].isEqualTo(normal))!;
        expect(top).toBeDefined();

        const point = faceCenter(top);
        const result = facePlaneOfPick(pickOn(top, point))!;
        expect(result.normal.isEqualTo(normal)).toBe(true);
        expect(result.origin.isEqualTo(point)).toBe(true);
        expect(result.xvec.isEqualTo(primitiveFrameXvec(normal))).toBe(true);
    });

    test("every face of a box points outward", () => {
        const box = shapeFactory.box(Plane.XY, 40, 20, 10).value;
        const center = new XYZ({ x: 20, y: 10, z: 5 });
        for (const face of box.findSubShapes(ShapeTypes.face) as IFace[]) {
            const point = faceCenter(face);
            const result = facePlaneOfPick(pickOn(face, point))!;
            expect(result.normal.dot(point.sub(center))).toBeGreaterThan(0);
        }
    });

    test("a moved body's face is placed where the body is", () => {
        const box = shapeFactory.box(Plane.XY, 40, 20, 10).value;
        const faces = box.findSubShapes(ShapeTypes.face) as IFace[];
        const top = faces.find((face) => face.normal(0, 0)[1].isEqualTo(XYZ.unitZ))!;
        const rotate = Matrix4.fromAxisRad(XYZ.zero, XYZ.unitX, Math.PI / 2);
        const result = facePlaneOfPick(pickOn(top, XYZ.zero, rotate))!;
        expect(result.normal.isEqualTo(new XYZ({ x: 0, y: -1, z: 0 }))).toBe(true);
    });

    test("no face, no plane: the old workplane behaviour stays", () => {
        expect(facePlaneOfPick({ view: {} as IView, type: "onSurface", point: XYZ.zero, shapes: [] })).toBe(
            undefined,
        );
    });
});
