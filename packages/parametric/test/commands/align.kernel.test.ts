// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    BoundingBox,
    CurveUtils,
    type IEdge,
    type IFace,
    type IShape,
    type IVertex,
    Matrix4,
    Plane,
    ShapeTypes,
    XYZ,
} from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import {
    type AlignPick,
    alignFrameOf,
    alignmentMatrix,
    rotationBetween,
} from "../../src/commands/alignGeometry";
import { moveCopyMatrix } from "../../src/commands/moveCopyCommand";

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

const xyz = (x: number, y: number, z: number) => new XYZ({ x, y, z });
const NO_FLIP = { flip: false, angle: 0 };

/** An axis-aligned box with its min corner at `corner`. */
function box(corner: XYZ, dx: number, dy: number, dz: number): IShape {
    const plane = new Plane({ origin: corner, normal: XYZ.unitZ, xvec: XYZ.unitX });
    return shapeFactory.box(plane, dx, dy, dz).value;
}

/** The face whose outward normal is `normal`. */
function faceOf(shape: IShape, normal: XYZ): IFace {
    const faces = shape.findSubShapes(ShapeTypes.face) as IFace[];
    const face = faces.find((candidate) => candidate.normal(0, 0)[1].normalize()!.isEqualTo(normal));
    expect(face).toBeDefined();
    return face!;
}

/** The straight edge running from `start` to `end` (either way round). */
function edgeOf(shape: IShape, start: XYZ, end: XYZ): IEdge {
    const edges = shape.findSubShapes(ShapeTypes.edge) as IEdge[];
    const edge = edges.find((candidate) => {
        const [a, b] = candidate.ends();
        return (a.isEqualTo(start) && b.isEqualTo(end)) || (a.isEqualTo(end) && b.isEqualTo(start));
    });
    expect(edge).toBeDefined();
    return edge!;
}

function pick(shape: IShape, transform = Matrix4.identity(), point?: XYZ): AlignPick {
    return { shape, transform, point };
}

function frame(p: AlignPick, snapToCenter = true) {
    const result = alignFrameOf(p, snapToCenter);
    expect(result.isOk).toBe(true);
    return result.value;
}

function expectBox(actual: BoundingBox, min: XYZ, max: XYZ) {
    for (const axis of ["x", "y", "z"] as const) {
        expect(actual.min[axis]).toBeCloseTo(min[axis], 3);
        expect(actual.max[axis]).toBeCloseTo(max[axis], 3);
    }
}

function expectPoint(actual: XYZ, expected: XYZ, tolerance = 1e-6) {
    expect(actual.distanceTo(expected)).toBeLessThan(tolerance);
}

describe("rotationBetween", () => {
    test.each([
        [XYZ.unitX, XYZ.unitY],
        [XYZ.unitZ, XYZ.unitNX],
        [XYZ.unitZ, XYZ.unitNZ],
        [xyz(1, 1, 0).normalize()!, xyz(0, -1, 1).normalize()!],
    ])("turns %o onto %o and keeps the pivot", (from, to) => {
        const pivot = xyz(3, -2, 7);
        const matrix = rotationBetween(from, to, pivot);
        expectPoint(matrix.ofVector(from), to);
        expectPoint(matrix.ofPoint(pivot), pivot);
    });
});

describe("align", () => {
    // A: 10 × 20 × 30 at the origin, the part to move. B: 40 × 40 × 10 at x = 100, the target.
    const a = () => box(XYZ.zero, 10, 20, 30);
    const b = () => box(xyz(100, 0, 0), 40, 40, 10);

    test("a face onto a face lands flush, centred on the target face", () => {
        const partA = a();
        const partB = b();
        const source = frame(pick(faceOf(partA, XYZ.unitNZ)));
        const target = frame(pick(faceOf(partB, XYZ.unitZ)));
        const moved = partA.transformedMul(alignmentMatrix(source, target, NO_FLIP));

        expectBox(moved.boundingBox(), xyz(115, 10, 10), xyz(125, 30, 40));
        const fused = shapeFactory.booleanFuse([moved], [partB], true).value;
        // Touching, not overlapping: the union keeps both volumes.
        expect(fused.volume()).toBeCloseTo(10 * 20 * 30 + 40 * 40 * 10, 3);
    });

    test("a side face turns to face the target", () => {
        const partA = a();
        const source = frame(pick(faceOf(partA, XYZ.unitX)));
        const target = frame(pick(faceOf(b(), XYZ.unitZ)));
        const matrix = alignmentMatrix(source, target, NO_FLIP);
        const moved = partA.transformedMul(matrix);

        expectPoint(matrix.ofVector(XYZ.unitX), XYZ.unitNZ);
        // A's x extent (10) now stands on B's top face.
        const bounds = moved.boundingBox();
        expect(bounds.min.z).toBeCloseTo(10, 3);
        expect(bounds.max.z).toBeCloseTo(20, 3);
    });

    test("flip makes the normals point the same way", () => {
        const source = frame(pick(faceOf(a(), XYZ.unitNZ)));
        const target = frame(pick(faceOf(b(), XYZ.unitZ)));
        const moved = a().transformedMul(alignmentMatrix(source, target, { flip: true, angle: 0 }));

        expectBox(moved.boundingBox(), xyz(115, 10, -20), xyz(125, 30, 10));
    });

    test("the angle spins the part about the target normal", () => {
        const source = frame(pick(faceOf(a(), XYZ.unitNZ)));
        const target = frame(pick(faceOf(b(), XYZ.unitZ)));
        const moved = a().transformedMul(
            alignmentMatrix(source, target, { flip: false, angle: Math.PI / 2 }),
        );

        // 10 × 20 footprint turned a quarter: 20 × 10, still centred at (120, 20).
        expectBox(moved.boundingBox(), xyz(110, 15, 10), xyz(130, 25, 40));
    });

    test("snapping off uses the picked point on the face", () => {
        const source = frame(pick(faceOf(a(), XYZ.unitNZ), Matrix4.identity(), xyz(0, 0, 0)), false);
        const target = frame(pick(faceOf(b(), XYZ.unitZ), Matrix4.identity(), xyz(100, 0, 10)), false);
        const moved = a().transformedMul(alignmentMatrix(source, target, NO_FLIP));

        // Corner onto corner; the bottom face turned over about an axis in the XY plane
        // still spans 10 × 20 above the target face.
        const bounds = moved.boundingBox();
        expect(bounds.min.z).toBeCloseTo(10, 3);
        expect(bounds.max.z).toBeCloseTo(40, 3);
        expect(moved.containsPoint(xyz(100, 0, 10))).toBe(true);
    });

    test("a placed part aligns by its world geometry", () => {
        const placement = Matrix4.fromAxisRad(XYZ.zero, XYZ.unitZ, 0.4).multiply(
            Matrix4.fromTranslation(-50, 30, 5),
        );
        const partA = a();
        const source = frame(pick(faceOf(partA, XYZ.unitNZ), placement));
        const target = frame(pick(faceOf(b(), XYZ.unitZ)));
        const world = placement.multiply(alignmentMatrix(source, target, NO_FLIP));

        const bounds = partA.transformedMul(world).boundingBox();
        expect(bounds.min.z).toBeCloseTo(10, 3);
        expect(bounds.max.z).toBeCloseTo(40, 3);
        expectPoint(BoundingBox.center(bounds).add(xyz(0, 0, -15)), xyz(120, 20, 10), 1e-3);
    });

    test("an edge onto an edge ends collinear, keypoint on keypoint", () => {
        // A's vertical edge at the origin onto B's top front edge (along X).
        const sourceEdge = edgeOf(a(), xyz(0, 0, 0), xyz(0, 0, 30));
        const targetEdge = edgeOf(b(), xyz(100, 0, 10), xyz(140, 0, 10));
        const source = frame(pick(sourceEdge, Matrix4.identity(), xyz(0, 0, 1)));
        const target = frame(pick(targetEdge, Matrix4.identity(), xyz(101, 0, 10)));
        expect(source.kind).toBe("line");
        const matrix = alignmentMatrix(source, target, NO_FLIP);

        // The picked end (the origin) lands on the target's near end and the edge lies on the
        // target line. Perpendicular directions have no preferred sense; Flip takes the other.
        expectPoint(matrix.ofPoint(xyz(0, 0, 0)), xyz(100, 0, 10));
        const far = matrix.ofPoint(xyz(0, 0, 30));
        expect(far.y).toBeCloseTo(0, 6);
        expect(far.z).toBeCloseTo(10, 6);
        expect(Math.abs(far.x - 100)).toBeCloseTo(30, 6);
        const flipped = alignmentMatrix(source, target, { flip: true, angle: 0 });
        expectPoint(flipped.ofPoint(xyz(0, 0, 30)), xyz(200 - far.x, 0, 10));
    });

    test("a vertex onto a vertex is a pure translation", () => {
        const vertices = a().findSubShapes(ShapeTypes.vertex) as IVertex[];
        const corner = vertices.find((v) => v.point().isEqualTo(xyz(10, 20, 30)))!;
        const targetVertex = (b().findSubShapes(ShapeTypes.vertex) as IVertex[]).find((v) =>
            v.point().isEqualTo(xyz(140, 40, 10)),
        )!;
        const matrix = alignmentMatrix(frame(pick(corner)), frame(pick(targetVertex)), NO_FLIP);

        expect(matrix.equals(Matrix4.fromTranslation(130, 20, -20))).toBe(true);
    });

    test("a cylinder's circular edge seats concentric on a face", () => {
        const cylinder = shapeFactory.cylinder(XYZ.unitX, xyz(0, 0, 0), 5, 30).value;
        const circles = (cylinder.findSubShapes(ShapeTypes.edge) as IEdge[]).filter((edge) =>
            CurveUtils.isCircle(edge.curve.basisCurve),
        );
        const rim = circles.find((edge) => Math.abs(edge.startPoint().x) < 1e-6)!;
        const source = frame(pick(rim));
        expect(source.kind).toBe("plane");
        const target = frame(pick(faceOf(b(), XYZ.unitZ)));
        const matrix = alignmentMatrix(source, target, NO_FLIP);

        // The rim's centre sits on the face centre and the axis stands vertical.
        expectPoint(matrix.ofPoint(XYZ.zero), xyz(120, 20, 10));
        expect(Math.abs(matrix.ofVector(XYZ.unitX).z)).toBeCloseTo(1, 6);
        expect(cylinder.transformedMul(matrix).volume()).toBeCloseTo(cylinder.volume(), 3);
    });

    test("cylindrical faces align coaxially", () => {
        const pin = shapeFactory.cylinder(XYZ.unitZ, xyz(0, 0, 0), 4, 20).value;
        const hole = shapeFactory.cylinder(XYZ.unitY, xyz(50, 0, 50), 4, 60).value;
        const sideOf = (shape: IShape) =>
            (shape.findSubShapes(ShapeTypes.face) as IFace[]).find((face) => !face.surface().isPlanar())!;
        const source = frame(pick(sideOf(pin)));
        const target = frame(pick(sideOf(hole)));
        expect(source.kind).toBe("line");
        const matrix = alignmentMatrix(source, target, NO_FLIP);

        // The pin's axis lies on the hole's axis (x = 50, z = 50), centred at mid-height.
        expectPoint(matrix.ofPoint(xyz(0, 0, 10)), xyz(50, 30, 50));
        expectPoint(matrix.ofVector(XYZ.unitZ), XYZ.unitY);
    });

    test("an unsupported face is refused", () => {
        const sphere = shapeFactory.sphere(XYZ.zero, 5).value;
        const face = sphere.findSubShapes(ShapeTypes.face)[0];
        expect(alignFrameOf(pick(face), true).isOk).toBe(false);
    });
});

describe("moveCopyMatrix", () => {
    test("translates by the deltas", () => {
        const matrix = moveCopyMatrix({ dx: 1, dy: -2, dz: 3, rx: 0, ry: 0, rz: 0 }, XYZ.zero);
        expect(matrix.equals(Matrix4.fromTranslation(1, -2, 3))).toBe(true);
    });

    test("turns about the pivot, then translates", () => {
        const pivot = xyz(10, 0, 0);
        const matrix = moveCopyMatrix({ dx: 0, dy: 0, dz: 5, rx: 0, ry: 0, rz: 90 }, pivot);
        // (20, 0, 0) is 10 out along +X from the pivot: a right-handed quarter turn about Z
        // takes it 10 out along +Y, then up 5.
        expectPoint(matrix.ofPoint(xyz(20, 0, 0)), xyz(10, 10, 5));
        expectPoint(matrix.ofPoint(pivot), xyz(10, 0, 5));
    });

    test("applies the turns X, then Y, then Z", () => {
        const matrix = moveCopyMatrix({ dx: 0, dy: 0, dz: 0, rx: 90, ry: 90, rz: 0 }, XYZ.zero);
        // +Y → (about X) +Z → (about Y) +X
        expectPoint(matrix.ofVector(XYZ.unitY), XYZ.unitX);
    });

    test("a box turned and moved keeps its volume and lands where expected", () => {
        const part = box(XYZ.zero, 10, 20, 30);
        const matrix = moveCopyMatrix({ dx: 100, dy: 0, dz: 0, rx: 0, ry: 0, rz: 90 }, xyz(5, 10, 15));
        const moved = part.transformedMul(matrix);
        expect(moved.volume()).toBeCloseTo(6000, 3);
        expectBox(moved.boundingBox(), xyz(95, 5, 0), xyz(115, 15, 30));
    });
});
