// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    getCurrentApplication,
    I18n,
    type IApplication,
    type ICommand,
    type IDocument,
    NodeCategories,
    NodeUtils,
    PubSub,
    Transaction,
} from "@chili3d/core";
import { LaserEditor } from "./laserEditor";
import { type LaserJobMode, modeOf, newLaserJob } from "./laserJobs";
import { LaserNode } from "./laserNode";
import { showLaserHome } from "./laserStart";

function jobsOf(document: IDocument): LaserNode[] {
    return document.modelManager.findNodes((n) => n instanceof LaserNode) as LaserNode[];
}

/**
 * Opens the document's job for `mode` — the last one opened or edited in it, else its last
 * job of that mode, else a new one. (With no mode: the last job of either kind.)
 */
export function openLaserWorkspace(document: IDocument, mode?: LaserJobMode): LaserNode {
    const jobs = jobsOf(document).filter((n) => mode === undefined || modeOf(n) === mode);
    const lastId = LaserEditor.lastEdited(document);
    const job =
        jobs.find((n) => n.id === lastId) ?? jobs[jobs.length - 1] ?? newLaserJob(document, mode ?? "flat");
    LaserEditor.open(job);
    return job;
}

/** «2D-гравировка»: a job on the flat bed. */
@command({
    key: "laser.flat",
    icon: "icon-layer-group",
})
export class FlatLaserJob implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (document !== undefined) openLaserWorkspace(document, "flat");
    }
}

/** «Гравировка на оси»: a job round a part in the rotary chuck, on its unrolled surface. */
@command({
    key: "laser.rotary",
    icon: "icon-history",
})
export class RotaryLaserJob implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (document !== undefined) openLaserWorkspace(document, "rotary");
    }
}

PubSub.default.sub("workspaceSelected", (workspace) => {
    if (workspace !== "ribbon.workspace.laser") return;
    // the page with the two modes, not a job: the user picks what to make
    if (getCurrentApplication().activeView?.document !== undefined) showLaserHome();
});

NodeCategories.register((node) => (node instanceof LaserNode ? "laser" : undefined));
