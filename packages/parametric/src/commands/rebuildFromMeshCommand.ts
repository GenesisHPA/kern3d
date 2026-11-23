// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    command,
    EditableShapeNode,
    I18n,
    type IApplication,
    type ICommand,
    type INode,
    type IProgress,
    PubSub,
    runWithProgress,
    subProgress,
    Transaction,
} from "@chili3d/core";
import { ParametricBodyNode } from "../parametricBodyNode";
import { rebuildPart } from "../stlRebuild/rebuild";
import { sourceTriangles } from "../stlRebuild/sourceMesh";
import { trianglesOf } from "../stlRebuild/verify";

/** A rebuild further off the part than this is not kept: it would mislead more than help. */
export const KEEP_BELOW = 0.05;

/** A body this works on: imported (an STL's or a STEP's solid) and not built on yet. */
function rebuildable(node: INode): node is ParametricBodyNode | EditableShapeNode {
    if (node instanceof EditableShapeNode) return node.shape.isOk;
    return (
        node instanceof ParametricBodyNode &&
        node.shape.isOk &&
        node.features.length === 1 &&
        node.features[0].type === "imported"
    );
}

/**
 * "Перестроить операциями": an imported part rebuilt as a body of its own features — sketches
 * extruded along the part's main axis, round holes cut on their own, then what is still off
 * (side holes, pockets, bosses on other faces) rebuilt along its own axes (`rebuildPart`). The
 * new body takes the original's place in the tree; the original stays, hidden, for comparison.
 * A rebuild more than `KEEP_BELOW` off the part is discarded and says so.
 */
@command({ key: "modify.rebuildFromMesh", icon: "icon-history" })
export class RebuildFromMeshCommand implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (document === undefined) return;
        let nodes = document.selection.getSelectedNodes().filter(rebuildable);
        if (nodes.length === 0) {
            const picked = await document.picker.pickNode("prompt.select.models", new AsyncController(), {
                multi: true,
                nodeFilter: { allow: rebuildable },
            });
            nodes = picked.filter(rebuildable);
        }
        if (nodes.length === 0) {
            PubSub.default.pub("showToast", "toast.recoverCylinders.none");
            return;
        }
        void runWithProgress(async (progress) => {
            const kept: number[] = [];
            const dropped: number[] = [];
            await Transaction.executeAsync(document, "modify.rebuildFromMesh", async () => {
                for (const [index, node] of nodes.entries()) {
                    progress.throwIfCancelled();
                    const shape = node.shape.value;
                    const triangles = sourceTriangles(node.id) ?? trianglesOf(shape);
                    // several parts share the bar; each gets its slice, its name in the stage
                    const part = subProgress(progress, index / nodes.length, (index + 1) / nodes.length);
                    const named: IProgress =
                        nodes.length === 1
                            ? part
                            : {
                                  report: (fraction, stage, ...args) =>
                                      part.report(
                                          fraction,
                                          stage === undefined ? undefined : "stl.stage.part{0}{1}{2}",
                                          index + 1,
                                          nodes.length,
                                          stage === undefined ? "" : I18n.translate(stage, ...args),
                                      ),
                                  get cancelled() {
                                      return part.cancelled;
                                  },
                                  throwIfCancelled: () => part.throwIfCancelled(),
                              };
                    const report = await rebuildPart(document, triangles, shape, node.name, {
                        progress: named,
                    });
                    const model = report.model;
                    if (model === undefined) {
                        dropped.push(1);
                        continue;
                    }
                    if (report.error !== undefined || report.ratio > KEEP_BELOW) {
                        for (const n of [model.body, ...model.sketches]) n.parent?.remove(n);
                        dropped.push(report.ratio);
                        continue;
                    }
                    // the rebuild right after the original, which is hidden
                    const parent = node.parent;
                    if (parent !== undefined) {
                        let anchor: INode = node;
                        for (const n of [model.body, ...model.sketches]) {
                            n.parent?.remove(n);
                            parent.insertAfter(anchor, n);
                            anchor = n;
                        }
                    }
                    node.visible = false;
                    kept.push(report.ratio);
                }
            }).finally(() => document.visual.update());
            if (kept.length > 0) {
                const worst = Math.max(...kept) * 100;
                PubSub.default.pub("showToast", "toast.rebuildFromMesh{0}{1}", kept.length, worst.toFixed(2));
            }
            if (dropped.length > 0) {
                const best = Math.min(...dropped) * 100;
                PubSub.default.pub("showToast", "toast.rebuildFromMesh.failed{0}", best.toFixed(1));
            }
        }, "command.modify.rebuildFromMesh");
    }
}
