// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    I18n,
    type IApplication,
    type ICommand,
    NodeCategories,
    NodeUtils,
    PubSub,
    Transaction,
} from "@chili3d/core";
import { LaserEditor } from "./laserEditor";
import { LaserNode } from "./laserNode";

/** A new, empty laser job in the document, opened on the bed. */
@command({
    key: "laser.create",
    icon: "icon-layer-group",
})
export class CreateLaserJob implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (document === undefined) return;
        const name = NodeUtils.generateName(document, I18n.translate("laser.defaultName"));
        const node = new LaserNode({ document, name });
        Transaction.execute(document, "laser.create", () => document.modelManager.addNode(node));
        LaserEditor.open(node);
    }
}

/** Opens the selected laser job; a double-click on one in the tree does the same. */
@command({
    key: "laser.open",
    icon: "icon-edit",
})
export class OpenLaserJob implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        const node = document?.selection.getSelectedNodes().find((n) => n instanceof LaserNode);
        if (node === undefined) {
            PubSub.default.pub("showToast", "toast.laser.selectJob");
            return;
        }
        LaserEditor.open(node as LaserNode);
    }
}

PubSub.default.sub("nodeDoubleClicked", (node) => {
    if (node instanceof LaserNode) LaserEditor.open(node);
});

NodeCategories.register((node) => (node instanceof LaserNode ? "laser" : undefined));
