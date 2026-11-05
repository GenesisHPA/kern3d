// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// A drawing of a real part from a STEP file, for looking at by eye: runs only with
// KERN3D_STEP=<file.step> and writes the sheet to KERN3D_DRAWING_DUMP (an SVG).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IShape, Matrix4 } from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { OccShape } from "../../../wasm/src/shape";
import { autoDrawing } from "../../src/drawing/autoDrawing";
import { composeDrawing } from "../../src/drawing/compose";
import { defaultDrawingData } from "../../src/drawing/drawingData";
import { ViewGeometryCache } from "../../src/drawing/drawingViews";
import { sheetToSvg } from "../../src/drawing/svgExport";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STEP = process.env["KERN3D_STEP"];
const DUMP = process.env["KERN3D_DRAWING_DUMP"] ?? ".";

describe.skipIf(!STEP)("drawing of a STEP part", () => {
    beforeAll(async () => {
        await initWasm({ wasmBinary: readFileSync(path.resolve(HERE, "../../../wasm/lib/chili-wasm.wasm")) });
        Object.defineProperty(globalThis, "shapeFactory", {
            value: new ShapeFactory(),
            writable: true,
            configurable: true,
        });
    });

    test("auto drawing", () => {
        const root = (globalThis as any).wasm.Converter.convertFromStep(new Uint8Array(readFileSync(STEP!)));
        const shapes: IShape[] = [];
        const walk = (node: any) => {
            if (node.shape && !node.shape.isNull()) shapes.push(OccShape.wrap(node.shape));
            for (const child of node.getChildren()) walk(child);
        };
        walk(root);
        expect(shapes.length).toBeGreaterThan(0);
        const shape = shapes.length === 1 ? shapes[0] : shapeFactory.combine(shapes).value;
        const cache = new ViewGeometryCache(() => ({ shape, transform: Matrix4.identity() }));
        const data = defaultDrawingData();
        const started = Date.now();
        autoDrawing(data, "part", cache);
        mkdirSync(DUMP, { recursive: true });
        const name = path.basename(STEP!).replace(/\.[^.]+$/, "");
        for (let page = 0; page < (data.pages ?? 1); page++) {
            const sheet = composeDrawing(data, cache.all(data), page);
            writeFileSync(path.join(DUMP, `${name}-${page + 1}.svg`), sheetToSvg(sheet));
        }
        console.log(
            JSON.stringify({
                ms: Date.now() - started,
                views: data.views.map((v) => [
                    v.orientation,
                    v.scale,
                    v.page ?? 0,
                    v.section?.name ?? v.designation,
                ]),
                dims: data.dimensions.length,
            }),
        );
    });
});
