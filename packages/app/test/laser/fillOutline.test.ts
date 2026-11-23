// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { burnPolylines } from "../../src/laser/jczProgram";
import type { LaserObject } from "../../src/laser/laserData";

function square(fillOutline?: boolean): LaserObject {
    return {
        id: "s",
        name: "s",
        kind: "vector",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        angle: 0,
        lockAspect: true,
        sourceWidth: 10,
        sourceHeight: 10,
        paths: [
            {
                closed: true,
                points: [
                    { x: 0, y: 0 },
                    { x: 10, y: 0 },
                    { x: 10, y: 10 },
                    { x: 0, y: 10 },
                ],
            },
        ],
        op: { mode: "fill", fillInterval: 1, fillAngle: 0, fillOutline } as never,
    } as LaserObject;
}

describe("hatch with its outline", () => {
    test("the outline is traced after the hatch only when asked", () => {
        const hatch = burnPolylines(square(), undefined);
        const both = burnPolylines(square(true), undefined);
        expect(hatch.length).toBeGreaterThan(5);
        expect(hatch.every((l) => l.length === 2)).toBe(true);
        expect(both.length).toBe(hatch.length + 1);
        // the last one goes round the square
        expect(both.at(-1)!.length).toBeGreaterThanOrEqual(5);
    });
});
