// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    command,
    I18n,
    type IApplication,
    type ICommand,
    type IDocument,
    type INode,
    isReferenceGeometryNode,
    NodeCategories,
    NodeUtils,
    PubSub,
    ShapeNode,
    Transaction,
} from "@chili3d/core";
import { DrawingEditor } from "./drawingEditor";
import { DrawingNode } from "./drawingNode";
import { layoutStandardViews, resolveSource, ViewGeometryCache } from "./drawingViews";

function isBody(node: INode): node is ShapeNode {
    return node instanceof ShapeNode && !isReferenceGeometryNode(node) && node.shape.isOk;
}

async function pickBody(document: IDocument): Promise<ShapeNode | undefined> {
    const selected = document.selection.getSelectedNodes().find(isBody);
    if (selected !== undefined) return selected;
    const controller = new AsyncController();
    const picked = await document.picker.pickNode("prompt.select.models", controller, {
        multi: false,
        nodeFilter: { allow: isBody },
    });
    return picked.find(isBody);
}

/**
 * A new drawing of `body`: an A3 sheet with the ГОСТ title block and the three standard views
 * in first-angle projection, at the largest standard scale that fits.
 */
export function createDrawingOf(document: IDocument, body: ShapeNode): DrawingNode {
    const name = NodeUtils.generateName(document, I18n.translate("drawing.defaultName"));
    const node = new DrawingNode({ document, name });
    const data = node.data;
    data.titleBlock.fields.name = body.name;
    data.titleBlock.fields.date = new Date().toLocaleDateString("ru-RU", {
        month: "2-digit",
        year: "2-digit",
    });
    const cache = new ViewGeometryCache((id) => resolveSource(document, id));
    layoutStandardViews(data, body.id, (view) => cache.geometryOf(view));
    node.setData(data);
    return node;
}

/** "Drawing from design": the picked (or selected) body, laid out and opened. */
@command({
    key: "drawing.create",
    icon: "icon-file-plus",
})
export class CreateDrawing implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (document === undefined) return;
        const body = await pickBody(document);
        if (body === undefined) {
            PubSub.default.pub("showToast", "toast.drawing.selectBody");
            return;
        }
        const node = createDrawingOf(document, body);
        Transaction.execute(document, "drawing.create", () => document.modelManager.addNode(node));
        DrawingEditor.open(node);
    }
}

/** Opens the selected drawing; a double-click on a drawing in the tree does the same. */
@command({
    key: "drawing.open",
    icon: "icon-edit",
})
export class OpenDrawing implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        const node = document?.selection.getSelectedNodes().find((n) => n instanceof DrawingNode);
        if (node === undefined) {
            PubSub.default.pub("showToast", "toast.drawing.selectDrawing");
            return;
        }
        DrawingEditor.open(node as DrawingNode);
    }
}

PubSub.default.sub("nodeDoubleClicked", (node) => {
    if (node instanceof DrawingNode) DrawingEditor.open(node);
});

// The browser lists drawings in a section of their own.
NodeCategories.register((node) => (node instanceof DrawingNode ? "drawing" : undefined));
