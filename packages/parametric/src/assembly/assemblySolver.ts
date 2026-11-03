// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Matrix4 } from "@chili3d/core";
import { invertOrIdentity, placeFirst, placeSecond } from "./jointMath";

/** The document root as a joint side: always at identity, always fixed. */
export const ROOT_COMPONENT = "";

/** A component as the solver sees it. */
export interface SolverComponent {
    readonly id: string;
    /** The component's own transform (relative to its parent). */
    readonly local: Matrix4;
    /** The plain groups between it and its parent component (or the root), composed. */
    readonly between: Matrix4;
    /** The nearest enclosing component; undefined at the document root. */
    readonly parentId?: string;
    readonly grounded: boolean;
}

/** A joint as the solver sees it: two frames, each in its component's local space, and the motion. */
export interface SolverJoint {
    readonly id: string;
    readonly component1: string;
    readonly component2: string;
    readonly frame1: Matrix4;
    readonly frame2: Matrix4;
    readonly motion: Matrix4;
}

/**
 * - `ok` — the joint holds.
 * - `conflict` — it closes a loop (or ties two fixed components) and the placement the rest of
 *   the tree gives does not satisfy it; it is left unsatisfied.
 * - `invalid` — both sides are the same component, or one contains the other.
 * - `cycle` — the placement depends on itself through the component nesting.
 */
export type JointStatus = "ok" | "conflict" | "invalid" | "cycle";

export interface SolveResult {
    /** New local transforms for the components a joint drives. */
    readonly locals: Map<string, Matrix4>;
    readonly worlds: Map<string, Matrix4>;
    readonly status: Map<string, JointStatus>;
}

interface Drive {
    readonly joint: SolverJoint;
    /** True when component 1 is the known side and component 2 is placed from it. */
    readonly forward: boolean;
}

/**
 * Places the components the joints drive. The joints form a graph over the components; a
 * breadth-first walk from the fixed ones (the document root and every grounded component) turns
 * it into a tree — each component reached is placed from the joint it was reached through, so a
 * position is always computed from ground outward. A connected group with nothing fixed in it is
 * walked from the first component 1 its first joint names, which keeps its place: that is what
 * makes "component 2 moves to component 1".
 *
 * Every joint the walk does not use closes a loop; it is only checked, never solved for, so a
 * loop cannot make the solver iterate — an unsatisfied one is reported as `conflict`. Ordering is
 * the input order throughout, so the same document always solves the same way.
 */
export function solveAssembly(
    components: readonly SolverComponent[],
    joints: readonly SolverJoint[],
): SolveResult {
    const byId = new Map(components.map((c) => [c.id, c]));
    const status = new Map<string, JointStatus>();
    const valid = joints.filter((joint) => {
        const ok = isValidJoint(joint, byId);
        if (!ok) status.set(joint.id, "invalid");
        return ok;
    });
    const drives = walkJointTree(components, valid);
    const solver = new WorldSolver(byId, drives, status);
    for (const component of components) solver.world(component.id);
    for (const joint of valid) {
        if (status.has(joint.id)) continue;
        status.set(joint.id, solver.isTreeJoint(joint) || solver.holds(joint) ? "ok" : "conflict");
    }
    const locals = new Map<string, Matrix4>();
    for (const [id] of drives) {
        const component = byId.get(id)!;
        const parentWorld = component.between.multiply(solver.world(component.parentId ?? ROOT_COMPONENT));
        locals.set(id, solver.world(id).multiply(invertOrIdentity(parentWorld)));
    }
    return { locals, worlds: solver.worlds, status };
}

function isValidJoint(joint: SolverJoint, byId: Map<string, SolverComponent>): boolean {
    const { component1: a, component2: b } = joint;
    if (a === b) return false;
    if (a !== ROOT_COMPONENT && !byId.has(a)) return false;
    if (b !== ROOT_COMPONENT && !byId.has(b)) return false;
    return !nests(a, b, byId) && !nests(b, a, byId);
}

/** Whether component `outer` contains component `inner` (the root contains everything but is fixed). */
function nests(outer: string, inner: string, byId: Map<string, SolverComponent>): boolean {
    if (outer === ROOT_COMPONENT) return false;
    for (let id = byId.get(inner)?.parentId; id !== undefined; id = byId.get(id)?.parentId) {
        if (id === outer) return true;
    }
    return false;
}

function walkJointTree(
    components: readonly SolverComponent[],
    joints: readonly SolverJoint[],
): Map<string, Drive> {
    const incident = new Map<string, SolverJoint[]>();
    for (const joint of joints) {
        for (const id of [joint.component1, joint.component2]) {
            const list = incident.get(id) ?? [];
            list.push(joint);
            incident.set(id, list);
        }
    }
    const drives = new Map<string, Drive>();
    const visited = new Set<string>();
    const walk = (start: string[]) => {
        const queue = start.filter((id) => !visited.has(id));
        queue.forEach((id) => visited.add(id));
        while (queue.length > 0) {
            const known = queue.shift()!;
            for (const joint of incident.get(known) ?? []) {
                const forward = joint.component1 === known;
                const other = forward ? joint.component2 : joint.component1;
                if (visited.has(other)) continue;
                visited.add(other);
                drives.set(other, { joint, forward });
                queue.push(other);
            }
        }
    };
    walk([ROOT_COMPONENT, ...components.filter((c) => c.grounded).map((c) => c.id)]);
    for (const joint of joints) walk([joint.component1]);
    return drives;
}

class WorldSolver {
    readonly worlds = new Map<string, Matrix4>();
    private readonly inProgress = new Set<string>();

    constructor(
        private readonly byId: Map<string, SolverComponent>,
        private readonly drives: Map<string, Drive>,
        private readonly status: Map<string, JointStatus>,
    ) {}

    isTreeJoint(joint: SolverJoint): boolean {
        for (const drive of this.drives.values()) if (drive.joint === joint) return true;
        return false;
    }

    /** Whether the joint is satisfied by the placements as solved. */
    holds(joint: SolverJoint): boolean {
        const wanted = placeSecond(this.world(joint.component1), joint.frame1, joint.frame2, joint.motion);
        return wanted.equals(this.world(joint.component2));
    }

    world(id: string): Matrix4 {
        if (id === ROOT_COMPONENT) return Matrix4.identity();
        const known = this.worlds.get(id);
        if (known !== undefined) return known;
        const component = this.byId.get(id);
        if (component === undefined) return Matrix4.identity();
        if (this.inProgress.has(id)) {
            // Placing this component needs its own placement (a parent driven through its
            // child): break the loop at the current placement.
            const drive = this.drives.get(id);
            if (drive !== undefined) this.status.set(drive.joint.id, "cycle");
            return this.current(component);
        }
        this.inProgress.add(id);
        const world = this.solve(component);
        this.inProgress.delete(id);
        this.worlds.set(id, world);
        return world;
    }

    private solve(component: SolverComponent): Matrix4 {
        const drive = this.drives.get(component.id);
        if (drive === undefined || this.status.get(drive.joint.id) === "cycle") {
            return component.local.multiply(component.between).multiply(this.parentWorld(component));
        }
        const { joint, forward } = drive;
        if (forward) {
            return placeSecond(this.world(joint.component1), joint.frame1, joint.frame2, joint.motion);
        }
        return placeFirst(this.world(joint.component2), joint.frame1, joint.frame2, joint.motion);
    }

    private parentWorld(component: SolverComponent): Matrix4 {
        return this.world(component.parentId ?? ROOT_COMPONENT);
    }

    /** The placement as it stands, ancestors included, without solving anything. */
    private current(component: SolverComponent): Matrix4 {
        let world = component.local.multiply(component.between);
        for (let id = component.parentId; id !== undefined; id = this.byId.get(id)?.parentId) {
            const parent = this.byId.get(id);
            if (parent === undefined) break;
            world = world.multiply(parent.local).multiply(parent.between);
        }
        return world;
    }
}
