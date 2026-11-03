// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AssemblyComponentNode,
    command,
    I18n,
    type IApplication,
    type ICommand,
    type IDocument,
    type INode,
    type INodeLinkedList,
    isConsumedTool,
    NodeUtils,
    PubSub,
    Transaction,
} from "@chili3d/core";

/**
 * The nodes a New Component takes in: the selection's top-level nodes, minus the consumed
 * boolean tools (their body owns them).
 */
export function componentCandidates(nodes: readonly INode[]): INode[] {
    return NodeUtils.findTopLevelNodes(new Set(nodes)).filter((node) => !isConsumedTool(node));
}

/**
 * Makes a component — empty, or holding `nodes` — next to the first of them (or in the current
 * folder). The nodes keep their order. Call inside a transaction.
 */
export function createComponent(document: IDocument, nodes: readonly INode[]): AssemblyComponentNode {
    const name = NodeUtils.generateName(document, I18n.translate("assembly.component"));
    const component = new AssemblyComponentNode({ document, name });
    const first = nodes[0];
    const parent: INodeLinkedList | undefined = first?.parent;
    if (first !== undefined && parent !== undefined) {
        parent.insertBefore(first, component);
    } else {
        document.modelManager.addNode(component);
    }
    for (const node of nodes) {
        node.parent?.move(node, component, component.lastChild);
    }
    return component;
}

/**
 * Fusion's New Component: the selected bodies (sketches, planes, components…) move into a new
 * component; with nothing selected the component starts empty and becomes the active one, so
 * the next bodies are created inside it.
 */
@command({ key: "assemble.newComponent", icon: "icon-group" })
export class NewComponentCommand implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (document === undefined) return;
        const nodes = componentCandidates(document.selection.getSelectedNodes());
        let component: AssemblyComponentNode | undefined;
        Transaction.execute(document, "new component", () => {
            component = createComponent(document, nodes);
        });
        if (component === undefined) return;
        if (nodes.length === 0) document.modelManager.currentNode = component;
        document.selection.setSelectedNodes([component], false);
        document.visual.update();
    }
}

/**
 * Makes the selected component the active one — where new nodes go — or, with none selected,
 * the document root again.
 */
@command({ key: "assemble.activateComponent", icon: "icon-folder-open" })
export class ActivateComponentCommand implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (document === undefined) return;
        const selected = document.selection
            .getSelectedNodes()
            .find((n) => n instanceof AssemblyComponentNode);
        const target = selected ?? document.modelManager.rootNode;
        document.modelManager.currentNode = target;
        PubSub.default.pub("showToast", "assembly.activated:{0}", target.name);
    }
}
