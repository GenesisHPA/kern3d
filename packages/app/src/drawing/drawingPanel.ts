// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys } from "@chili3d/core";
import { dimensionValue, formatLength } from "./compose";
import {
    type DrawingData,
    type DrawingDimensionData,
    type DrawingNoteData,
    type DrawingViewData,
    PROJECTION_ANGLES,
    type ProjectionSide,
    pageCount,
    pageOf,
    SHEET_FORMATS,
    SHEET_ORIENTATIONS,
    TITLE_BLOCK_KINDS,
    TITLE_FIELDS,
    VIEW_ORIENTATIONS,
    type ViewOrientation,
} from "./drawingData";
import style from "./drawingEditor.module.css";
import { viewBasisOf } from "./drawingViews";
import type { ViewGeometry } from "./hlr";
import { formatScale, orientationBasis, parseScale, STANDARD_SCALES } from "./viewBasis";

/** What the property panel needs from the editor. */
export interface DrawingPanelHost {
    data(): DrawingData;
    selection(): string | undefined;
    geometry(viewId: string): ViewGeometry | undefined;
    sourceName(id: string): string | undefined;
    /** Commits the working description; `recompute` also re-projects the views. */
    change(recompute?: boolean): void;
    addProjected(parentId: string, side: ProjectionSide): void;
    addIsometric(parentId: string): void;
    setSection(viewId: string, on: boolean): void;
    /** Brings back the automatic dimensions the user deleted. */
    restoreAuto(): void;
    moveToPage(viewId: string, page: number): void;
    remove(): void;
}

function t(key: string): string {
    return I18n.translate(key as I18nKeys);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    return e;
}

/** The right-hand panel: sheet settings and title block, or the selected item's properties. */
export class DrawingPanel {
    readonly element: HTMLDivElement;
    private textArea: HTMLTextAreaElement | undefined;

    constructor(private readonly host: DrawingPanelHost) {
        this.element = el("div");
        this.element.className = style.panel;
    }

    focusText() {
        this.textArea?.focus();
        this.textArea?.select();
    }

    render() {
        // keep the field being typed in: re-rendering under the caret would drop it
        if (this.element.contains(document.activeElement) && document.activeElement !== this.element) {
            const active = document.activeElement as HTMLElement;
            if (active.tagName === "INPUT" || active.tagName === "TEXTAREA") return;
        }
        this.textArea = undefined;
        this.element.replaceChildren();
        const selection = this.host.selection();
        const data = this.host.data();
        const [kind, id] = selection?.split(":") ?? [];
        if (kind === "view") {
            const view = data.views.find((v) => v.id === id);
            if (view !== undefined) return this.renderView(view);
        } else if (kind === "dim") {
            const dim = data.dimensions.find((d) => d.id === id);
            if (dim !== undefined) return this.renderDimension(dim);
        } else if (kind === "note") {
            const note = data.notes.find((n) => n.id === id);
            if (note !== undefined) return this.renderNote(note);
        }
        this.renderSheet(data);
    }

    private heading(key: string) {
        this.element.append(el("h3", t(key)));
    }

    private row(labelKey: string, control: HTMLElement) {
        const row = el("div");
        row.className = style.row;
        row.append(el("span", t(labelKey)), control);
        this.element.append(row);
    }

    private select<T extends string>(
        values: readonly T[],
        current: T,
        caption: (v: T) => string,
        onChange: (v: T) => void,
    ) {
        const s = el("select");
        for (const v of values) {
            const o = el("option", caption(v));
            o.value = v;
            o.selected = v === current;
            s.append(o);
        }
        s.onchange = () => onChange(s.value as T);
        return s;
    }

    private textInput(value: string, onChange: (v: string) => void, placeholder = "") {
        const i = el("input");
        i.type = "text";
        i.value = value;
        i.placeholder = placeholder;
        i.onchange = () => onChange(i.value);
        return i;
    }

    private checkbox(value: boolean, onChange: (v: boolean) => void) {
        const i = el("input");
        i.type = "checkbox";
        i.checked = value;
        i.onchange = () => onChange(i.checked);
        return i;
    }

    private buttons(...items: [string, () => void][]) {
        const box = el("div");
        box.className = style.buttons;
        for (const [key, action] of items) {
            const b = el("button", t(key));
            b.onclick = action;
            box.append(b);
        }
        this.element.append(box);
    }

    private renderSheet(data: DrawingData) {
        this.heading("drawing.sheet");
        this.row(
            "drawing.format",
            this.select(
                SHEET_FORMATS,
                data.sheet.format,
                (v) => v,
                (v) => {
                    data.sheet.format = v;
                    this.host.change();
                },
            ),
        );
        this.row(
            "drawing.orientation",
            this.select(
                SHEET_ORIENTATIONS,
                data.sheet.orientation,
                (v) => t(`drawing.orientation.${v}`),
                (v) => {
                    data.sheet.orientation = v;
                    this.host.change();
                },
            ),
        );
        this.row(
            "drawing.titleBlock",
            this.select(
                TITLE_BLOCK_KINDS,
                data.titleBlock.kind,
                (v) => t(`drawing.titleBlock.${v}`),
                (v) => {
                    data.titleBlock.kind = v;
                    this.host.change();
                },
            ),
        );
        this.row(
            "drawing.projection",
            this.select(
                PROJECTION_ANGLES,
                data.projection,
                (v) => t(`drawing.projection.${v}`),
                (v) => {
                    data.projection = v;
                    this.host.change();
                },
            ),
        );
        this.heading("drawing.titleBlock");
        for (const field of TITLE_FIELDS) {
            const placeholder = field === "scale" ? t("drawing.field.auto") : "";
            this.row(
                `drawing.field.${field}`,
                this.textInput(
                    data.titleBlock.fields[field] ?? "",
                    (v) => {
                        data.titleBlock.fields[field] = v;
                        this.host.change();
                    },
                    placeholder,
                ),
            );
        }
        if ((data.suppressed?.length ?? 0) > 0) {
            this.buttons(["drawing.restoreAuto", () => this.host.restoreAuto()]);
        }
        const hint = el("p", t("drawing.hint"));
        hint.style.opacity = "0.7";
        this.element.append(hint);
    }

    private scaleControl(view: DrawingViewData) {
        const wrap = el("div");
        wrap.style.display = "flex";
        wrap.style.gap = "4px";
        wrap.style.flex = "1 1 auto";
        const known = STANDARD_SCALES.some((s) => Math.abs(s - view.scale) < 1e-9);
        const values = known ? STANDARD_SCALES : [view.scale, ...STANDARD_SCALES];
        const s = el("select");
        for (const v of values) {
            const o = el("option", formatScale(v));
            o.value = String(v);
            o.selected = Math.abs(v - view.scale) < 1e-9;
            s.append(o);
        }
        const custom = this.textInput(
            "",
            (text) => {
                const value = parseScale(text);
                if (value !== undefined) this.setScale(view, value);
            },
            "1:3",
        );
        custom.style.width = "56px";
        s.onchange = () => this.setScale(view, Number(s.value));
        wrap.append(s, custom);
        return wrap;
    }

    private setScale(view: DrawingViewData, scale: number) {
        // a projected view keeps its parent's scale: change it at the root of the chain
        const data = this.host.data();
        let root = view;
        while (root.parentId !== undefined) {
            const parent = data.views.find((v) => v.id === root.parentId);
            if (parent === undefined) break;
            root = parent;
        }
        root.scale = scale;
        this.host.change();
    }

    private renderView(view: DrawingViewData) {
        this.heading("drawing.view");
        this.row(
            "drawing.view.source",
            el("span", this.host.sourceName(view.sourceId) ?? t("drawing.sourceMissing")),
        );
        if (view.parentId === undefined) {
            const orientations: (ViewOrientation | "custom")[] = [...VIEW_ORIENTATIONS];
            if (view.orientation === "custom") orientations.push("custom");
            this.row(
                "drawing.view.orientation",
                this.select(
                    orientations,
                    view.orientation,
                    (v) => t(`drawing.view.${v}`),
                    (v) => {
                        if (v === "custom") return;
                        const basis = orientationBasis(v);
                        view.orientation = v;
                        view.u = basis.u;
                        view.v = basis.v;
                        this.reorientChildren(view);
                        this.host.change(true);
                    },
                ),
            );
        } else {
            this.row("drawing.view.orientation", el("span", t(`drawing.view.${view.orientation}`)));
        }
        this.row("drawing.view.scale", this.scaleControl(view));
        const pages = pageCount(this.host.data());
        if (pages > 1) {
            this.row(
                "drawing.page",
                this.select(
                    Array.from({ length: pages }, (_, i) => String(i)),
                    String(pageOf(view)),
                    (v) => String(Number(v) + 1),
                    (v) => this.host.moveToPage(view.id, Number(v)),
                ),
            );
        }
        this.row(
            "drawing.view.hidden",
            this.checkbox(view.showHidden, (v) => {
                view.showHidden = v;
                this.host.change(true);
            }),
        );
        this.row(
            "drawing.view.tangent",
            this.checkbox(view.showTangent, (v) => {
                view.showTangent = v;
                this.host.change(true);
            }),
        );
        this.row(
            "drawing.view.centerMarks",
            this.checkbox(view.showCenterMarks, (v) => {
                view.showCenterMarks = v;
                this.host.change();
            }),
        );
        if (view.orientation !== "iso" && view.orientation !== "custom") {
            this.row(
                "drawing.view.section",
                this.checkbox(view.section !== undefined, (v) => this.host.setSection(view.id, v)),
            );
            const section = view.section;
            if (section !== undefined) {
                // the plane as a model coordinate ("Y = 20"), not as a depth along the view
                const w = viewBasisOf(view).w;
                const axis = [0, 1, 2].find((i) => Math.abs(w[i]) > 0.999);
                const sign = axis === undefined ? 1 : Math.sign(w[axis]);
                const letter = axis === undefined ? "" : ` (${"XYZ"[axis]})`;
                const row = el("div");
                row.className = style.row;
                row.append(
                    el("span", `${t("drawing.section.offset")}${letter}`),
                    this.textInput(String(Math.round(section.offset * sign * 1000) / 1000), (v) => {
                        const value = Number(v.replace(",", ".").replace(/^\s*[xyzXYZ]\s*=\s*/, ""));
                        if (!Number.isFinite(value)) return;
                        section.offset = value * sign;
                        this.host.change(true);
                    }),
                );
                this.element.append(row);
                this.row(
                    "drawing.section.name",
                    this.textInput(section.name, (v) => {
                        const name = v.trim();
                        if (name === "") return;
                        section.name = name;
                        this.host.change();
                    }),
                );
                this.row(
                    "drawing.section.labeled",
                    this.checkbox(!section.unlabeled, (v) => {
                        section.unlabeled = v ? undefined : true;
                        section.fixedLabel = true;
                        this.host.change();
                    }),
                );
            }
        }
        this.row(
            "drawing.view.label",
            this.textInput(view.label ?? "", (v) => {
                view.label = v || undefined;
                this.host.change();
            }),
        );
        this.heading("drawing.projectedView");
        this.buttons(
            ["drawing.project.up", () => this.host.addProjected(view.id, "up")],
            ["drawing.project.down", () => this.host.addProjected(view.id, "down")],
            ["drawing.project.left", () => this.host.addProjected(view.id, "left")],
            ["drawing.project.right", () => this.host.addProjected(view.id, "right")],
            ["drawing.view.iso", () => this.host.addIsometric(view.id)],
        );
        this.buttons(["drawing.delete", () => this.host.remove()]);
    }

    /** Views projected from a re-oriented base are dropped: their direction no longer follows. */
    private reorientChildren(view: DrawingViewData) {
        const data = this.host.data();
        const children = data.views.filter((v) => v.parentId === view.id);
        if (children.length === 0) return;
        const ids = new Set(children.map((c) => c.id));
        data.views = data.views.filter((v) => !ids.has(v.id));
        data.dimensions = data.dimensions.filter((d) => !ids.has(d.viewId));
    }

    private renderDimension(dim: DrawingDimensionData) {
        this.heading(`drawing.dim.${dim.kind}`);
        const comma = this.host.data().titleBlock.kind === "gost";
        this.row("drawing.dim.value", el("span", formatLength(dimensionValue(dim), comma)));
        if (dim.auto) this.row("drawing.dim.origin", el("span", t("drawing.dim.origin.auto")));
        // an edit makes the dimension the user's: automatic runs keep it as it is
        this.row(
            "drawing.dim.prefix",
            this.textInput(
                dim.prefix ?? "",
                (v) => {
                    dim.prefix = v || undefined;
                    dim.auto = undefined;
                    this.host.change();
                },
                "Ø, 4 отв. Ø",
            ),
        );
        this.row(
            "drawing.dim.override",
            this.textInput(dim.textOverride ?? "", (v) => {
                dim.textOverride = v || undefined;
                dim.auto = undefined;
                this.host.change();
            }),
        );
        this.buttons(["drawing.delete", () => this.host.remove()]);
    }

    private renderNote(note: DrawingNoteData) {
        this.heading("drawing.note");
        const area = el("textarea");
        area.rows = 4;
        area.value = note.text;
        area.onchange = () => {
            note.text = area.value;
            this.host.change();
        };
        this.textArea = area;
        this.row("drawing.note.text", area);
        this.row(
            "drawing.note.height",
            this.select(
                ["2.5", "3.5", "5", "7", "10"],
                String(note.height),
                (v) => v,
                (v) => {
                    note.height = Number(v);
                    this.host.change();
                },
            ),
        );
        this.buttons(["drawing.delete", () => this.host.remove()]);
    }
}
