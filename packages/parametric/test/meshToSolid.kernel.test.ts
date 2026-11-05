// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IEdge, type IFace, type IShape, Matrix4, Plane, ShapeTypes, XYZ } from "@chili3d/core";
import { initWasm, OccShapeConverter, ShapeFactory } from "@chili3d/wasm";
import { OccShape } from "../../wasm/src/shape";
import { meshToSolid } from "../src/commands/meshToSolid";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/chili-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    for (const [name, value] of [
        ["shapeFactory", new ShapeFactory()],
        ["shapeConverter", new OccShapeConverter()],
    ] as const) {
        Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
    }
});

const at = (x: number, y: number, z: number) => new XYZ({ x, y, z });
const box = (x: number, y: number, z: number, dx: number, dy: number, dz: number) =>
    shapeFactory.box(new Plane({ origin: at(x, y, z), normal: XYZ.unitZ, xvec: XYZ.unitX }), dx, dy, dz)
        .value;
const cyl = (axis: XYZ, base: XYZ, r: number, h: number) => shapeFactory.cylinder(axis, base, r, h).value;
const cut = (a: IShape, ...b: IShape[]) => shapeFactory.booleanCut([a], b).value;
const fuse = (a: IShape, ...b: IShape[]) => shapeFactory.booleanFuse([a], b, true).value;

/** Fillets the edges of `shape` that `pick` selects. */
function round(shape: IShape, radius: number, pick: (a: XYZ, b: XYZ) => boolean): IShape {
    const edges = shape.findSubShapes(ShapeTypes.edge) as IEdge[];
    const indexes = edges.flatMap((e, i) => {
        const [a, b] = e.ends();
        return pick(a, b) ? [i] : [];
    });
    return shapeFactory.fillet(shape, indexes, radius).value;
}

/** The part written to STL and read back the way the importer does. */
function throughStl(shape: IShape): IShape {
    const stl = shapeConverter.convertToSTL([shape], { binary: true } as never);
    const node = (globalThis as any).wasm.Converter.convertFromStl(stl.value);
    return OccShape.wrap(node.shape);
}

function curvedRadii(shape: IShape): number[] {
    const radii: number[] = [];
    for (const face of shape.findSubShapes(ShapeTypes.face) as IFace[]) {
        const s = face.surface();
        try {
            if (s.isPlanar()) continue;
            const anyCircle = (face.findSubShapes(ShapeTypes.edge) as IEdge[])
                .map((e) => {
                    try {
                        const b = e.curve.basisCurve as any;
                        // a cylinder cut by an oblique face: its rims are ellipses whose minor radius is the cylinder's
                        return (b.radius ?? b.minorRadius) as number | undefined;
                    } catch {
                        return undefined;
                    }
                })
                .find((r) => r !== undefined);
            if (anyCircle !== undefined) radii.push(Math.round(anyCircle * 100) / 100);
        } finally {
            s.dispose();
        }
    }
    return [...new Set(radii)].sort((a, b) => a - b);
}

const near = (a: XYZ, b: XYZ, x?: number, y?: number, z?: number) =>
    (x === undefined || (Math.abs(a.x - x) < 1e-6 && Math.abs(b.x - x) < 1e-6)) &&
    (y === undefined || (Math.abs(a.y - y) < 1e-6 && Math.abs(b.y - y) < 1e-6)) &&
    (z === undefined || (Math.abs(a.z - z) < 1e-6 && Math.abs(b.z - z) < 1e-6));

const CASES: { name: string; make: () => IShape; radii: number[] }[] = [
    {
        name: "through hole",
        make: () => cut(box(0, 0, 0, 60, 40, 10), cyl(XYZ.unitZ, at(20, 20, -1), 5, 12)),
        radii: [5],
    },
    {
        name: "blind hole",
        make: () => cut(box(0, 0, 0, 60, 40, 20), cyl(XYZ.unitZ, at(30, 20, 8), 4, 20)),
        radii: [4],
    },
    {
        name: "boss",
        make: () => fuse(box(0, 0, 0, 60, 40, 10), cyl(XYZ.unitZ, at(30, 20, 10), 8, 12)),
        radii: [8],
    },
    { name: "shaft", make: () => cyl(XYZ.unitX, at(0, 0, 0), 10, 50), radii: [10] },
    {
        name: "stepped shaft",
        make: () => fuse(cyl(XYZ.unitZ, at(0, 0, 0), 15, 20), cyl(XYZ.unitZ, at(0, 0, 20), 7.5, 30)),
        radii: [7.5, 15],
    },
    {
        name: "tube",
        make: () => cut(cyl(XYZ.unitZ, at(0, 0, 0), 12, 40), cyl(XYZ.unitZ, at(0, 0, -1), 8, 42)),
        radii: [8, 12],
    },
    {
        name: "counterbore",
        make: () =>
            cut(
                box(0, 0, 0, 40, 40, 20),
                cyl(XYZ.unitZ, at(20, 20, -1), 3, 30),
                cyl(XYZ.unitZ, at(20, 20, 14), 6, 10),
            ),
        radii: [3, 6],
    },
    {
        name: "four holes",
        make: () =>
            cut(
                box(0, 0, 0, 100, 60, 8),
                ...[
                    [15, 15],
                    [85, 15],
                    [15, 45],
                    [85, 45],
                ].map(([x, y]) => cyl(XYZ.unitZ, at(x, y, -1), 4, 10)),
            ),
        radii: [4],
    },
    {
        name: "rounded edge",
        make: () => round(box(0, 0, 0, 60, 40, 20), 6, (a, b) => near(a, b, 0, undefined, 20)),
        radii: [6],
    },
    {
        name: "four rounded corners",
        make: () =>
            round(
                box(0, 0, 0, 60, 40, 10),
                8,
                (a, b) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6,
            ),
        radii: [8],
    },
    {
        name: "inside corner round",
        make: () =>
            round(fuse(box(0, 0, 0, 60, 40, 10), box(0, 0, 10, 10, 40, 30)), 5, (a, b) =>
                near(a, b, 10, undefined, 10),
            ),
        radii: [5],
    },
    {
        name: "angled hole",
        make: () => {
            const axis = at(1, 0, 1).normalize()!;
            return cut(box(0, 0, 0, 60, 40, 20), cyl(axis, at(10, 20, -10), 4, 60));
        },
        radii: [4],
    },
];

describe("STL to an editable solid with exact cylinders", () => {
    for (const c of CASES) {
        test(c.name, () => {
            const exact = c.make();
            const result = meshToSolid(throughStl(exact)).value;
            // a valid solid, its volume the part's within 0.5 %
            expect(result.findSubShapes(ShapeTypes.solid).length).toBe(1);
            expect(result.checkShape()).toBe(true);
            expect(Math.abs(result.volume() - exact.volume())).toBeLessThan(exact.volume() * 0.005);
            // each cylinder back as an exact surface, at its radius within 1 %
            const radii = curvedRadii(result);
            for (const r of c.radii)
                expect([r, radii.some((x) => Math.abs(x - r) <= r * 0.01)]).toEqual([r, true]);
            // and fewer faces than triangles by far: no facet runs left where cylinders were
            expect(result.findSubShapes(ShapeTypes.face).length).toBeLessThan(
                exact.findSubShapes(ShapeTypes.face).length * 3 + 10,
            );
        });
    }

    test("a placed part (moved and turned) comes back where it was", () => {
        const part = cut(box(0, 0, 0, 30, 20, 10), cyl(XYZ.unitZ, at(15, 10, -1), 4, 12));
        const placed = part.transformedMul(
            Matrix4.fromAxisRad(XYZ.zero, XYZ.unitY, 0.4).multiply(Matrix4.fromTranslation(50, -20, 7)),
        );
        const result = meshToSolid(throughStl(placed)).value;
        const a = placed.boundingBox()!;
        const b = result.boundingBox()!;
        for (const k of ["x", "y", "z"] as const) {
            expect(Math.abs(a.min[k] - b.min[k])).toBeLessThan(0.2);
            expect(Math.abs(a.max[k] - b.max[k])).toBeLessThan(0.2);
        }
        expect(curvedRadii(result).some((r) => Math.abs(r - 4) < 0.04)).toBe(true);
    });

    test("freeform curved surfaces stay faceted but the solid is valid and whole", () => {
        const sphere = shapeFactory.sphere(at(0, 0, 0), 10).value;
        const result = meshToSolid(throughStl(sphere)).value;
        expect(result.findSubShapes(ShapeTypes.solid).length).toBe(1);
        expect(result.checkShape()).toBe(true);
        expect(Math.abs(result.volume() - sphere.volume())).toBeLessThan(sphere.volume() * 0.05);
    });
});
