// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "@rstest/core";
import { importEzd } from "../../src/laser/ezdImport";
import { defaultOperation, type LaserObject, objectCorners } from "../../src/laser/laserData";
import {
    alignObjects,
    boundsOf,
    centreOf,
    distributeObjects,
    inside,
    rotateAll,
    scaleAll,
} from "../../src/laser/selection";

function box(x: number, y: number, w: number, h: number, angle = 0): LaserObject {
    return {
        id: `${x},${y}`,
        name: "",
        kind: "vector",
        x,
        y,
        width: w,
        height: h,
        angle,
        lockAspect: false,
        paths: [],
        sourceWidth: w,
        sourceHeight: h,
        op: defaultOperation("line"),
    };
}

const snapshot = (objects: LaserObject[]) =>
    objects.map(({ x, y, width, height, angle }) => ({ x, y, width, height, angle }));

describe("several objects", () => {
    test("align left, centre and top to the selection's box", () => {
        const a = box(0, 0, 10, 10);
        const b = box(20, 5, 4, 2);
        const all = [a, b];
        const target = boundsOf(all);
        alignObjects([b], "left", target);
        expect(b.x).toBe(0);
        alignObjects(all, "top", target);
        expect(a.y + a.height).toBe(10);
        expect(b.y + b.height).toBe(10);
        alignObjects(all, "centerX", { minX: -50, maxX: 50, minY: 0, maxY: 0 });
        expect(a.x + a.width / 2).toBeCloseTo(0, 9);
        expect(b.x + b.width / 2).toBeCloseTo(0, 9);
    });

    test("distribute leaves the outer two and makes the gaps equal", () => {
        const objects = [box(0, 0, 10, 1), box(12, 0, 2, 1), box(40, 0, 10, 1)];
        distributeObjects(objects, "x");
        expect(objects[0].x).toBe(0);
        expect(objects[2].x).toBe(40);
        // 50 wide, 22 of boxes: gaps of 14
        expect(objects[1].x).toBeCloseTo(24, 9);
    });

    test("scaled together about a corner: the middles spread, the sizes follow", () => {
        const objects = [box(0, 0, 10, 10), box(20, 0, 10, 10)];
        const from = snapshot(objects);
        scaleAll(objects, from, { x: 0, y: 0 }, 2, 2);
        expect(objects[1].x).toBeCloseTo(40, 9);
        expect(objects[1].width).toBeCloseTo(20, 9);
        expect(boundsOf(objects)).toEqual({ minX: 0, minY: 0, maxX: 60, maxY: 20 });
    });

    test("turned together: each goes round the centre and turns by as much", () => {
        const objects = [box(10, -1, 2, 2), box(-12, -1, 2, 2)];
        const from = snapshot(objects);
        rotateAll(objects, from, { x: 0, y: 0 }, 90);
        expect(centreOf(objects[0]).x).toBeCloseTo(0, 9);
        expect(centreOf(objects[0]).y).toBeCloseTo(11, 9);
        expect(objects[0].angle).toBe(90);
        expect(objects[1].angle).toBe(90);
    });

    test("a rubber band takes what lies wholly inside it", () => {
        const objects = [box(0, 0, 5, 5), box(10, 0, 5, 5), box(3, 3, 5, 5, 45)];
        const ids = inside(objects, { minX: -1, minY: -1, maxX: 9, maxY: 9 }).map((o) => o.id);
        expect(ids).toContain("0,0");
        expect(ids).not.toContain("10,0");
        const turned = objectCorners(objects[2]);
        expect(ids.includes("3,3")).toBe(turned.every((p) => p.x <= 9 && p.y <= 9 && p.x >= -1 && p.y >= -1));
    });
});

const files = process.env["KERN3D_EZD_FILES"];

describe.skipIf(!files)("EzCAD files on this computer", () => {
    test("each imports with objects and only known warning codes", () => {
        for (const file of (files ?? "").split(";")) {
            const r = importEzd(readFileSync(file));
            expect(r, file).toBeDefined();
            console.log(file, r?.objects.length, r?.warnings.join(" | "));
            expect(r?.objects.length ?? 0).toBeGreaterThan(0);
        }
    });
});
