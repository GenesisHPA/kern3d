// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type IDocument, NodeUtils, Transaction } from "@chili3d/core";
import { parseLaserJob } from "./laserData";
import { LaserNode } from "./laserNode";
import { defaultRotaryJob } from "./rotary";

export type LaserJobMode = "flat" | "rotary";

export function modeOf(node: LaserNode): LaserJobMode {
    return node.data.rotary?.enabled === true ? "rotary" : "flat";
}

/** A new, empty job in `document` for `mode`, added in one undo step. */
export function newLaserJob(document: IDocument, mode: LaserJobMode): LaserNode {
    const key = mode === "rotary" ? "laser.defaultName.rotary" : "laser.defaultName";
    const name = NodeUtils.generateName(document, I18n.translate(key));
    const node = new LaserNode({ document, name });
    if (mode === "rotary") {
        const job = parseLaserJob(undefined);
        job.rotary = { ...defaultRotaryJob(), enabled: true };
        node.content = JSON.stringify(job);
    }
    Transaction.execute(document, "laser.create", () => document.modelManager.addNode(node));
    return node;
}

let homeOpener: (() => void) | undefined;

/** The «Лазер» page registers how it is opened (the editor's «Режимы» button calls it). */
export function setLaserHomeOpener(open: () => void) {
    homeOpener = open;
}

export function openLaserHome() {
    homeOpener?.();
}
