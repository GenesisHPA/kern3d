// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    command,
    GetOrSelectNodeStep,
    I18n,
    PubSub,
    SelectNodeStep,
    type ShapeMeshData,
    type ShapeNode,
} from "@chili3d/core";
import {
    formatNumber,
    InspectPanel,
    inspectStyle,
    isInspectableBody,
    panelRow,
    worldShapeOf,
} from "./inspectUtils";
import { findInterferences, type Interference } from "./interference";

const OVERLAP_COLOR = 0xff2d2d;

/**
 * Lists every pair of the picked bodies that share volume and shows the shared regions in
 * red, drawn over the model so an overlap buried inside a part stays visible. Nothing in the
 * model changes; the highlights and the card go away with the tool (Esc).
 */
@command({
    key: "inspect.interference",
    icon: "icon-booleanCommon",
})
export class InterferenceCommand extends CancelableCommand {
    #panel?: InspectPanel;
    #meshId?: number;

    protected override async executeAsync(): Promise<void> {
        let step = new GetOrSelectNodeStep("prompt.select.models", {
            multiple: true,
            filter: { allow: isInspectableBody },
        });
        while (true) {
            this.controller = new AsyncController();
            const data = await step.execute(this.document, this.controller);
            if (this.controller.result?.status !== "success" || !data?.nodes?.length) return;
            const nodes = data.nodes.filter(isInspectableBody);
            if (nodes.length < 2) {
                PubSub.default.pub("showToast", "inspect.interference.needTwo");
            } else {
                this.check(nodes);
            }
            step = new SelectNodeStep("prompt.select.models", {
                multiple: true,
                filter: { allow: isInspectableBody },
            });
        }
    }

    private check(nodes: ShapeNode[]) {
        this.clearHighlight();
        const shapes = nodes.map(worldShapeOf);
        const found = findInterferences(shapes);
        shapes.forEach((shape) => shape.dispose());
        this.highlight(found);
        this.showResult(nodes, found);
    }

    private highlight(found: Interference[]) {
        const meshes: ShapeMeshData[] = [];
        for (const item of found) {
            const { faces, edges } = item.overlap.mesh;
            if (faces) {
                faces.color = OVERLAP_COLOR;
                meshes.push(faces);
            }
            if (edges) {
                edges.color = OVERLAP_COLOR;
                meshes.push(edges);
            }
            item.overlap.dispose();
        }
        if (meshes.length > 0) {
            this.#meshId = this.document.visual.context.displayMesh(meshes, {
                onTop: true,
                meshOpacity: 0.85,
            });
            this.document.visual.update();
        }
    }

    private showResult(nodes: ShapeNode[], found: Interference[]) {
        this.#panel ??= new InspectPanel(this.application.activeView);
        const rows =
            found.length === 0
                ? [panelRow(I18n.translate("inspect.interference.none"), "", inspectStyle.ok)]
                : found.map((item) =>
                      panelRow(
                          `${nodes[item.first].name} ↔ ${nodes[item.second].name}`,
                          `${formatNumber(item.volume)} mm³`,
                          inspectStyle.warning,
                      ),
                  );
        this.#panel.set(
            I18n.translate("command.inspect.interference"),
            panelRow(I18n.translate("inspect.interference.bodies"), String(nodes.length)),
            panelRow(I18n.translate("inspect.interference.pairs"), String(found.length)),
            ...rows,
        );
    }

    private clearHighlight() {
        if (this.#meshId !== undefined) {
            this.document.visual.context.removeMesh(this.#meshId);
            this.document.visual.update();
            this.#meshId = undefined;
        }
    }

    protected override afterExecute(): void {
        super.afterExecute();
        this.clearHighlight();
        this.#panel?.remove();
        this.#panel = undefined;
    }
}
