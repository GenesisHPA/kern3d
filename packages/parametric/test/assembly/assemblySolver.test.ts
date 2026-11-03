// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Matrix4, XYZ } from "@chili3d/core";
import {
    ROOT_COMPONENT,
    type SolverComponent,
    type SolverJoint,
    solveAssembly,
} from "../../src/assembly/assemblySolver";
import { frameMatrix, jointMotionMatrix } from "../../src/assembly/jointMath";

const xyz = (x: number, y: number, z: number) => new XYZ({ x, y, z });
const up = (z: number) => frameMatrix({ origin: xyz(0, 0, z), x: XYZ.unitX, z: XYZ.unitZ });
const down = frameMatrix({ origin: XYZ.zero, x: xyz(-1, 0, 0), z: xyz(0, 0, -1) });
const rigid = jointMotionMatrix({
    type: "rigid",
    flip: false,
    offset: 0,
    angle: 0,
    rotation: 0,
    slide: 0,
    slide2: 0,
    pitch: 0,
    yaw: 0,
});

function component(id: string, values: Partial<SolverComponent> = {}): SolverComponent {
    return { id, local: Matrix4.identity(), between: Matrix4.identity(), grounded: false, ...values };
}

/** `c2` stacked on top of `c1`, whose top face is at height `height`. */
function stack(id: string, c1: string, c2: string, height = 10): SolverJoint {
    return { id, component1: c1, component2: c2, frame1: up(height), frame2: down, motion: rigid };
}

function origin(matrix: Matrix4 | undefined): XYZ {
    return matrix!.ofPoint(XYZ.zero);
}

describe("solveAssembly", () => {
    test("places outward from the root: a chain of stacked parts", () => {
        const result = solveAssembly(
            [component("a"), component("b")],
            [stack("j1", ROOT_COMPONENT, "a"), stack("j2", "a", "b")],
        );
        expect(origin(result.worlds.get("a")).distanceTo(xyz(0, 0, 10))).toBeLessThan(1e-9);
        expect(origin(result.worlds.get("b")).distanceTo(xyz(0, 0, 20))).toBeLessThan(1e-9);
        expect(result.status.get("j1")).toBe("ok");
        expect(result.status.get("j2")).toBe("ok");
    });

    test("with nothing fixed, component 1 keeps its place and component 2 moves to it", () => {
        const a = component("a", { local: Matrix4.fromTranslation(100, 0, 0) });
        const result = solveAssembly([a, component("b")], [stack("j", "a", "b")]);
        expect(result.locals.has("a")).toBe(false);
        expect(origin(result.locals.get("b")).distanceTo(xyz(100, 0, 10))).toBeLessThan(1e-9);
    });

    test("a grounded component 2 stays put and component 1 is moved instead", () => {
        const b = component("b", { grounded: true, local: Matrix4.fromTranslation(0, 0, 50) });
        const result = solveAssembly([component("a"), b], [stack("j", "a", "b")]);
        expect(result.locals.has("b")).toBe(false);
        // a's top face (z = 10 in a) meets b's bottom (b's origin at z = 50)
        expect(origin(result.worlds.get("a")).distanceTo(xyz(0, 0, 40))).toBeLessThan(1e-9);
    });

    test("a loop that closes is fine; one that does not is reported and does not hang", () => {
        const consistent = solveAssembly(
            [component("a"), component("b")],
            [stack("j1", ROOT_COMPONENT, "a"), stack("j2", "a", "b"), stack("j3", ROOT_COMPONENT, "b", 20)],
        );
        expect(consistent.status.get("j3")).toBe("ok");

        const conflicting = solveAssembly(
            [component("a"), component("b")],
            [stack("j1", ROOT_COMPONENT, "a"), stack("j2", "a", "b"), stack("j3", ROOT_COMPONENT, "b", 99)],
        );
        // Breadth-first from ground: b is reached straight from the root through j3, so it is
        // j2 — the longer way round — that closes the loop and is left unsatisfied.
        expect(conflicting.status.get("j1")).toBe("ok");
        expect(conflicting.status.get("j3")).toBe("ok");
        expect(conflicting.status.get("j2")).toBe("conflict");
        expect(origin(conflicting.worlds.get("b")).distanceTo(xyz(0, 0, 99))).toBeLessThan(1e-9);
    });

    test("two grounded components tied by a joint: checked, never moved", () => {
        const result = solveAssembly(
            [component("a", { grounded: true }), component("b", { grounded: true })],
            [stack("j", "a", "b")],
        );
        expect(result.locals.size).toBe(0);
        expect(result.status.get("j")).toBe("conflict");
    });

    test("a joint inside one component, or between a component and its child, is invalid", () => {
        const result = solveAssembly(
            [component("a"), component("child", { parentId: "a" })],
            [stack("same", "a", "a"), stack("nested", "a", "child"), stack("missing", "a", "ghost")],
        );
        expect(result.status.get("same")).toBe("invalid");
        expect(result.status.get("nested")).toBe("invalid");
        expect(result.status.get("missing")).toBe("invalid");
        expect(result.locals.size).toBe(0);
    });

    test("a nested component's local placement is taken relative to its moved parent", () => {
        // `child` sits inside `parent`, which is itself translated by (0, 0, 100).
        const parent = component("parent", { local: Matrix4.fromTranslation(0, 0, 100) });
        const child = component("child", { parentId: "parent" });
        const result = solveAssembly([parent, child], [stack("j", ROOT_COMPONENT, "child")]);
        expect(origin(result.worlds.get("child")).distanceTo(xyz(0, 0, 10))).toBeLessThan(1e-9);
        expect(origin(result.locals.get("child")).distanceTo(xyz(0, 0, -90))).toBeLessThan(1e-9);
    });

    test("is deterministic: the same input solves the same way", () => {
        const input = [component("a"), component("b"), component("c")];
        const joints = [stack("j1", "a", "b"), stack("j2", "b", "c")];
        const first = solveAssembly(input, joints);
        const second = solveAssembly(input, joints);
        for (const id of ["b", "c"]) expect(first.locals.get(id)!.equals(second.locals.get(id)!)).toBe(true);
    });
});
