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
    PubSub,
    Result,
    Transaction,
} from "@chili3d/core";
import { ParametricBodyNode } from "../parametricBodyNode";
import { mergePlanarFaces, recoverCylindersChecked } from "./meshToSolid";

/** How long one body's recovery may run: a large STL part has many runs to try. */
const BUDGET_MS = 180_000;

/** A body this works on: imported and not built on yet (later features name its faces). */
function recoverable(node: INode): node is ParametricBodyNode | EditableShapeNode {
    if (node instanceof EditableShapeNode) return node.shape.isOk;
    return (
        node instanceof ParametricBodyNode &&
        node.shape.isOk &&
        node.features.length === 1 &&
        node.features[0].type === "imported"
    );
}

/**
 * "Распознать цилиндры": an imported part's faceted holes, bosses, shafts and rounds (an STL's)
 * replaced by exact cylinders — what import does by itself for small parts, here for large ones,
 * which take up to three minutes (run it again to go on). A body already built on is left alone: its later
 * features are anchored to the faces this would rebuild.
 */
@command({ key: "modify.recoverCylinders", icon: "icon-cylinder" })
export class RecoverCylindersCommand implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (document === undefined) return;
        let nodes = document.selection.getSelectedNodes().filter(recoverable);
        if (nodes.length === 0) {
            const picked = await document.picker.pickNode("prompt.select.models", new AsyncController(), {
                multi: true,
                nodeFilter: { allow: recoverable },
            });
            nodes = picked.filter(recoverable);
        }
        if (nodes.length === 0) {
            PubSub.default.pub("showToast", "toast.recoverCylinders.none");
            return;
        }
        PubSub.default.pub(
            "showPermanent",
            async () => {
                // let the toast paint before the kernel holds the thread
                await new Promise((resolve) => setTimeout(resolve, 50));
                let changed = 0;
                Transaction.execute(document, "modify.recoverCylinders", () => {
                    for (const node of nodes) {
                        const shape = node.shape.value;
                        const recovered = recoverCylindersChecked(shape, BUDGET_MS);
                        if (recovered === shape) continue;
                        const merged = mergePlanarFaces(recovered);
                        if (node instanceof EditableShapeNode) {
                            node.shape = Result.ok(merged);
                        } else {
                            const brep = shapeConverter.convertToBrep(merged);
                            if (!brep.isOk) continue;
                            node.setFeaturesEmitShapeChanged([
                                { ...node.features[0], brep: brep.value } as never,
                            ]);
                        }
                        changed++;
                    }
                });
                document.visual.update();
                PubSub.default.pub("showToast", "toast.recoverCylinders{0}", changed);
            },
            "toast.excuting{0}",
            I18n.translate("command.modify.recoverCylinders"),
        );
    }
}
