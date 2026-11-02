// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, type INode, type IShape, type IView, ShapeNode } from "@chili3d/core";
import { div } from "@chili3d/element";
import style from "./inspect.module.css";

/** A model body the inspect tools read: a shape node with a shape that is not reference geometry. */
export function isInspectableBody(node: INode): node is ShapeNode {
    return node instanceof ShapeNode && !node.isReferenceGeometry && node.shape.isOk;
}

/** The body's shape placed in world space — a new shape the caller disposes. */
export function worldShapeOf(node: ShapeNode): IShape {
    return node.shape.value.transformedMul(node.worldTransform());
}

/** Bodies drawn in the document's tree (component definitions are drawn through their instances). */
export function visibleBodies(document: IDocument): ShapeNode[] {
    return document.modelManager
        .findNodes((node) => isInspectableBody(node) && node.visible && node.parentVisible)
        .filter(isInspectableBody);
}

/** Millimetre readings with two decimals, the precision `measure.select` shows. */
export function formatNumber(value: number, digits = 2): string {
    return value.toFixed(digits);
}

/**
 * The floating result card the inspect tools draw over the viewport (top left, like the
 * measure tool's sum), kept while the tool runs and removed with it.
 */
export class InspectPanel {
    readonly root: HTMLDivElement;

    constructor(view: IView | undefined) {
        this.root = div({ className: style.panel });
        view?.dom?.append(this.root);
    }

    set(title: string, ...rows: HTMLElement[]) {
        this.root.replaceChildren(div({ className: style.title, textContent: title }), ...rows);
    }

    remove() {
        this.root.remove();
    }
}

/** One label/value line of a panel. */
export function panelRow(label: string, value: string, className?: string): HTMLDivElement {
    return div(
        { className: className ? `${style.row} ${className}` : style.row },
        div({ className: style.label, textContent: label }),
        div({ className: style.value, textContent: value }),
    );
}

/** A sub-heading inside a panel (one body of several, one interfering pair). */
export function panelHeading(text: string): HTMLDivElement {
    return div({ className: style.heading, textContent: text });
}

export { style as inspectStyle };
