// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { type IFace, type IShape, Plane, ShapeTypes, XYZ } from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { beforeAll, describe, expect, test } from "@rstest/core";
import { findInterferences } from "../../../src/commands/inspect/interference";
import {
    bodyMassProperties,
    combineMassProperties,
    DENSITY_PRESETS,
    meshMassProperties,
} from "../../../src/commands/inspect/massProperties";
import { sectionCap } from "../../../src/commands/inspect/sectionCaps";

beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(path.resolve(import.meta.dirname, "../../../../wasm/lib/chili-wasm.wasm")),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

function boxAt(x: number, y: number, z: number, dx: number, dy: number, dz: number): IShape {
    const plane = Plane.XY.translateTo(new XYZ({ x, y, z }));
    return shapeFactory.box(plane, dx, dy, dz).value;
}

function cylinder(radius: number, height: number): IShape {
    return shapeFactory.cylinder(XYZ.unitZ, new XYZ({ x: 5, y: -3, z: 2 }), radius, height).value;
}

function expectNear(actual: XYZ | undefined, expected: { x: number; y: number; z: number }, tol: number) {
    expect(actual).not.toBeUndefined();
    expect(Math.abs(actual!.x - expected.x)).toBeLessThan(tol);
    expect(Math.abs(actual!.y - expected.y)).toBeLessThan(tol);
    expect(Math.abs(actual!.z - expected.z)).toBeLessThan(tol);
}

describe("mass properties", () => {
    test("a box: volume, area, bounding box and centre of mass", () => {
        const props = bodyMassProperties("box", boxAt(10, 20, 30, 40, 20, 10), DENSITY_PRESETS.PLA);
        expect(props.volume).toBeCloseTo(8000, 6);
        expect(props.area).toBeCloseTo(2 * (40 * 20 + 40 * 10 + 20 * 10), 6);
        expect(props.box.max.x - props.box.min.x).toBeCloseTo(40, 3);
        expectNear(props.centroid, { x: 30, y: 30, z: 35 }, 1e-6);
        expect(props.mass).toBeCloseTo(8 * 1.24, 9);
    });

    test("a cylinder against the analytic volume, area and centre", () => {
        const r = 7;
        const h = 25;
        const props = bodyMassProperties("cyl", cylinder(r, h), DENSITY_PRESETS.steel);
        expect(props.volume / (Math.PI * r * r * h)).toBeCloseTo(1, 6);
        expect(props.area / (2 * Math.PI * r * (r + h))).toBeCloseTo(1, 6);
        expectNear(props.centroid, { x: 5, y: -3, z: 2 + h / 2 }, 0.05);
        expect(props.mass).toBeCloseTo(((Math.PI * r * r * h) / 1000) * 7.85, 3);
    });

    test("the kernel triangulation winds outward, so the mesh volume matches the kernel", () => {
        const shape = cylinder(10, 10);
        const faces = shape.mesh.faces!;
        const mesh = meshMassProperties(faces.position, faces.index);
        expect(mesh.volume / shape.volume()).toBeGreaterThan(0.97);
        expect(mesh.volume / shape.volume()).toBeLessThan(1.0001);
    });

    test("bodies combine with a mass-weighted centre", () => {
        const a = bodyMassProperties("a", boxAt(0, 0, 0, 10, 10, 10), 1);
        const b = bodyMassProperties("b", boxAt(20, 0, 0, 10, 10, 10), 3);
        const total = combineMassProperties("all", [a, b]);
        expect(total.volume).toBeCloseTo(2000, 6);
        expect(total.mass).toBeCloseTo(4, 9);
        expectNear(total.centroid, { x: (5 * 1 + 25 * 3) / 4, y: 5, z: 5 }, 1e-6);
        expect(total.box.max.x - total.box.min.x).toBeCloseTo(30, 3);
    });

    test("a face encloses no volume and has no centre of mass", () => {
        const face = shapeFactory.rect(Plane.XY, 10, 5).value;
        const props = bodyMassProperties("face", face, 1);
        expect(props.volume).toBeCloseTo(0, 9);
        expect(props.area).toBeCloseTo(50, 6);
        expect(props.centroid).toBeUndefined();
    });
});

describe("interference", () => {
    test("two overlapping boxes report the overlap volume; a separate one does not", () => {
        const shapes = [boxAt(0, 0, 0, 10, 10, 10), boxAt(6, 7, 8, 10, 10, 10), boxAt(50, 0, 0, 5, 5, 5)];
        const result = findInterferences(shapes);
        expect(result.length).toBe(1);
        expect(result[0].first).toBe(0);
        expect(result[0].second).toBe(1);
        expect(result[0].volume).toBeCloseTo(4 * 3 * 2, 6);
        expect(Math.abs(result[0].overlap.volume())).toBeCloseTo(24, 6);
    });

    test("boxes that only touch along a face do not interfere", () => {
        const result = findInterferences([boxAt(0, 0, 0, 10, 10, 10), boxAt(10, 0, 0, 10, 10, 10)]);
        expect(result).toEqual([]);
    });

    test("every overlapping pair among three bodies is listed", () => {
        const result = findInterferences([
            boxAt(0, 0, 0, 10, 10, 10),
            boxAt(5, 0, 0, 10, 10, 10),
            boxAt(8, 0, 0, 10, 10, 10),
        ]);
        expect(result.map((x) => [x.first, x.second])).toEqual([
            [0, 1],
            [0, 2],
            [1, 2],
        ]);
        expect(result.map((x) => Math.round(x.volume))).toEqual([500, 200, 700]);
    });
});

describe("section caps", () => {
    test("a mid-plane through a box gives a cap of the box's cross-section", () => {
        const box = boxAt(0, 0, 0, 40, 20, 10);
        const cap = sectionCap(box, Plane.XY.translateTo(new XYZ({ x: 0, y: 0, z: 4 })));
        expect(cap).not.toBeUndefined();
        const faces = cap!.findSubShapes(ShapeTypes.face) as IFace[];
        expect(faces.reduce((sum, f) => sum + f.area(), 0)).toBeCloseTo(800, 6);
        const box3 = cap!.boundingBox();
        expect(box3.min.z).toBeCloseTo(4, 6);
        expect(box3.max.z).toBeCloseTo(4, 6);
    });

    test("a plane through a cylinder's axis gives the axial rectangle", () => {
        const cap = sectionCap(cylinder(7, 25), Plane.ZX.translateTo(new XYZ({ x: 5, y: -3, z: 0 })));
        expect(cap).not.toBeUndefined();
        const faces = cap!.findSubShapes(ShapeTypes.face) as IFace[];
        expect(faces.reduce((sum, f) => sum + f.area(), 0)).toBeCloseTo(14 * 25, 4);
    });

    test("a plane that misses the body gives no cap", () => {
        const cap = sectionCap(
            boxAt(0, 0, 0, 10, 10, 10),
            Plane.XY.translateTo(new XYZ({ x: 0, y: 0, z: 50 })),
        );
        expect(cap).toBeUndefined();
    });
});
