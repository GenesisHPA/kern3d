// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { type IEdge, type IFace, Plane, ShapeTypes, XYZ } from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { beforeAll, describe, expect, test } from "@rstest/core";
import { edgeReadout, faceReadout } from "../src/hoverMeasure";

let factory: ShapeFactory;
beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(path.resolve(import.meta.dirname, "../../wasm/lib/chili-wasm.wasm")),
    });
    factory = new ShapeFactory();
});

describe("hover readouts on real shapes", () => {
    test("a box edge reads its length", () => {
        const box = factory.box(Plane.XY, 40, 20, 10).value;
        const lengths = (box.findSubShapes(ShapeTypes.edge) as IEdge[]).map(edgeReadout);
        expect(new Set(lengths)).toEqual(new Set(["40", "20", "10"]));
    });

    test("a cylinder's circular edge reads its diameter, its side face too", () => {
        const cylinder = factory.cylinder(XYZ.unitZ, XYZ.zero, 6, 15).value;
        const readouts = (cylinder.findSubShapes(ShapeTypes.edge) as IEdge[]).map(edgeReadout);
        expect(readouts).toContain("Ø12");
        expect(readouts).toContain("15");
        const faces = (cylinder.findSubShapes(ShapeTypes.face) as IFace[]).map(faceReadout);
        expect(faces.filter((x) => x !== undefined)).toEqual(["Ø12"]);
    });

    test("an arc reads its radius and length", () => {
        const arc = factory.arc(XYZ.unitZ, XYZ.zero, new XYZ({ x: 5, y: 0, z: 0 }), 90)
            .value as unknown as IEdge;
        expect(edgeReadout(arc)).toBe("R5 · 7.85");
    });
});
