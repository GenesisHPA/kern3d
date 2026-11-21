// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { apply } from "../../src/laser/geometry";
import { placement } from "../../src/laser/laserData";
import {
    constrainAngle,
    draftPaths,
    dragBox,
    finishBox,
    finishPolyline,
    snapToGrid,
} from "../../src/laser/laserDraw";
import { shapeObject } from "../../src/laser/shapeObject";

const poly = { sides: 5, star: 0 };

describe("drawing tools", () => {
    test("points snap to the millimetre grid; Shift turns a segment onto 15° steps", () => {
        expect(snapToGrid({ x: 1.4, y: -2.6 })).toEqual({ x: 1, y: -3 });
        const p = constrainAngle({ x: 0, y: 0 }, { x: 10, y: 1 });
        expect(p.y).toBeCloseTo(0, 9);
        expect(p.x).toBeCloseTo(Math.hypot(10, 1), 9);
    });

    test("a box dragged up-left or down-right is the same box; Shift makes it square", () => {
        expect(dragBox({ x: 10, y: 10 }, { x: 0, y: 4 }, false)).toEqual({ x: 0, y: 4, w: 10, h: 6 });
        expect(dragBox({ x: 0, y: 0 }, { x: 10, y: 4 }, true)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    });

    test("a dragged rectangle is a rectangle figure in its box; a click is nothing", () => {
        const f = finishBox(
            { kind: "box", tool: "rect", start: { x: 5, y: 5 }, end: { x: 25, y: 15 }, square: false },
            poly,
            0.5,
        );
        expect(f?.shape).toEqual({ type: "rect", width: 20, height: 10, radius: 0 });
        expect(f?.at.corner).toEqual({ x: 5, y: 5 });
        expect(
            finishBox(
                { kind: "box", tool: "rect", start: { x: 5, y: 5 }, end: { x: 5.1, y: 5 }, square: false },
                poly,
                0.5,
            ),
        ).toBeUndefined();
    });

    test("an ellipse dragged with Shift is a circle", () => {
        const f = finishBox(
            { kind: "box", tool: "ellipse", start: { x: 0, y: 0 }, end: { x: 10, y: 4 }, square: true },
            poly,
            0.5,
        );
        expect(f?.shape).toEqual({ type: "ellipse", rx: 5, ry: 5 });
    });

    test("a pentagon dragged from its centre has a vertex under the pointer and its centre stays", () => {
        const start = { x: 10, y: 10 };
        const end = { x: 30, y: 10 };
        const f = finishBox({ kind: "box", tool: "polygon", start, end, square: false }, poly, 0.5);
        if (f === undefined) throw new Error("no figure");
        const o = shapeObject(f.shape, "P", f.at);
        if (o === undefined) throw new Error("no object");
        // the first vertex points up in the figure's frame; turned −90° it points at +x
        expect(o.angle).toBeCloseTo(-90, 6);
        const m = placement(o);
        const pts = o.paths[0].points.map((p) => apply(m, p));
        const tip = pts[0];
        expect(tip.x).toBeCloseTo(30, 6);
        expect(tip.y).toBeCloseTo(10, 6);
        const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
        const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
        expect(cx).toBeCloseTo(10, 6);
        expect(cy).toBeCloseTo(10, 6);
    });

    test("a polyline keeps its points on the bed; repeated clicks collapse, two points close nothing", () => {
        const f = finishPolyline(
            [
                { x: 10, y: 20 },
                { x: 10, y: 20 },
                { x: 30, y: 20 },
                { x: 30, y: 40 },
            ],
            true,
        );
        expect(f?.at.corner).toEqual({ x: 10, y: 20 });
        expect(f?.shape).toEqual({
            type: "polyline",
            points: [
                { x: 0, y: 0 },
                { x: 20, y: 0 },
                { x: 20, y: 20 },
            ],
            closed: true,
        });
        const open = finishPolyline(
            [
                { x: 0, y: 0 },
                { x: 5, y: 0 },
            ],
            true,
        );
        expect(open?.shape).toMatchObject({ closed: false });
        expect(finishPolyline([{ x: 0, y: 0 }], false)).toBeUndefined();
    });

    test("the rubber band follows the pointer", () => {
        const band = draftPaths({ kind: "polyline", points: [{ x: 0, y: 0 }], hover: { x: 3, y: 4 } }, poly);
        expect(band[0].points).toEqual([
            { x: 0, y: 0 },
            { x: 3, y: 4 },
        ]);
        expect(
            draftPaths(
                { kind: "box", tool: "rect", start: { x: 0, y: 0 }, end: { x: 2, y: 3 }, square: false },
                poly,
            )[0].points,
        ).toHaveLength(4);
    });
});
