// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ModelView } from "./fromModel";
import {
    DITHER_KINDS,
    type LaserJobData,
    type LaserObject,
    type LaserOperation,
    RASTER_MODES,
    type RasterSettings,
} from "./laserData";
import style from "./laserEditor.module.css";
import { button, checkbox, el, heading, numberField, row, select, t, textField } from "./laserUi";
import type { MachineProfile } from "./machineProfile";

/** What the job panel needs from the editor it sits in. */
export interface LaserJobPanelHost {
    readonly data: LaserJobData;
    readonly selection: string | undefined;
    readonly profile: MachineProfile;
    select(id: string | undefined): void;
    /** Applies `edit` to the selected object and writes the job back as one undo step. */
    editSelected(edit: (o: LaserObject) => void): void;
    move(id: string, delta: -1 | 1): void;
    setProfile(edit: (p: MachineProfile) => void): void;
    /** Bodies and drawings of the document, for "from the model". */
    modelSources(): { id: string; label: string; kind: "body" | "drawing" }[];
    addFromModel(sourceId: string, view: ModelView): void;
    pickFace(): void;
}

export const MODE_COLORS: Record<LaserOperation["mode"], string> = {
    line: "#e03131",
    fill: "#1971c2",
    image: "#495057",
};

/**
 * The side panel's job tab: the bed size, the objects in burn order, outlines taken from the
 * model, and the selected object's placement and operation. Rebuilt on every change — it is a
 * few dozen fields, and rebuilding keeps it honest after undo.
 */
export class LaserJobPanel {
    readonly element = el("div");
    private modelSource = "";
    private modelView: ModelView = "top";

    constructor(private readonly host: LaserJobPanelHost) {}

    render() {
        const focused = document.activeElement;
        const keepFocus = focused instanceof HTMLElement && this.element.contains(focused);
        const path = keepFocus ? focusPath(this.element, focused) : undefined;
        this.element.replaceChildren(
            ...this.bedSection(),
            ...this.objectsSection(),
            ...this.modelSection(),
            ...this.objectSection(),
        );
        if (path !== undefined) restoreFocus(this.element, path);
    }

    private bedSection(): HTMLElement[] {
        const p = this.host.profile;
        return [
            heading("laser.bed"),
            el(
                "div",
                { className: style.pair },
                row(
                    "laser.bedWidth",
                    numberField(p.bedWidth, (v) => this.host.setProfile((q) => (q.bedWidth = v)), { min: 1 }),
                ),
                row(
                    "laser.bedHeight",
                    numberField(p.bedHeight, (v) => this.host.setProfile((q) => (q.bedHeight = v)), {
                        min: 1,
                    }),
                ),
            ),
        ];
    }

    private objectsSection(): HTMLElement[] {
        const objects = this.host.data.objects;
        if (objects.length === 0)
            return [
                heading("laser.objects"),
                el("div", { className: style.muted, textContent: t("laser.noObjects") }),
            ];
        const list = el("div", { className: style.list });
        for (const o of objects) {
            const current = o.id === this.host.selection;
            list.append(
                el(
                    "div",
                    {
                        className: current ? `${style.listRow} ${style.current}` : style.listRow,
                        onclick: () => this.host.select(o.id),
                        title: t(`laser.mode.${o.op.mode}`),
                    },
                    el("div", { className: style.swatch, style: `background:${MODE_COLORS[o.op.mode]}` }),
                    el("div", {
                        className: style.name,
                        textContent: o.name,
                        style: o.hidden ? "text-decoration:line-through;opacity:.6" : "",
                    }),
                ),
            );
        }
        const selected = this.host.selection;
        const order =
            selected === undefined
                ? []
                : [
                      el(
                          "div",
                          { className: style.buttons },
                          button("laser.up", () => this.host.move(selected, -1)),
                          button("laser.down", () => this.host.move(selected, 1)),
                      ),
                  ];
        return [heading("laser.objects"), list, ...order];
    }

    private modelSection(): HTMLElement[] {
        const sources = this.host.modelSources();
        if (!sources.some((s) => s.id === this.modelSource)) this.modelSource = sources[0]?.id ?? "";
        const kind = sources.find((s) => s.id === this.modelSource)?.kind;
        const sourceSelect = select(
            sources.map((s) => ({ value: s.id, label: s.label })),
            this.modelSource,
            (v) => {
                this.modelSource = v;
                this.render();
            },
        );
        const views: ModelView[] = ["top", "front", "right"];
        const viewSelect = select(
            views.map((v) => ({ value: v, label: t(`laser.fromModel.${v}`) })),
            this.modelView,
            (v) => (this.modelView = v),
        );
        viewSelect.disabled = kind !== "body";
        const add = button("laser.fromModel.add", () =>
            this.host.addFromModel(this.modelSource, this.modelView),
        );
        add.disabled = sources.length === 0;
        return [
            heading("laser.fromModel"),
            row("laser.fromModel.source", sourceSelect),
            row("laser.fromModel.view", viewSelect),
            el(
                "div",
                { className: style.buttons },
                add,
                button("laser.fromModel.face", () => this.host.pickFace()),
            ),
        ];
    }

    private objectSection(): HTMLElement[] {
        const o = this.host.data.objects.find((x) => x.id === this.host.selection);
        if (o === undefined) return [];
        const edit = this.host.editSelected.bind(this.host);
        const aspect = o.height > 0 ? o.width / o.height : 1;
        return [
            heading("laser.object"),
            row(
                "laser.name",
                textField(o.name, (v) => edit((x) => (x.name = v))),
            ),
            el(
                "div",
                { className: style.pair },
                row(
                    "laser.x",
                    numberField(o.x, (v) => edit((x) => (x.x = v))),
                ),
                row(
                    "laser.y",
                    numberField(o.y, (v) => edit((x) => (x.y = v))),
                ),
            ),
            el(
                "div",
                { className: style.pair },
                row(
                    "laser.width",
                    numberField(
                        o.width,
                        (v) =>
                            edit((x) => {
                                x.width = v;
                                if (x.lockAspect) x.height = v / aspect;
                            }),
                        { min: 0.01 },
                    ),
                ),
                row(
                    "laser.height",
                    numberField(
                        o.height,
                        (v) =>
                            edit((x) => {
                                x.height = v;
                                if (x.lockAspect) x.width = v * aspect;
                            }),
                        { min: 0.01 },
                    ),
                ),
            ),
            row(
                "laser.angle",
                numberField(o.angle, (v) => edit((x) => (x.angle = v))),
            ),
            row(
                "laser.lockAspect",
                checkbox(o.lockAspect, (v) => edit((x) => (x.lockAspect = v))),
            ),
            row(
                "laser.hidden",
                checkbox(o.hidden === true, (v) => edit((x) => (x.hidden = v ? true : undefined))),
            ),
            ...this.operationSection(o),
        ];
    }

    private operationSection(o: LaserObject): HTMLElement[] {
        const op = o.op;
        const edit = (f: (op: LaserOperation) => void) => this.host.editSelected((x) => f(x.op));
        const modes = o.kind === "image" ? (["image"] as const) : (["line", "fill"] as const);
        const rows: HTMLElement[] = [
            heading("laser.operation"),
            row(
                "laser.mode",
                select(
                    modes.map((m) => ({ value: m, label: t(`laser.mode.${m}`) })),
                    op.mode,
                    (v) => edit((x) => (x.mode = v)),
                ),
            ),
            row(
                "laser.power",
                numberField(op.power, (v) => edit((x) => (x.power = v)), { min: 0, max: 100 }),
            ),
            row(
                "laser.speed",
                numberField(op.speed, (v) => edit((x) => (x.speed = v)), { min: 1 }),
            ),
            row(
                "laser.passes",
                numberField(op.passes, (v) => edit((x) => (x.passes = Math.round(v))), { min: 1, step: 1 }),
            ),
            row(
                "laser.air",
                checkbox(op.air, (v) => edit((x) => (x.air = v))),
            ),
        ];
        if (op.mode === "fill") {
            rows.push(
                row(
                    "laser.fillInterval",
                    numberField(op.fillInterval, (v) => edit((x) => (x.fillInterval = v)), { min: 0.01 }),
                ),
                row(
                    "laser.fillAngle",
                    numberField(op.fillAngle, (v) => edit((x) => (x.fillAngle = v))),
                ),
            );
        }
        if (op.mode === "image") rows.push(...this.rasterSection(op.raster));
        return rows;
    }

    private rasterSection(r: RasterSettings): HTMLElement[] {
        const edit = (f: (r: RasterSettings) => void) => this.host.editSelected((x) => f(x.op.raster));
        const rows: HTMLElement[] = [
            row(
                "laser.raster.mode",
                select(
                    RASTER_MODES.map((m) => ({ value: m, label: t(`laser.raster.${m}`) })),
                    r.mode,
                    (v) => edit((x) => (x.mode = v)),
                ),
            ),
        ];
        if (r.mode === "dither") {
            rows.push(
                row(
                    "laser.raster.algorithm",
                    select(
                        DITHER_KINDS.map((m) => ({ value: m, label: t(`laser.raster.${m}`) })),
                        r.dither,
                        (v) => edit((x) => (x.dither = v)),
                    ),
                ),
            );
        }
        const field = (key: string, value: number, set: (x: RasterSettings, v: number) => void, o = {}) =>
            row(
                key,
                numberField(value, (v) => edit((x) => set(x, v)), o),
            );
        rows.push(
            field("laser.raster.resolution", r.resolution, (x, v) => (x.resolution = v), {
                min: 0.5,
                max: 40,
            }),
            field("laser.raster.brightness", r.brightness, (x, v) => (x.brightness = v), {
                min: -100,
                max: 100,
                step: 1,
            }),
            field("laser.raster.contrast", r.contrast, (x, v) => (x.contrast = v), {
                min: -100,
                max: 100,
                step: 1,
            }),
            field("laser.raster.gamma", r.gamma, (x, v) => (x.gamma = v), { min: 0.1, max: 5, step: 0.1 }),
            row(
                "laser.raster.invert",
                checkbox(r.invert, (v) => edit((x) => (x.invert = v))),
            ),
        );
        if (r.mode === "threshold")
            rows.push(
                field("laser.raster.threshold.value", r.threshold, (x, v) => (x.threshold = v), {
                    min: 0,
                    max: 100,
                }),
            );
        if (r.mode === "grayscale") {
            rows.push(
                field("laser.raster.whiteClip", r.whiteClip, (x, v) => (x.whiteClip = v), {
                    min: 0,
                    max: 100,
                }),
                field("laser.raster.minPower", r.minPower, (x, v) => (x.minPower = v), { min: 0, max: 100 }),
            );
        }
        rows.push(
            field("laser.raster.overscan", r.overscan, (x, v) => (x.overscan = v), { min: 0, max: 50 }),
        );
        return rows;
    }
}

/** Where the focused field sits, so a rebuild can put the caret back. */
function focusPath(root: HTMLElement, target: HTMLElement): number[] {
    const path: number[] = [];
    let node: HTMLElement | null = target;
    while (node !== null && node !== root) {
        const parent: HTMLElement | null = node.parentElement;
        if (parent === null) break;
        path.unshift(Array.prototype.indexOf.call(parent.children, node));
        node = parent;
    }
    return path;
}

function restoreFocus(root: HTMLElement, path: number[]) {
    let node: Element | undefined = root;
    for (const i of path) node = node?.children[i];
    if (node instanceof HTMLElement) node.focus();
}
