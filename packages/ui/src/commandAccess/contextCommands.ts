// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type CommandKeys, CommandStore } from "@chili3d/core";

/** The context list under the wedges: what applies to the object that was clicked. */
const CONTEXT_COMMANDS: Record<string, readonly CommandKeys[]> = {
    body: [
        "feature.fillet",
        "feature.chamfer",
        "feature.shell",
        "modify.moveCopy",
        "modify.align",
        "modify.paintBucket",
        "inspect.massProperties",
        "modify.deleteNode",
    ],
    sketch: ["sketch.enter", "feature.extrude", "feature.revolve", "modify.deleteNode"],
    construction: ["sketch.create", "modify.deleteNode"],
    none: ["sketch.create", "file.import", "inspect.section", "edit.redo"],
};

/**
 * The commands that apply to an object of a browser category ("body", "sketch", … or "none"
 * for empty space): the canvas menu's list and the model tree's right-click menu.
 */
export function contextCommandsOf(category: string): CommandKeys[] {
    return (CONTEXT_COMMANDS[category] ?? CONTEXT_COMMANDS["body"]).filter(
        (c) => CommandStore.getComandData(c) !== undefined,
    );
}
