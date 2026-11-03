// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AssemblyComponentNode,
    ancestorTransform,
    type IDocument,
    type INode,
    isPropertyChanged,
    Logger,
    Matrix4,
    type NodeRecord,
    owningComponent,
    Transaction,
} from "@chili3d/core";
import {
    type JointStatus,
    ROOT_COMPONENT,
    type SolveResult,
    type SolverComponent,
    type SolverJoint,
    solveAssembly,
} from "./assemblySolver";
import { frameMatrix, jointMotionMatrix } from "./jointMath";
import { JointNode, jointCreatedHooks } from "./jointNode";
import { type JointOriginRef, resolveJointOrigin } from "./jointOrigin";

/** A joint origin placed in its component's local space. */
export interface PlacedJointOrigin {
    /** The component holding the origin; `ROOT_COMPONENT` at the document root. */
    readonly componentId: string;
    /** Origin frame → component local space. */
    readonly frame: Matrix4;
    readonly lost: boolean;
}

/** The transform from a node's own (shape) space into its component's local space. */
export function nodeToComponent(node: INode, component: AssemblyComponentNode | undefined): Matrix4 {
    const own = (node as { transform?: Matrix4 }).transform ?? Matrix4.identity();
    return own.multiply(ancestorTransform(node, component));
}

/** The world placement of a node's own space, from the document tree alone (no viewport). */
export function nodeWorldTransform(node: INode): Matrix4 {
    return nodeToComponent(node, undefined);
}

/** Where a stored origin sits now: its component and the frame in that component's space. */
export function placeJointOrigin(document: IDocument, ref: JointOriginRef): PlacedJointOrigin | undefined {
    const resolved = resolveJointOrigin(document, ref);
    if (ref.kind === "fixed") {
        return { componentId: ref.nodeId, frame: frameMatrix(ref.frame), lost: false };
    }
    if (resolved.node === undefined) return undefined;
    const component = owningComponent(resolved.node);
    return {
        componentId: component?.id ?? ROOT_COMPONENT,
        frame: frameMatrix(resolved.frame).multiply(nodeToComponent(resolved.node, component)),
        lost: resolved.lost,
    };
}

function solverComponent(node: AssemblyComponentNode): SolverComponent {
    const parent = owningComponent(node);
    return {
        id: node.id,
        local: node.transform,
        between: ancestorTransform(node, parent),
        parentId: parent?.id,
        grounded: node.grounded,
    };
}

/**
 * Keeps one document's assembly solved: whenever a joint, a component's placement or grounding,
 * or the geometry a joint origin sits on changes, the joint tree is solved again and the driven
 * components are moved (`solveAssembly`). Writes made while a transaction is open join it, so a
 * joint edit and the motion it causes undo as one step. Undo and redo replay those records and
 * are not solved again; a write outside of any transaction (a command's live preview) is derived
 * state and is not recorded.
 */
export class AssemblyService {
    private static readonly services = new WeakMap<IDocument, AssemblyService>();

    static of(document: IDocument): AssemblyService {
        let service = AssemblyService.services.get(document);
        if (service === undefined) {
            service = new AssemblyService(document);
            AssemblyService.services.set(document, service);
        }
        return service;
    }

    private readonly watched = new Map<INode, (property: string) => void>();
    private solving = false;
    private syncQueued = false;

    private constructor(readonly document: IDocument) {
        document.modelManager.addNodeObserver(this.onNodesChanged);
        this.queueSync();
    }

    /** Re-watches on the next microtask — a document being loaded is not complete yet. */
    queueSync(): void {
        if (this.syncQueued) return;
        this.syncQueued = true;
        queueMicrotask(() => {
            this.syncQueued = false;
            if (this.document.modelManager === undefined) return;
            this.syncWatches();
        });
    }

    joints(): JointNode[] {
        return this.document.modelManager.findNodes((n) => n instanceof JointNode) as JointNode[];
    }

    components(): AssemblyComponentNode[] {
        return this.document.modelManager.findNodes(
            (n) => n instanceof AssemblyComponentNode,
        ) as AssemblyComponentNode[];
    }

    /** Solves now and moves the driven components. */
    solve(): SolveResult | undefined {
        // An undo/redo replays a recorded transaction, solver writes included: the state it
        // lands on is already solved, and solving half-way through would fight the records.
        const history = this.document.history;
        if (this.solving || history.isUndoing || history.isRedoing) return undefined;
        const joints = this.joints();
        if (joints.length === 0) return undefined;
        this.solving = true;
        try {
            const components = this.components();
            const lost = new Set<string>();
            const input = joints.map((joint) => this.solverJoint(joint, lost));
            const result = solveAssembly(
                components.map(solverComponent),
                input.filter((j): j is SolverJoint => j !== undefined),
            );
            this.apply(components, result);
            for (const joint of joints) {
                const status: JointStatus = result.status.get(joint.id) ?? "invalid";
                joint.setSolveState(status, lost.has(joint.id));
            }
            return result;
        } catch (error) {
            Logger.error("assembly solve failed", error);
            return undefined;
        } finally {
            this.solving = false;
        }
    }

    private solverJoint(joint: JointNode, lost: Set<string>): SolverJoint | undefined {
        const ref1 = joint.originRef(1);
        const ref2 = joint.originRef(2);
        if (ref1 === undefined || ref2 === undefined) return undefined;
        const origin1 = placeJointOrigin(this.document, ref1);
        const origin2 = placeJointOrigin(this.document, ref2);
        if (origin1 === undefined || origin2 === undefined) return undefined;
        if (origin1.lost || origin2.lost) lost.add(joint.id);
        return {
            id: joint.id,
            component1: origin1.componentId,
            component2: origin2.componentId,
            frame1: origin1.frame,
            frame2: origin2.frame,
            motion: jointMotionMatrix(joint.motion()),
        };
    }

    private apply(components: AssemblyComponentNode[], result: SolveResult) {
        const changes = components.filter((c) => {
            const local = result.locals.get(c.id);
            return local !== undefined && !local.equals(c.transform);
        });
        if (changes.length === 0) return;
        const write = () => {
            for (const component of changes) component.transform = result.locals.get(component.id)!;
        };
        if (Transaction.isActive(this.document)) {
            write();
            return;
        }
        const history = this.document.history;
        const disabled = history.disabled;
        history.disabled = true;
        try {
            write();
        } finally {
            history.disabled = disabled;
        }
        this.document.visual.update();
    }

    private readonly onNodesChanged = (_records: NodeRecord[]) => {
        this.syncWatches();
        this.solve();
    };

    /** Watches exactly the joints, the components and the nodes the joints' origins sit on. */
    private syncWatches() {
        const wanted = new Map<INode, (property: string) => void>();
        const joints = this.joints();
        for (const joint of joints) wanted.set(joint, this.onJointChanged);
        for (const component of this.components()) wanted.set(component, this.onComponentChanged);
        const ids = new Set<string>();
        for (const joint of joints) {
            for (const ref of [joint.originRef(1), joint.originRef(2)]) {
                if (ref !== undefined && ref.kind !== "fixed") ids.add(ref.nodeId);
            }
        }
        for (const node of this.document.modelManager.findNodes((n) => ids.has(n.id))) {
            if (!wanted.has(node)) wanted.set(node, this.onGeometryChanged);
        }
        for (const [node, handler] of this.watched) {
            if (wanted.get(node) === handler) continue;
            if (isPropertyChanged(node)) node.removePropertyChanged(handler);
            this.watched.delete(node);
        }
        for (const [node, handler] of wanted) {
            if (this.watched.has(node) || !isPropertyChanged(node)) continue;
            node.onPropertyChanged(handler);
            this.watched.set(node, handler);
        }
    }

    private readonly onJointChanged = (property: string) => {
        if (property === "name" || property === "warningCount" || property === "userData") return;
        if (property === "origin1" || property === "origin2") this.syncWatches();
        this.solve();
    };

    private readonly onComponentChanged = (property: string) => {
        if (property === "transform" || property === "grounded") this.solve();
    };

    private readonly onGeometryChanged = (property: string) => {
        if (property === "shape" || property === "transform") this.solve();
    };
}

/** Starts the per-document assembly solver (idempotent). */
export function ensureAssembly(document: IDocument): AssemblyService {
    return AssemblyService.of(document);
}

jointCreatedHooks.add((document) => {
    ensureAssembly(document).queueSync();
});
