// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IShape, Matrix4, Plane, XYZ } from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { composeDrawing } from "../../src/drawing/compose";
import { type DrawingViewData, defaultDrawingData } from "../../src/drawing/drawingData";
import { layoutStandardViews, newView, ViewGeometryCache } from "../../src/drawing/drawingViews";
import { computeViewGeometry, type Polyline2, type ViewGeometry } from "../../src/drawing/hlr";
import { extractHlrInput } from "../../src/drawing/hlrInput";
import { ownerBounds } from "../../src/drawing/primitives";
import { drawingArea } from "../../src/drawing/sheet";
import { orientationBasis } from "../../src/drawing/viewBasis";

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

const ALL = { hidden: true, tangent: false };

function length(line: Polyline2): number {
    let total = 0;
    for (let k = 2; k < line.points.length; k += 2) {
        total += Math.hypot(line.points[k] - line.points[k - 2], line.points[k + 1] - line.points[k - 1]);
    }
    return total;
}

function totalLength(lines: Polyline2[]): number {
    return lines.reduce((sum, line) => sum + length(line), 0);
}

/** A 100 × 60 × 40 block (x × y × z) with a Ø20 hole drilled through it along z at (50, 30). */
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

function view(shape: IShape, name: Parameters<typeof orientationBasis>[0], options = ALL): ViewGeometry {
    return computeViewGeometry(extractHlrInput(shape), orientationBasis(name), options);
}

describe("drawing hidden-line removal on kernel shapes", () => {
    test("a box's front view is its four outline edges, nothing hidden", () => {
        const box = shapeFactory.box(Plane.XY, 100, 60, 40).value;
        const geometry = view(box, "front");
        expect(geometry.visible.length).toBe(4);
        expect(totalLength(geometry.visible)).toBeCloseTo(2 * (100 + 40), 3);
        expect(geometry.hidden.length).toBe(0);
        expect(geometry.bounds.minX).toBeCloseTo(0, 6);
        expect(geometry.bounds.maxX).toBeCloseTo(100, 6);
        expect(geometry.bounds.minY).toBeCloseTo(0, 6);
        expect(geometry.bounds.maxY).toBeCloseTo(40, 6);
    });

    test("a vertical through hole shows as two hidden lines in the front view", () => {
        const geometry = view(blockWithHole(), "front");
        expect(totalLength(geometry.visible)).toBeCloseTo(2 * (100 + 40), 1);
        // the hole's outline: x = 40 and x = 60, full height, dashed
        expect(geometry.hidden.length).toBe(2);
        const xs = geometry.hidden.map((line) => line.points[0]).sort((a, b) => a - b);
        expect(xs[0]).toBeCloseTo(40, 1);
        expect(xs[1]).toBeCloseTo(60, 1);
        for (const line of geometry.hidden) expect(length(line)).toBeCloseTo(40, 1);
    });

    test("the top view sees the hole as a full visible circle and offers it for centre marks", () => {
        const geometry = view(blockWithHole(), "top");
        expect(geometry.hidden.length).toBe(0);
        const circles = geometry.visible.filter((line) => line.arc !== undefined);
        expect(circles.length).toBe(1);
        const arc = circles[0].arc!;
        expect(arc.cx).toBeCloseTo(50, 6);
        expect(arc.cy).toBeCloseTo(30, 6);
        expect(arc.r).toBeCloseTo(10, 6);
        expect(Math.abs(arc.sweep)).toBeCloseTo(2 * Math.PI, 6);
        expect(geometry.circles).toEqual([expect.objectContaining({ r: expect.closeTo(10, 6) })]);
    });

    test("hidden lines are left out on request", () => {
        const geometry = view(blockWithHole(), "front", { hidden: false, tangent: false });
        expect(geometry.hidden.length).toBe(0);
    });

    test("a cylinder seen from the side has outline lines and a centre line", () => {
        const cylinder = shapeFactory.cylinder(
            new XYZ({ x: 0, y: 0, z: 1 }),
            new XYZ({ x: 0, y: 0, z: 0 }),
            15,
            50,
        ).value;
        const geometry = view(cylinder, "front");
        // two outlines x = ±15 of length 50, top and bottom circles edge-on of length 30
        expect(totalLength(geometry.visible)).toBeCloseTo(2 * 50 + 2 * 30, 0);
        expect(geometry.bounds.minX).toBeCloseTo(-15, 1);
        expect(geometry.bounds.maxX).toBeCloseTo(15, 1);
        expect(geometry.hidden.length).toBe(0);
        expect(geometry.axes.length).toBe(1);
        expect(geometry.axes[0].x1).toBeCloseTo(0, 6);
        expect(Math.abs(geometry.axes[0].y2 - geometry.axes[0].y1)).toBeCloseTo(50, 6);
    });

    test("projected views of one shape share the extent along their common axis", () => {
        const shape = blockWithHole();
        const front = view(shape, "front");
        const left = view(shape, "left");
        expect(left.bounds.minY).toBeCloseTo(front.bounds.minY, 6);
        expect(left.bounds.maxY).toBeCloseTo(front.bounds.maxY, 6);
        expect(left.bounds.maxX - left.bounds.minX).toBeCloseTo(60, 6);
    });
});

describe("drawing views of kernel shapes", () => {
    function cacheOf(shape: IShape) {
        return new ViewGeometryCache(() => ({ shape, transform: Matrix4.identity() }));
    }

    test("a view's line work is scaled onto the sheet", () => {
        const shape = shapeFactory.box(Plane.XY, 100, 60, 40).value;
        const data = defaultDrawingData();
        data.views.push(newView("box", "front", 0.5, 200, 150));
        const sheet = composeDrawing(data, cacheOf(shape).all(data));
        const xs: number[] = [];
        const ys: number[] = [];
        for (const p of sheet.primitives) {
            if (p.owner !== `view:${data.views[0].id}` || p.kind !== "polyline") continue;
            for (let k = 0; k < p.points.length; k += 2) {
                xs.push(p.points[k]);
                ys.push(p.points[k + 1]);
            }
        }
        expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(50, 6);
        expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20, 6);
        expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(200, 6);
    });

    test("the standard views sit in first-angle order, aligned, inside the drawing area", () => {
        const shape = blockWithHole();
        const data = defaultDrawingData();
        const cache = cacheOf(shape);
        layoutStandardViews(data, "block", (v) => cache.geometryOf(v));
        const [front, top, side] = data.views;
        expect([front.orientation, top.orientation, side.orientation]).toEqual(["front", "top", "left"]);
        expect(top.x).toBeCloseTo(front.x, 9);
        expect(top.y).toBeLessThan(front.y);
        expect(side.y).toBeCloseTo(front.y, 9);
        expect(side.x).toBeGreaterThan(front.x);
        expect(front.scale).toBe(1);
        const area = drawingArea(data.sheet, data.titleBlock.kind);
        const sheet = composeDrawing(data, cache.all(data));
        for (const [owner, r] of ownerBounds(sheet.primitives)) {
            if (!owner.startsWith("view:")) continue;
            expect(r.minX).toBeGreaterThanOrEqual(area.minX);
            expect(r.maxX).toBeLessThanOrEqual(area.maxX);
            expect(r.minY).toBeGreaterThanOrEqual(area.minY);
            expect(r.maxY).toBeLessThanOrEqual(area.maxY);
        }
        // the hole: dashed in the front and side views, a circle with centre marks on top
        const layerOf = (v: DrawingViewData, layer: string) =>
            sheet.primitives.filter((p) => p.owner === `view:${v.id}` && p.layer === layer).length;
        expect(layerOf(front, "hidden")).toBe(2);
        expect(layerOf(side, "hidden")).toBe(2);
        expect(layerOf(top, "center")).toBe(2);
        expect(layerOf(front, "center")).toBe(1);
    });
});
