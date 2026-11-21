// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { pathsBounds } from "../../src/laser/geometry";
import { importSvg, lengthToMm, parsePathData, parseTransform, parseXml } from "../../src/laser/svgImport";

describe("SVG reading", () => {
    test("elements, attributes, comments and a doctype", () => {
        const root = parseXml(
            `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><!-- c --><svg a="1" b='2 &amp; 3'><g><rect/></g></svg>`,
        );
        expect(root?.name).toBe("svg");
        expect(root?.attrs).toEqual({ a: "1", b: "2 & 3" });
        expect(root?.children[0].children[0].name).toBe("rect");
    });

    test("lengths in mm, cm, in, pt and px", () => {
        expect(lengthToMm("10mm")).toBe(10);
        expect(lengthToMm("1cm")).toBe(10);
        expect(lengthToMm("1in")).toBe(25.4);
        expect(lengthToMm("96")).toBeCloseTo(25.4, 9);
        expect(lengthToMm("72pt")).toBeCloseTo(25.4, 9);
        expect(lengthToMm("50%")).toBeUndefined();
    });

    test("transform lists compose left to right", () => {
        const m = parseTransform("translate(10 20) scale(2)");
        expect(m).toEqual([2, 0, 0, 2, 10, 20]);
    });

    test("path data: relative commands, implicit lineto and close", () => {
        const [p] = parsePathData("m10 10 10 0 0 10-10 0z", 0.05);
        expect(p.closed).toBe(true);
        expect(p.points).toEqual([
            { x: 10, y: 10 },
            { x: 20, y: 10 },
            { x: 20, y: 20 },
            { x: 10, y: 20 },
        ]);
    });

    test("H, V and arc flags written together", () => {
        const [p] = parsePathData("M0 0H10V5A5 5 0 0110 0", 0.05);
        expect(p.points[0]).toEqual({ x: 0, y: 0 });
        expect(p.points[2]).toEqual({ x: 10, y: 5 });
        expect(p.points[p.points.length - 1]).toEqual({ x: 10, y: 0 });
    });
});

describe("SVG import", () => {
    test("viewBox in user units maps to the document's millimetres, y flipped up", () => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 200 100">
            <rect x="0" y="0" width="20" height="10"/></svg>`;
        const result = importSvg(svg)!;
        expect(result.width).toBeCloseTo(10, 9);
        expect(result.height).toBeCloseTo(5, 9);
        expect(result.paths).toHaveLength(1);
        expect(result.paths[0].closed).toBe(true);
    });

    test("a circle, an ellipse, a line and a polyline through a group transform", () => {
        const svg = `<svg width="100mm" height="100mm" viewBox="0 0 100 100">
            <g transform="translate(50 50)">
              <circle r="10"/>
              <ellipse cx="0" cy="0" rx="20" ry="5"/>
              <line x1="-30" y1="0" x2="30" y2="0"/>
              <polyline points="0,0 0,30"/>
            </g></svg>`;
        const result = importSvg(svg)!;
        expect(result.paths).toHaveLength(4);
        expect(result.width).toBeCloseTo(60, 6);
        expect(result.height).toBeCloseTo(40, 6);
        const circle = result.paths[0];
        expect(circle.closed).toBe(true);
        const b = pathsBounds([circle]);
        expect(b.maxX - b.minX).toBeCloseTo(20, 6);
    });

    test("y points up after import: an element at the SVG's top ends up highest", () => {
        const svg = `<svg width="10mm" height="10mm" viewBox="0 0 10 10">
            <line x1="0" y1="0" x2="1" y2="0"/><line x1="0" y1="10" x2="1" y2="10"/></svg>`;
        const result = importSvg(svg)!;
        // the first line (SVG y = 0, top) is at the top of the imported box
        expect(result.paths[0].points[0].y).toBeCloseTo(10, 9);
        expect(result.paths[1].points[0].y).toBeCloseTo(0, 9);
    });

    test("hidden elements, defs and text are left out; use draws its target", () => {
        const svg = `<svg width="10mm" height="10mm" viewBox="0 0 10 10">
            <defs><rect id="r" width="2" height="2"/></defs>
            <rect width="1" height="1" style="display:none"/>
            <text>hello</text>
            <use href="#r" x="5" y="5"/></svg>`;
        const result = importSvg(svg)!;
        expect(result.paths).toHaveLength(1);
        expect(result.width).toBeCloseTo(2, 9);
    });

    test("not an SVG", () => {
        expect(importSvg("<html></html>")).toBeUndefined();
    });
});
