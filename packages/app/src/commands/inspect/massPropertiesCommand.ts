// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    Combobox,
    command,
    GetOrSelectNodeStep,
    I18n,
    type I18nKeys,
    type IDisposable,
    MeshDataUtils,
    PubSub,
    property,
    SelectNodeStep,
    type ShapeNode,
    VisualConfig,
    type XYZ,
} from "@chili3d/core";
import {
    formatNumber,
    InspectPanel,
    isInspectableBody,
    panelHeading,
    panelRow,
    worldShapeOf,
} from "./inspectUtils";
import {
    type BodyMassProperties,
    bodyMassProperties,
    combineMassProperties,
    DENSITY_PRESETS,
    type DensityPreset,
} from "./massProperties";

/** The material list of the density field; each item names a preset of `DENSITY_PRESETS`. */
export const MATERIAL_KEYS = {
    "inspect.material.pla": "PLA",
    "inspect.material.petg": "PETG",
    "inspect.material.abs": "ABS",
    "inspect.material.aluminium": "aluminium",
    "inspect.material.steel": "steel",
    "inspect.material.brass": "brass",
} as const satisfies Partial<Record<I18nKeys, DensityPreset>>;

export type MaterialKey = keyof typeof MATERIAL_KEYS;

const CENTER_OF_MASS_COLOR = 0xff6a00;

@command({
    key: "inspect.massProperties",
    icon: "icon-measureSelect",
})
export class MassPropertiesCommand extends CancelableCommand {
    #panel?: InspectPanel;
    /** Per-body readings at density 1 g/cm³: a density edit rescales them, no kernel call. */
    #bodies: BodyMassProperties[] = [];
    readonly #markers = new Set<IDisposable>();

    @property("inspect.material", {
        combobox: Combobox.from(Object.keys(MATERIAL_KEYS) as MaterialKey[]),
    })
    get material(): MaterialKey {
        return this.getPrivateValue("material", "inspect.material.pla");
    }
    set material(value: MaterialKey) {
        this.setProperty("material", value, () => {
            this.density = DENSITY_PRESETS[MATERIAL_KEYS[value]];
        });
    }

    /** g/cm³ */
    @property("inspect.density")
    get density(): number {
        return this.getPrivateValue("density", DENSITY_PRESETS.PLA);
    }
    set density(value: number) {
        this.setProperty("density", value, () => this.render());
    }

    protected override async executeAsync(): Promise<void> {
        let step = new GetOrSelectNodeStep("prompt.select.models", {
            multiple: true,
            filter: { allow: isInspectableBody },
        });
        while (true) {
            this.controller = new AsyncController();
            const data = await step.execute(this.document, this.controller);
            if (this.controller.result?.status !== "success" || !data?.nodes?.length) {
                if (this.#bodies.length === 0) PubSub.default.pub("showToast", "toast.select.noSelected");
                return;
            }
            this.measure(data.nodes.filter(isInspectableBody));
            step = new SelectNodeStep("prompt.select.models", {
                multiple: true,
                filter: { allow: isInspectableBody },
            });
        }
    }

    private measure(nodes: ShapeNode[]) {
        this.#bodies = nodes.map((node) => {
            const shape = worldShapeOf(node);
            const props = bodyMassProperties(node.name, shape, 1);
            shape.dispose();
            return props;
        });
        this.render();
    }

    private render() {
        this.clearMarkers();
        if (this.#bodies.length === 0) return;
        const bodies = this.#bodies.map((body) => ({ ...body, mass: body.mass * this.density }));
        const total = combineMassProperties(I18n.translate("inspect.total"), bodies);
        this.#panel ??= new InspectPanel(this.application.activeView);
        const rows = bodies.length > 1 ? bodies.flatMap((body) => this.bodyRows(body, true)) : [];
        this.#panel.set(
            I18n.translate("command.inspect.massProperties"),
            panelRow(I18n.translate("inspect.density"), `${formatNumber(this.density, 3)} g/cm³`),
            ...this.bodyRows(total, bodies.length > 1),
            ...rows,
        );
        if (total.centroid) this.markCenterOfMass(total.centroid);
    }

    private bodyRows(body: BodyMassProperties, heading: boolean): HTMLElement[] {
        const size = {
            x: body.box.max.x - body.box.min.x,
            y: body.box.max.y - body.box.min.y,
            z: body.box.max.z - body.box.min.z,
        };
        const c = body.centroid;
        return [
            ...(heading ? [panelHeading(body.name)] : []),
            panelRow(I18n.translate("inspect.mass"), `${formatNumber(body.mass)} g`),
            panelRow(I18n.translate("common.volume"), `${formatNumber(body.volume)} mm³`),
            panelRow(I18n.translate("common.area"), `${formatNumber(body.area)} mm²`),
            panelRow(
                I18n.translate("inspect.boundingBox"),
                `${formatNumber(size.x)} × ${formatNumber(size.y)} × ${formatNumber(size.z)} mm`,
            ),
            panelRow(
                I18n.translate("inspect.centerOfMass"),
                c ? `${formatNumber(c.x)}, ${formatNumber(c.y)}, ${formatNumber(c.z)}` : "—",
            ),
        ];
    }

    private markCenterOfMass(point: XYZ) {
        const context = this.document.visual.context;
        const id = context.displayMesh(
            [MeshDataUtils.createVertexMesh(point, VisualConfig.editVertexSize * 1.5, CENTER_OF_MASS_COLOR)],
            { onTop: true },
        );
        const label = this.application.activeView?.htmlText(
            I18n.translate("inspect.centerOfMass.short"),
            point,
            {
                hideDelete: true,
                onDispose: () => context.removeMesh(id),
            },
        );
        if (label) {
            this.#markers.add(label);
        } else {
            this.#markers.add({ dispose: () => context.removeMesh(id) });
        }
    }

    private clearMarkers() {
        this.#markers.forEach((marker) => marker.dispose());
        this.#markers.clear();
    }

    protected override afterExecute(): void {
        super.afterExecute();
        this.clearMarkers();
        this.#panel?.remove();
        this.#panel = undefined;
    }
}
