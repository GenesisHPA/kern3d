// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { FontOutline, GlyphOutline } from "@chili3d/core";
import { describe, expect, test } from "@rstest/core";
import { apply, pathsBounds } from "../../src/laser/geometry";
import { parseLaserJob, placement, stringifyLaserJob } from "../../src/laser/laserData";
import { applyGeometry, bakeSize, regenerate, shapeObject } from "../../src/laser/shapeObject";
import { type LaserShape, parseShape, shapeGeometry } from "../../src/laser/shapes";

/** A font of 1000 units whose every letter is a 500 × 700 box, advancing 600. */
function boxFont(): FontOutline {
    const box: GlyphOutline = {
        advance: 600,
        contours: [
            {
                start: { x: 0, y: 0 },
                segments: [
                    { kind: "line", to: { x: 500, y: 0 } },
                    { kind: "line", to: { x: 500, y: 700 } },
                    { kind: "line", to: { x: 0, y: 700 } },
                ],
            },
        ],
    };
    return {
        familyName: "Box",
        unitsPerEm: 1000,
        missingAdvance: 300,
        glyph: (code) => (code === 32 ? { advance: 300, contours: [] } : box),
    };
}

const text = (over: Partial<Extract<LaserShape, { type: "text" }>> = {}): LaserShape => ({
    type: "text",
    text: "AB",
    font: { family: "Box" },
    size: 10,
    letterSpacing: 0,
    lineSpacing: 1.2,
    align: "left",
    arcRadius: 0,
    ...over,
});

describe("figures", () => {
    test("a rectangle is its size, the box from 0, 0", () => {
        const g = shapeGeometry({ type: "rect", width: 30, height: 20, radius: 0 });
        expect(g.width).toBeCloseTo(30);
        expect(g.height).toBeCloseTo(20);
        expect(g.paths[0].points).toHaveLength(4);
        expect(g.paths[0].closed).toBe(true);
    });

    test("round corners keep the size; a radius past half a side is cut to it", () => {
        const g = shapeGeometry({ type: "rect", width: 30, height: 20, radius: 50 });
        expect(g.width).toBeCloseTo(30, 3);
        expect(g.height).toBeCloseTo(20, 3);
        // a 20 mm side with 10 mm corners: the short sides are half circles
        const mid = g.paths[0].points.reduce((a, p) => (p.x < a.x ? p : a));
        expect(mid.y).toBeCloseTo(10, 1);
    });

    test("an ellipse is 2·rx by 2·ry", () => {
        const g = shapeGeometry({ type: "ellipse", rx: 15, ry: 5 });
        // flattened to 0.02 mm
        expect(Math.abs(g.width - 30)).toBeLessThan(0.03);
        expect(Math.abs(g.height - 10)).toBeLessThan(0.03);
    });

    test("a hexagon has 6 corners, a 5-point star 10, the inner ones at the share asked", () => {
        expect(
            shapeGeometry({ type: "polygon", sides: 6, radius: 10, star: 0 }).paths[0].points,
        ).toHaveLength(6);
        const star = shapeGeometry({ type: "polygon", sides: 5, radius: 10, star: 0.5 });
        const pts = star.paths[0].points;
        expect(pts).toHaveLength(10);
        // the first vertex points straight up: it is the top of the box
        expect(pts[0].y).toBeCloseTo(star.height, 6);
        const cx = pts[0].x;
        const cy = pts[0].y - 10;
        expect(Math.hypot(pts[1].x - cx, pts[1].y - cy)).toBeCloseTo(5, 6);
    });

    test("a polyline keeps its shape, moved to 0, 0; a straight line still has a box", () => {
        const g = shapeGeometry({
            type: "polyline",
            points: [
                { x: 10, y: 5 },
                { x: 40, y: 5 },
            ],
            closed: false,
        });
        expect(g.paths[0].points).toEqual([
            { x: 0, y: 0 },
            { x: 30, y: 0 },
        ]);
        expect(g.height).toBeGreaterThan(0);
    });
});

describe("text", () => {
    test("two letters: advances plus letter spacing, the size scales the em", () => {
        const g = shapeGeometry(text({ letterSpacing: 2 }), boxFont());
        expect(g.paths).toHaveLength(2);
        // 6 mm advance + 2 mm spacing + a 5 mm wide letter
        expect(g.width).toBeCloseTo(13, 6);
        expect(g.height).toBeCloseTo(7, 6);
    });

    test("a second line goes down by the line spacing; centred lines share a middle", () => {
        const g = shapeGeometry(text({ text: "AB\nA", align: "center" }), boxFont());
        expect(g.height).toBeCloseTo(12 + 7, 6);
        const bottom = g.paths.filter((p) => Math.min(...p.points.map((q) => q.y)) < 1);
        expect(bottom).toHaveLength(1);
        const b = pathsBounds(bottom);
        const all = pathsBounds(g.paths);
        // the short line's letter is centred under the long one's 11 mm
        expect((b.minX + b.maxX) / 2).toBeCloseTo((all.minX + all.maxX) / 2, 6);
    });

    test("on an arc over the top the letters stand round the circle, upright at the middle", () => {
        const g = shapeGeometry(text({ text: "AAA", arcRadius: 30 }), boxFont());
        const straight = shapeGeometry(text({ text: "AAA" }), boxFont());
        expect(g.paths).toHaveLength(3);
        // the side letters lean down round the circle, below the middle one
        const first = pathsBounds([g.paths[0]]);
        expect(first.minY).toBeLessThan(pathsBounds([g.paths[1]]).minY - 0.5);
        expect(g.height).toBeGreaterThan(straight.height);
        // the middle letter's foot is the lowest of it: upright
        const mid = pathsBounds([g.paths[1]]);
        expect(mid.maxY).toBeCloseTo(g.height, 1);
    });

    test("along the bottom of a circle the text reads left to right, the middle lowest", () => {
        const g = shapeGeometry(text({ text: "AAA", arcRadius: -30 }), boxFont());
        const first = pathsBounds([g.paths[0]]);
        const last = pathsBounds([g.paths[2]]);
        const mid = pathsBounds([g.paths[1]]);
        expect(first.minX).toBeLessThan(last.minX);
        expect(mid.minY).toBeCloseTo(0, 6);
    });

    test("no font at hand: no outlines (the object keeps its old ones)", () => {
        expect(shapeGeometry(text()).paths).toHaveLength(0);
    });
});

describe("objects drawn with a tool", () => {
    test("a figure survives the stored job; junk in its place is no figure", () => {
        const o = shapeObject({ type: "polygon", sides: 5, radius: 10, star: 0.4 }, "Star", {
            centre: { x: 0, y: 0 },
        });
        if (o === undefined) throw new Error("no object");
        const job = parseLaserJob(stringifyLaserJob({ version: 1, origin: "center", objects: [o] }));
        const back = job.objects[0];
        expect(back.kind === "vector" && back.shape).toEqual(o.shape);
        expect(parseShape({ type: "polyline", points: [{ x: 1 }] })).toBeUndefined();
        expect(parseShape({ type: "wobble" })).toBeUndefined();
    });

    test("new parameters keep the centre, the turn and the stretch", () => {
        const o = shapeObject({ type: "polygon", sides: 6, radius: 10, star: 0 }, "P", {
            centre: { x: 20, y: 30 },
            angle: 30,
        });
        if (o === undefined) throw new Error("no object");
        o.width *= 2; // stretched to twice its width
        const centre = apply(placement(o), { x: o.width / 2, y: o.height / 2 });
        if (o.shape?.type === "polygon") o.shape.radius = 20;
        expect(regenerate(o).ok).toBe(true);
        const after = apply(placement(o), { x: o.width / 2, y: o.height / 2 });
        expect(after.x).toBeCloseTo(centre.x, 6);
        expect(after.y).toBeCloseTo(centre.y, 6);
        expect(o.angle).toBe(30);
        expect(o.width / o.sourceWidth).toBeCloseTo(2, 6);
        expect(o.sourceHeight).toBeCloseTo(40, 1);
    });

    test("a rectangle scaled on the bed takes the size as its own, its corners stay round", () => {
        const o = shapeObject({ type: "rect", width: 20, height: 10, radius: 3 }, "R", {
            corner: { x: 0, y: 0 },
        });
        if (o === undefined) throw new Error("no object");
        o.width = 40;
        expect(bakeSize(o)).toBe(true);
        expect(o.shape).toMatchObject({ width: 40, height: 10, radius: 3 });
        expect(o.sourceWidth).toBeCloseTo(40, 3);
        expect(o.width / o.sourceWidth).toBeCloseTo(1, 6);
        expect(bakeSize(o)).toBe(false);
    });

    test("a text is made again only with its font", () => {
        const o = shapeObject(text(), "T", { corner: { x: 0, y: 0 } }, boxFont());
        if (o === undefined) throw new Error("no object");
        if (o.shape?.type === "text") o.shape.text = "ABC";
        expect(regenerate(o).ok).toBe(false);
        expect(regenerate(o, boxFont()).ok).toBe(true);
        expect(o.paths).toHaveLength(3);
        applyGeometry(o, { paths: o.paths, width: o.sourceWidth, height: o.sourceHeight });
        expect(o.sourceWidth).toBeCloseTo(17, 6);
    });
});

describe("barcodes as figures", () => {
    const qr = (over = {}): LaserShape => ({
        type: "barcode",
        format: "qr",
        data: "HELLO WORLD",
        level: "Q",
        module: 0.5,
        quiet: 4,
        barHeight: 15,
        showText: false,
        invert: false,
        ...over,
    });

    test("a QR's box is its modules and the quiet zone; dark runs are merged rectangles", () => {
        const g = shapeGeometry(qr());
        // version 1: 21 modules + 2 × 4 quiet, 0.5 mm each
        expect(g.width).toBeCloseTo(14.5, 9);
        expect(g.height).toBeCloseTo(14.5, 9);
        expect(g.paths.every((p) => p.closed && p.points.length === 4)).toBe(true);
        // fewer rectangles than dark modules: runs in a row are one
        expect(g.paths.length).toBeLessThan(21 * 21 * 0.6);
        const b = pathsBounds(g.paths);
        expect(b.minX).toBeCloseTo(2, 9);
        expect(b.maxY).toBeCloseTo(12.5, 9);
    });

    test("inverted, the background is one more outline round the quiet zone", () => {
        const plain = shapeGeometry(qr());
        const inv = shapeGeometry(qr({ invert: true }));
        expect(inv.paths.length).toBe(plain.paths.length + 1);
        expect(pathsBounds([inv.paths[0]])).toEqual({ minX: 0, minY: 0, maxX: 14.5, maxY: 14.5 });
    });

    test("an EAN-13 is 95 modules wide plus the quiet zone; a wrong check digit makes nothing", () => {
        const g = shapeGeometry(qr({ format: "ean13", data: "400638133393", quiet: 9, module: 0.33 }));
        expect(g.width).toBeCloseTo((95 + 18) * 0.33, 9);
        expect(shapeGeometry(qr({ format: "ean13", data: "4006381333932" })).error).toBe(
            "laser.barcode.ean13",
        );
    });

    test("digits under a Code 128 come with a font, and without one the bars still do", () => {
        const withText = shapeGeometry(qr({ format: "code128", data: "AB12", showText: true }), boxFont());
        const bars = shapeGeometry(qr({ format: "code128", data: "AB12", showText: true }));
        expect(withText.paths.length).toBeGreaterThan(bars.paths.length);
        expect(withText.height).toBeGreaterThan(bars.height);
    });

    test("a drawn barcode is filled and survives the stored job", () => {
        const o = shapeObject(qr(), "QR", { centre: { x: 0, y: 0 } });
        expect(o?.op.mode).toBe("fill");
        const job = parseLaserJob(stringifyLaserJob({ version: 1, origin: "center", objects: o ? [o] : [] }));
        const back = job.objects[0];
        expect(back.kind === "vector" && back.shape).toEqual(o?.shape);
    });
});
