// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { apply, pathsBounds } from "../../src/laser/geometry";
import { objectMatrix, parseLaserJob, stringifyLaserJob } from "../../src/laser/laserData";
import {
    breakAt,
    deleteNode,
    flattenSubPaths,
    insertNode,
    joinAt,
    moveHandle,
    moveNode,
    parseSubPaths,
    type SubPath,
    segmentPoint,
    simplify,
    smoothStroke,
    toggleSmooth,
} from "../../src/laser/pathShape";
import { convertToPath, pathObject, rebuildPath, shapeObject } from "../../src/laser/shapeObject";

const square = (): SubPath => ({
    closed: true,
    nodes: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
    ],
});

const arc = (): SubPath => ({
    closed: false,
    nodes: [
        { x: 0, y: 0, out: { x: 0, y: 5 } },
        { x: 10, y: 0, in: { x: 10, y: 5 } },
    ],
});

describe("Bézier paths", () => {
    test("corner nodes are straight lines; a closed path does not repeat its first point", () => {
        const [p] = flattenSubPaths([square()]);
        expect(p.points).toHaveLength(4);
        expect(p.closed).toBe(true);
    });

    test("a cubic is flattened within the tolerance and reaches its end", () => {
        const [p] = flattenSubPaths([arc()], 0.01);
        expect(p.points.length).toBeGreaterThan(8);
        expect(p.points[p.points.length - 1]).toEqual({ x: 10, y: 0 });
        // the top of this symmetric cubic is ¾ of the handles' height
        expect(pathsBounds([p]).maxY).toBeCloseTo(3.75, 2);
    });

    test("a node put into a curve leaves the curve where it was", () => {
        const sub = arc();
        const before = segmentPoint(sub, 0, 0.5);
        const at = insertNode(sub, 0, 0.5);
        expect(at).toBe(1);
        expect(sub.nodes[1].x).toBeCloseTo(before.x, 9);
        expect(sub.nodes[1].y).toBeCloseTo(before.y, 9);
        expect(segmentPoint(sub, 0, 0.5).y).toBeCloseTo(
            arc().nodes.length && segmentPoint(arc(), 0, 0.25).y,
            9,
        );
    });

    test("a smooth node's other handle turns to stay opposite; Alt breaks it", () => {
        const n = { x: 0, y: 0, in: { x: -2, y: 0 }, out: { x: 2, y: 0 }, smooth: true };
        moveHandle(n, "out", { x: 0, y: 4 }, false);
        expect(n.in.x).toBeCloseTo(0, 9);
        expect(n.in.y).toBeCloseTo(-2, 9);
        moveHandle(n, "out", { x: 3, y: 3 }, true);
        expect(n.smooth).toBe(false);
        expect(n.in.y).toBeCloseTo(-2, 9);
        moveNode(n, 5, 5);
        expect(n.out).toEqual({ x: 8, y: 8 });
    });

    test("corner ↔ smooth: handles along the neighbours, then none", () => {
        const sub = square();
        toggleSmooth(sub, 1);
        expect(sub.nodes[1].smooth).toBe(true);
        expect(sub.nodes[1].in).toBeDefined();
        toggleSmooth(sub, 1);
        expect(sub.nodes[1].in).toBeUndefined();
    });

    test("break a closed path at a node: open, the node at both ends; join closes it again", () => {
        const subs = [square()];
        breakAt(subs, 0, 2);
        expect(subs[0].closed).toBe(false);
        expect(subs[0].nodes).toHaveLength(5);
        expect(subs[0].nodes[0]).toMatchObject({ x: 10, y: 10 });
        expect(subs[0].nodes[4]).toMatchObject({ x: 10, y: 10 });
        // an open path split in the middle: two
        breakAt(subs, 0, 2);
        expect(subs).toHaveLength(2);
        expect(joinAt(subs, 0, subs[0].nodes.length - 1)).toBe(true);
        expect(subs).toHaveLength(1);
        deleteNode(subs, 0, 0);
        expect(subs[0].nodes.length).toBeGreaterThanOrEqual(2);
    });

    test("a stroke is simplified to its corners and smoothed into nodes", () => {
        const stroke = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i < 25 ? 0 : i - 25 }));
        expect(simplify(stroke, 0.1)).toHaveLength(3);
        const sub = smoothStroke(stroke, 0.1, false);
        expect(sub.nodes).toHaveLength(3);
        expect(sub.nodes[1].smooth).toBe(true);
        expect(sub.nodes[0].out).toBeUndefined();
    });

    test("stored paths are checked node by node", () => {
        expect(parseSubPaths([{ nodes: [{ x: 1, y: 2 }, { x: 3 }], closed: true }])).toBeUndefined();
        const back = parseSubPaths(JSON.parse(JSON.stringify([arc()])));
        expect(back?.[0].nodes[0].out).toEqual({ x: 0, y: 5 });
    });
});

describe("path objects", () => {
    test("drawn on the bed, a path keeps its nodes there; a moved node leaves the others in place", () => {
        const o = pathObject(
            [
                {
                    closed: false,
                    nodes: [
                        { x: 20, y: 30 },
                        { x: 40, y: 30 },
                        { x: 40, y: 50 },
                    ],
                },
            ],
            "C",
        );
        if (o?.shape?.type !== "path") throw new Error("no path");
        o.angle = 30;
        o.width *= 2;
        const fixed = () => apply(objectMatrix(o), (o.shape as { subpaths: SubPath[] }).subpaths[0].nodes[0]);
        const before = fixed();
        moveNode(o.shape.subpaths[0].nodes[2], 60, 80);
        expect(rebuildPath(o)).toBe(true);
        const after = fixed();
        expect(after.x).toBeCloseTo(before.x, 6);
        expect(after.y).toBeCloseTo(before.y, 6);
        expect(o.angle).toBe(30);
        expect(o.width / o.sourceWidth).toBeCloseTo(2, 6);
        const job = parseLaserJob(stringifyLaserJob({ version: 1, origin: "center", objects: [o] }));
        expect(job.objects[0].kind === "vector" && job.objects[0].shape?.type).toBe("path");
    });

    test("an ellipse converted to curves is four smooth nodes on the same outline", () => {
        const o = shapeObject({ type: "ellipse", rx: 10, ry: 5 }, "E", { corner: { x: 0, y: 0 } });
        if (o === undefined) throw new Error("no object");
        const box = { w: o.width, h: o.height };
        expect(convertToPath(o)).toBe(true);
        expect(o.shape?.type === "path" && o.shape.subpaths[0].nodes).toHaveLength(4);
        expect(o.width).toBeCloseTo(box.w, 1);
        expect(o.height).toBeCloseTo(box.h, 1);
    });

    test("a round-cornered rectangle converted to curves keeps its size", () => {
        const o = shapeObject({ type: "rect", width: 30, height: 20, radius: 4 }, "R", {
            corner: { x: 0, y: 0 },
        });
        if (o === undefined) throw new Error("no object");
        expect(convertToPath(o)).toBe(true);
        expect(o.shape?.type === "path" && o.shape.subpaths[0].nodes).toHaveLength(8);
        expect(o.width).toBeCloseTo(30, 6);
        expect(o.height).toBeCloseTo(20, 6);
    });
});
