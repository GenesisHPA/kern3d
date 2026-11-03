// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Matrix4, XYZ } from "@chili3d/core";
import {
    clampToLimit,
    frameMatrix,
    type JointMotion,
    type JointType,
    jointDofs,
    jointMotionMatrix,
    placeFirst,
    placeSecond,
} from "../../src/assembly/jointMath";

const xyz = (x: number, y: number, z: number) => new XYZ({ x, y, z });

function expectPoint(actual: XYZ, expected: XYZ) {
    expect(actual.distanceTo(expected)).toBeLessThan(1e-9);
}

function motion(type: JointType, values: Partial<JointMotion> = {}): JointMotion {
    return {
        type,
        flip: false,
        offset: 0,
        angle: 0,
        rotation: 0,
        slide: 0,
        slide2: 0,
        pitch: 0,
        yaw: 0,
        ...values,
    };
}

// Component 1: the top face of a 10 mm tall block, origin at its centre (0, 0, 10), Z up.
const top = frameMatrix({ origin: xyz(0, 0, 10), x: XYZ.unitX, z: XYZ.unitZ });
// Component 2: the bottom face of a part, origin at its local origin, outward normal -Z.
// Its X axis is what `worldAxisXVec` gives a downward face: -X.
const bottom = frameMatrix({ origin: XYZ.zero, x: xyz(-1, 0, 0), z: xyz(0, 0, -1) });

/** Where component 2 ends up for `m`, with component 1 at the world origin. */
function place(m: JointMotion): Matrix4 {
    return placeSecond(Matrix4.identity(), top, bottom, jointMotionMatrix(m));
}

describe("frameMatrix", () => {
    test("maps the frame's axes and origin", () => {
        const frame = frameMatrix({ origin: xyz(1, 2, 3), x: XYZ.unitY, z: XYZ.unitZ });
        expectPoint(frame.ofPoint(XYZ.zero), xyz(1, 2, 3));
        expectPoint(frame.ofVector(XYZ.unitX), XYZ.unitY);
        // Right-handed: y = z × x.
        expectPoint(frame.ofVector(XYZ.unitY), xyz(-1, 0, 0));
    });

    test("re-orthogonalises a slightly skewed x axis", () => {
        const frame = frameMatrix({ origin: XYZ.zero, x: xyz(1, 0, 0.1), z: XYZ.unitZ });
        expectPoint(frame.ofVector(XYZ.unitX), XYZ.unitX);
    });
});

describe("joint motion", () => {
    test("rigid: two mating faces end up flush, the part upright on the block", () => {
        const placed = place(motion("rigid"));
        expectPoint(placed.ofPoint(XYZ.zero), xyz(0, 0, 10));
        // the part's own up stays up — its bottom face now looks down onto the block
        expectPoint(placed.ofVector(XYZ.unitZ), XYZ.unitZ);
        expectPoint(placed.ofPoint(xyz(0, 0, 5)), xyz(0, 0, 15));
    });

    test("flip turns the part over: the Z axes point the same way", () => {
        const placed = place(motion("rigid", { flip: true }));
        expectPoint(placed.ofPoint(XYZ.zero), xyz(0, 0, 10));
        expectPoint(placed.ofVector(XYZ.unitZ), xyz(0, 0, -1));
    });

    test("offset moves along origin 1's Z, angle turns about it", () => {
        const placed = place(motion("rigid", { offset: 5, angle: 90 }));
        expectPoint(placed.ofPoint(XYZ.zero), xyz(0, 0, 15));
        // the part stays square to the block; a quarter turn about Z then takes its x onto y
        expectPoint(placed.ofVector(XYZ.unitX), XYZ.unitY);
    });

    test("revolute: the rotation value turns the part about the joint axis", () => {
        const a = place(motion("revolute", { rotation: 90 }));
        expectPoint(a.ofPoint(xyz(10, 0, 0)), xyz(0, 10, 10));
        expectPoint(a.ofPoint(XYZ.zero), xyz(0, 0, 10));
    });

    test("a rigid joint ignores DOF values it does not have", () => {
        expect(place(motion("rigid", { rotation: 45, slide: 3 })).equals(place(motion("rigid")))).toBe(true);
    });

    test("slider: the slide value moves along Z, held inside its limits", () => {
        expectPoint(place(motion("slider", { slide: 7 })).ofPoint(XYZ.zero), xyz(0, 0, 17));
        const limited = place(motion("slider", { slide: 7, slideLimit: { enabled: true, min: 0, max: 5 } }));
        expectPoint(limited.ofPoint(XYZ.zero), xyz(0, 0, 15));
    });

    test("revolute limits clamp the rotation", () => {
        const limited = place(
            motion("revolute", { rotation: 200, rotationLimit: { enabled: true, min: -90, max: 90 } }),
        );
        expectPoint(limited.ofPoint(xyz(10, 0, 0)), xyz(0, 10, 10));
    });

    test("cylindrical: rotation and slide together", () => {
        const placed = place(motion("cylindrical", { rotation: 90, slide: 2 }));
        expectPoint(placed.ofPoint(xyz(10, 0, 0)), xyz(0, 10, 12));
    });

    test("pin-slot: rotation about Z, slide along X", () => {
        const placed = place(motion("pinSlot", { rotation: 0, slide: 4 }));
        expectPoint(placed.ofPoint(XYZ.zero), xyz(4, 0, 10));
    });

    test("planar: slides in the plane, never off it", () => {
        const placed = place(motion("planar", { slide: 3, slide2: -2, rotation: 90 }));
        expectPoint(placed.ofPoint(XYZ.zero), xyz(3, -2, 10));
        expectPoint(placed.ofPoint(xyz(1, 0, 0)), xyz(3, -1, 10));
    });

    test("ball: pitch tips the part about origin 1's X", () => {
        const placed = place(motion("ball", { pitch: 90 }));
        expectPoint(placed.ofPoint(XYZ.zero), xyz(0, 0, 10));
        // the part's up turns into the block's Y plane
        const up = placed.ofVector(XYZ.unitZ);
        expect(Math.abs(up.z)).toBeLessThan(1e-9);
    });

    test("placeFirst is the inverse of placeSecond", () => {
        const m = jointMotionMatrix(motion("cylindrical", { rotation: 33, slide: 4, offset: 1, angle: 12 }));
        const world1 = Matrix4.fromTranslation(5, -3, 2).multiply(
            Matrix4.fromAxisRad(XYZ.zero, XYZ.unitY, 0.3),
        );
        const world2 = placeSecond(world1, top, bottom, m);
        expect(placeFirst(world2, top, bottom, m).equals(world1)).toBe(true);
    });

    test.each([
        ["rigid", 0],
        ["revolute", 1],
        ["slider", 1],
        ["cylindrical", 2],
        ["pinSlot", 2],
        ["planar", 3],
        ["ball", 3],
    ] as const)("%s has %i degrees of freedom", (type, count) => {
        const d = jointDofs(type);
        expect([d.rotation, d.slide, d.slide2].filter(Boolean).length + (d.ball ? 2 : 0)).toBe(count);
    });
});

describe("clampToLimit", () => {
    test("off: no clamp; a reversed range reads the right way round", () => {
        expect(clampToLimit(50, { enabled: false, min: 0, max: 10 })).toBe(50);
        expect(clampToLimit(50, { enabled: true, min: 10, max: 0 })).toBe(10);
        expect(clampToLimit(-5, { enabled: true, min: 10, max: 0 })).toBe(0);
    });
});
