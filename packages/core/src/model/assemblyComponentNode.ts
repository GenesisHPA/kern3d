// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { BoundingBox, Matrix4 } from "../math";
import { property } from "../property";
import { serializable, serialize } from "../serialize";
import type { FolderNodeOptions } from "./folderNode";
import { GroupNode } from "./groupNode";
import type { INode } from "./node";
import type { TransformMode } from "./visualNode";

export interface AssemblyComponentNodeOptions extends FolderNodeOptions {
    grounded?: boolean;
}

/**
 * A classic-CAD-style assembly component: a group with its own placement that holds bodies, sketches,
 * planes and further components. Everything inside lives in the component's local space — the
 * renderer composes the component's `transform` onto its children — so moving a component moves
 * all it contains without touching their definitions.
 *
 * It is a `GroupNode`, so the viewport, the project tree and the matrix editor already treat it
 * as one; what it adds is the assembly state: `grounded` (fixed in place — the root of the joint
 * tree) and the placement hooks the Move/Align commands drive. The persisted shape is a group's
 * plus `grounded`, which is absent (false) on documents written before components existed.
 *
 * Unrelated to `Component`/`ComponentNode`, the block definition + insert of the drawing tools.
 */
@serializable()
export class AssemblyComponentNode extends GroupNode {
    constructor(options: AssemblyComponentNodeOptions) {
        super(options);
        if (options.grounded) this.setPrivateValue("grounded", true);
    }

    /** `INodeIcon`: a pin while the component is grounded, the group glyph otherwise. */
    override get icon(): string {
        return this.grounded ? "icon-lock" : "icon-group";
    }

    @serialize()
    @property("assembly.grounded")
    get grounded(): boolean {
        return this.getPrivateValue("grounded", false);
    }
    set grounded(value: boolean) {
        const oldIcon = this.icon;
        this.setProperty("grounded", value, () => {
            // The row's type icon follows the grounded state.
            this.emitPropertyChanged("icon" as keyof this, oldIcon as never);
        });
    }

    /** The Move/Align gate (`isPlaceableNode`): a component takes a direct matrix. */
    get transformMode(): TransformMode {
        return "direct";
    }

    /**
     * Applies a WORLD-space incremental move: the component's world placement becomes
     * `world · delta`, written back into its local transform under the parent groups.
     */
    applyTransform(delta: Matrix4): boolean {
        const parent = ancestorTransform(this);
        const inverse = parent.invert();
        if (inverse === undefined) return false;
        this.transform = this.transform.multiply(parent).multiply(delta).multiply(inverse);
        return true;
    }

    /** The contents' bounds in the component's parent space. */
    boundingBox(): BoundingBox | undefined {
        let box: BoundingBox | undefined;
        for (let child = this.firstChild; child !== undefined; child = child.nextSibling) {
            const next = (child as { boundingBox?: () => BoundingBox | undefined }).boundingBox?.();
            if (next !== undefined) box = box === undefined ? next : BoundingBox.combine(box, next);
        }
        return box === undefined ? undefined : BoundingBox.transformed(box, this.transform);
    }
}

export function isAssemblyComponent(node: unknown): node is AssemblyComponentNode {
    return node instanceof AssemblyComponentNode;
}

/** The nearest component holding `node` (not `node` itself), or undefined at the document root. */
export function owningComponent(node: INode): AssemblyComponentNode | undefined {
    for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
        if (parent instanceof AssemblyComponentNode) return parent;
    }
    return undefined;
}

/**
 * The placement every group above `node` composes onto it — the product of the ancestors'
 * transforms, innermost first. `until` stops below that ancestor (exclusive), so the result is
 * `node`'s parent space expressed in `until`'s local space.
 */
export function ancestorTransform(node: INode, until?: INode): Matrix4 {
    let result = Matrix4.identity();
    for (let parent = node.parent; parent !== undefined && parent !== until; parent = parent.parent) {
        if (parent instanceof GroupNode) result = result.multiply(parent.transform);
    }
    return result;
}

/** Whether `ancestor` is `node` or contains it. */
export function isSelfOrAncestor(ancestor: INode, node: INode): boolean {
    for (let current: INode | undefined = node; current !== undefined; current = current.parent) {
        if (current === ancestor) return true;
    }
    return false;
}
