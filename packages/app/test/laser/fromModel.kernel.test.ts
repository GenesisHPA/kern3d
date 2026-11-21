// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IShape, Matrix4, Plane, ShapeTypes, XYZ } from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { composeDrawing } from "../../src/drawing/compose";
import { defaultDrawingData } from "../../src/drawing/drawingData";
import { computeViewGeometry } from "../../src/drawing/hlr";
import { extractHlrInput } from "../../src/drawing/hlrInput";
import { sheetToSvg } from "../../src/drawing/svgExport";
import { orientationBasis } from "../../src/drawing/viewBasis";
import { faceOutline, geometryToImport } from "../../src/laser/fromModel";
import { hatchPaths } from "../../src/laser/hatch";
import { importSvg } from "../../src/laser/svgImport";

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

/** A 100 × 60 × 40 block with a Ø20 hole through it along z at (50, 30). */
function blockWithHole(): IShape {
    const box = shapeFactory.box(Plane.XY, 100, 60, 40).value;
    const cylinder = shapeFactory.cylinder(
        new XYZ({ x: 0, y: 0, z: 1 }),
        new XYZ({ x: 50, y: 30, z: -5 }),
        10,
        50,
    ).value;
    return shapeFactory.booleanCut([box], [cylinder]).value;
}

describe("outlines from the model", () => {
    test("the top view of a drilled block is its rectangle and the hole, joined into closed outlines", () => {
        const geometry = computeViewGeometry(extractHlrInput(blockWithHole()), orientationBasis("top"), {
            hidden: false,
            tangent: false,
        });
        const imported = geometryToImport(geometry);
        expect(imported).not.toBeUndefined();
        expect(imported?.width).toBeCloseTo(100, 3);
        expect(imported?.height).toBeCloseTo(60, 3);
        const closed = imported?.paths.filter((p) => p.closed) ?? [];
        expect(closed.length).toBe(2);
        // the hatch leaves the hole empty: a line through its centre stops at its edge
        const lines = hatchPaths(imported?.paths ?? [], 1, 0);
        const middle = lines.filter((l) => Math.abs(l.from.y - 29.5) < 1e-6);
        expect(middle.length).toBe(2);
    });

    test("a picked planar face is seen square on, with its hole", () => {
        const shape = blockWithHole();
        const faces = shape.findSubShapes(ShapeTypes.face);
        // the top face: the one at z = 40
        const top = faces.find((f) => {
            const b = f.boundingBox();
            return Math.abs(b.min.z - 40) < 1e-6 && Math.abs(b.max.z - 40) < 1e-6;
        });
        expect(top).not.toBeUndefined();
        const imported = faceOutline(top!, Matrix4.identity());
        expect(imported?.width).toBeCloseTo(100, 3);
        expect(imported?.height).toBeCloseTo(60, 3);
        expect(imported?.paths.filter((p) => p.closed).length).toBe(2);
    });

    test("a drawing sheet comes in through the SVG exporter at true size", () => {
        const sheet = composeDrawing(defaultDrawingData(), new Map(), 0);
        const svg = sheetToSvg(sheet).replace(/<rect x="0" y="0" [^>]*fill="#fff"\/>/, "");
        const imported = importSvg(svg);
        // the sheet's line work (its trimmed edge, frame and title block), not the white paper behind it
        expect(imported?.width).toBeCloseTo(sheet.width, 1);
        expect(imported?.height).toBeCloseTo(sheet.height, 1);
        expect(imported?.paths.length).toBeGreaterThan(10);
        expect(svg).not.toContain('fill="#fff"');
    });
});
