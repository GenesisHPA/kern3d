// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    getCurrentApplication,
    type IApplication,
    type ICommand,
    type IDocument,
    NodeCategories,
    PubSub,
} from "@chili3d/core";
import { MillNode, newMillJob } from "./camData";
import { MillEditor } from "./camEditor";

function jobsOf(document: IDocument): MillNode[] {
    return document.modelManager.findNodes((n) => n instanceof MillNode) as MillNode[];
}

/** The document's milling job opened last, else its last one, else a new one. */
export function openMillWorkspace(document: IDocument) {
    const jobs = jobsOf(document);
    const job = jobs.find((n) => n.id === MillEditor.lastOpened) ?? jobs.at(-1) ?? newMillJob(document);
    MillEditor.open(job);
}

/** «Фрезеровка»: the document's milling job. */
@command({ key: "mill.open", icon: "icon-layer-group" })
export class OpenMill implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (document !== undefined) openMillWorkspace(document);
    }
}

/** «Новое задание»: another milling job in the document. */
@command({ key: "mill.new", icon: "icon-plus" })
export class NewMill implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (document !== undefined) MillEditor.open(newMillJob(document));
    }
}

PubSub.default.sub("workspaceSelected", (workspace) => {
    if (workspace !== "ribbon.workspace.mill") return;
    const document = getCurrentApplication().activeView?.document;
    if (document !== undefined) openMillWorkspace(document);
});

NodeCategories.register((node) => (node instanceof MillNode ? "laser" : undefined));
