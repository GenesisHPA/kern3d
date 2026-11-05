// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IShape, Matrix4, Plane, XYZ } from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { autoDimension, autoDrawing, cylindersOf, dimensionKey } from "../../src/drawing/autoDrawing";
import { composeDrawing, dimensionValue } from "../../src/drawing/compose";
import { type DrawingData, defaultDrawingData, isRadialDimension } from "../../src/drawing/drawingData";
import { ViewGeometryCache } from "../../src/drawing/drawingViews";
import { extractHlrInput } from "../../src/drawing/hlrInput";
import { ownerBounds } from "../../src/drawing/primitives";
import { frameRect } from "../../src/drawing/sheet";
import { sheetToSvg } from "../../src/drawing/svgExport";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM_BINARY = readFileSync(path.resolve(HERE, "../../../wasm/lib/chili-wasm.wasm"));
const DUMP = process.env["KERN3D_DRAWING_DUMP"];

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

function cylinder(x: number, y: number, z: number, r: number, h: number, axis = XYZ.unitZ) {
    return shapeFactory.cylinder(axis, new XYZ({ x, y, z }), r, h).value;
}

function cut(shape: IShape, ...tools: IShape[]) {
    return shapeFactory.booleanCut([shape], tools).value;
}

function drawingOf(shape: IShape, name: string): { data: DrawingData; cache: ViewGeometryCache } {
    const cache = new ViewGeometryCache(() => ({ shape, transform: Matrix4.identity() }));
    const data = defaultDrawingData();
    autoDrawing(data, "part", cache);
    if (DUMP) {
        mkdirSync(DUMP, { recursive: true });
        writeFileSync(path.join(DUMP, `${name}.svg`), sheetToSvg(composeDrawing(data, cache.all(data))));
    }
    return { data, cache };
}

function labels(data: DrawingData): string[] {
    return data.dimensions
        .map((d) => {
            const v = dimensionValue(d);
            const kind = isRadialDimension(d) ? (d.kind === "diameter" ? "Ø" : "R") : "";
            return `${d.prefix ?? ""}${kind}${Math.round(v * 100) / 100}`;
        })
        .sort();
}

function insideFrame(data: DrawingData, cache: ViewGeometryCache) {
    const sheet = composeDrawing(data, cache.all(data));
    const frame = frameRect(data.sheet, data.titleBlock.kind);
    for (const [owner, r] of ownerBounds(sheet.primitives)) {
        expect([owner, r.minX >= frame.minX - 1e-6, r.maxX <= frame.maxX + 1e-6]).toEqual([
            owner,
            true,
            true,
        ]);
        expect([owner, r.minY >= frame.minY - 1e-6, r.maxY <= frame.maxY + 1e-6]).toEqual([
            owner,
            true,
            true,
        ]);
    }
}

describe("automatic drawing by the rules", () => {
    test("a plain block: three views, its three overall sizes once each, no cut", () => {
        const { data, cache } = drawingOf(shapeFactory.box(Plane.XY, 100, 60, 40).value, "block");
        expect(data.views.map((v) => v.orientation)).toEqual(["front", "top", "left", "iso"]);
        expect(data.views.every((v) => v.section === undefined)).toBe(true);
        expect(labels(data)).toEqual(["100", "40", "60"]);
        insideFrame(data, cache);
    });

    test("a plate with four holes: a cut through them, the holes called out once, positions from the base", () => {
        const plate = shapeFactory.box(Plane.XY, 120, 80, 20).value;
        const holes = [
            [20, 20],
            [100, 20],
            [20, 60],
            [100, 60],
        ].map(([x, y]) => cylinder(x, y, -5, 5, 30));
        const { data, cache } = drawingOf(cut(plate, ...holes), "plate4");
        const front = data.views[0];
        expect(front.section?.name).toBe("А");
        expect(Math.abs(front.section!.offset)).toBeCloseTo(20, 6);
        expect(front.showHidden).toBe(false);
        expect(labels(data)).toEqual(["100", "120", "20", "20", "20", "4 отв. Ø10", "60", "80"]);
        // the cut is hatched
        const geometry = cache.geometryOf(front)!;
        expect(geometry.cut.length).toBeGreaterThan(0);
        insideFrame(data, cache);
    });

    test("a blind hole: depth from the face it is drilled from, centred hole on the axis needs no position", () => {
        const block = shapeFactory.box(Plane.XY, 60, 40, 30).value;
        const { data, cache } = drawingOf(cut(block, cylinder(30, 20, 18, 6, 20)), "blind");
        // 60, 40, 30 overall; Ø12; depth 12 from the top face; centred on both axes
        expect(labels(data)).toEqual(["12", "30", "40", "60", "Ø12"]);
        insideFrame(data, cache);
    });

    test("a stepped shaft: diameters along its side, lengths from its end, no cut", () => {
        const shaft = shapeFactory.booleanFuse(
            [cylinder(0, 0, 0, 20, 30)],
            [cylinder(0, 0, 30, 10, 40)],
            true,
        ).value;
        const input = extractHlrInput(shaft);
        expect(cylindersOf(input).every((c) => !c.concave)).toBe(true);
        const { data, cache } = drawingOf(shaft, "shaft");
        expect(data.views.every((v) => v.section === undefined)).toBe(true);
        expect(labels(data)).toEqual(["30", "70", "Ø20", "Ø40"]);
        insideFrame(data, cache);
    });

    test("a flange: holes on a bolt circle are called out with the circle's diameter", () => {
        const disc = cylinder(0, 0, 0, 50, 15);
        const bore = cylinder(0, 0, -5, 15, 30);
        const holes = [0, 1, 2, 3, 4, 5].map((k) =>
            cylinder(35 * Math.cos((k * Math.PI) / 3), 35 * Math.sin((k * Math.PI) / 3), -5, 4, 30),
        );
        const { data, cache } = drawingOf(cut(disc, bore, ...holes), "flange");
        const l = labels(data);
        expect(l).toContain("6 отв. Ø8");
        expect(l).toContain("Ø70");
        expect(l).toContain("Ø30");
        expect(l).toContain("Ø100");
        expect(l).toContain("15");
        insideFrame(data, cache);
    });

    test("a counterbored hole: both diameters, the counterbore's depth, not the through hole's", () => {
        const block = shapeFactory.box(Plane.XY, 50, 50, 25).value;
        const { data, cache } = drawingOf(
            cut(block, cylinder(25, 25, -5, 4, 40), cylinder(25, 25, 19, 7, 10)),
            "cbore",
        );
        expect(labels(data)).toEqual(["25", "50", "50", "6", "Ø14", "Ø8"]);
        insideFrame(data, cache);
    });

    test("an L bracket: the step is dimensioned from the base, once", () => {
        const base = shapeFactory.box(Plane.XY, 80, 40, 10).value;
        const wall = shapeFactory.box(Plane.XY, 10, 40, 50).value;
        const bracket = shapeFactory.booleanFuse([base], [wall], true).value;
        const { data, cache } = drawingOf(bracket, "bracket");
        expect(labels(data)).toEqual(["10", "10", "40", "50", "80"]);
        insideFrame(data, cache);
    });

    test("a blind hole in the right face: a view from the right is added, it sees the hole", () => {
        const block = shapeFactory.box(Plane.XY, 60, 40, 30).value;
        const hole = cylinder(52, 20, 15, 5, 20, XYZ.unitX);
        const { data, cache } = drawingOf(cut(block, hole), "rightHole");
        expect(data.views.map((v) => v.orientation)).toContain("right");
        const right = data.views.find((v) => v.orientation === "right")!;
        expect(cache.geometryOf(right)!.circles.length).toBe(1);
        insideFrame(data, cache);
    });

    test("nothing on the far sides: no extra views", () => {
        const { data } = drawingOf(shapeFactory.box(Plane.XY, 60, 40, 30).value, "plainBlock");
        expect(data.views.filter((v) => v.orientation !== "iso").length).toBe(3);
    });

    test("hand edits survive automatic runs: a deleted one stays deleted, a changed one stays the user's", () => {
        const plate = shapeFactory.box(Plane.XY, 120, 80, 20).value;
        const { data, cache } = drawingOf(cut(plate, cylinder(20, 20, -5, 5, 30)), "edits");
        const count = data.dimensions.length;
        // delete one automatic dimension the way the editor does
        const gone = data.dimensions.find(
            (d) => !isRadialDimension(d) && Math.abs(dimensionValue(d) - 120) < 1e-6,
        )!;
        data.suppressed = [dimensionKey(data, gone)!];
        data.dimensions = data.dimensions.filter((d) => d !== gone);
        // change another: moved and retexted, it is the user's now
        const mine = data.dimensions.find((d) => isRadialDimension(d))!;
        mine.auto = undefined;
        mine.textOverride = "Ø10H7";
        autoDimension(data, "part", cache);
        expect(data.dimensions.length).toBe(count - 1);
        expect(
            data.dimensions.some((d) => !isRadialDimension(d) && Math.abs(dimensionValue(d) - 120) < 1e-6),
        ).toBe(false);
        expect(data.dimensions.filter((d) => isRadialDimension(d)).map((d) => d.textOverride)).toEqual([
            "Ø10H7",
        ]);
        // a full rebuild keeps the user's dimension too, on the new view looking the same way
        autoDrawing(data, "part", cache);
        const kept = data.dimensions.filter((d) => d.textOverride === "Ø10H7");
        expect(kept.length).toBe(1);
        expect(data.views.some((v) => v.id === kept[0].viewId)).toBe(true);
        expect(data.dimensions.filter((d) => isRadialDimension(d)).length).toBe(1);
    });
});
