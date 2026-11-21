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
import type { PolygonDefaults } from "./laserDraw";
import style from "./laserEditor.module.css";
import { catalogFonts, localFontFamilies, localFontsAvailable } from "./laserFonts";
import { button, checkbox, el, heading, numberField, row, select, t, textField } from "./laserUi";
import { BED_ORIGINS, type MachineProfile } from "./machineProfile";
import { type LaserFontRef, type LaserShape, TEXT_ALIGNS } from "./shapes";

/** The installed fonts, once listed (asking the browser's permission) this session. */
let localFamilies: LaserFontRef[] | undefined;
const LOCAL_FONTS = "__local";

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
    /** Changes the selected figure's parameters; its outlines are made again (one undo step). */
    editShape(edit: (shape: LaserShape) => void): void;
    /** The selected figure becomes plain outlines. */
    convertToCurves(): void;
    /** The sides and star share the polygon tool draws with next. */
    readonly polygonDefaults: PolygonDefaults;
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
        const caret =
            focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement
                ? [focused.selectionStart, focused.selectionEnd]
                : undefined;
        this.element.replaceChildren(
            ...this.bedSection(),
            ...this.objectsSection(),
            ...this.modelSection(),
            ...this.objectSection(),
        );
        if (path !== undefined) restoreFocus(this.element, path, caret);
    }

    /** The text field of the selected text, focused with its words selected (to type over). */
    focusText() {
        const area = this.element.querySelector<HTMLTextAreaElement>("textarea[data-shape-text]");
        area?.focus();
        area?.select();
    }

    private bedSection(): HTMLElement[] {
        const p = this.host.profile;
        return [
            heading("laser.bed"),
            row(
                "laser.origin",
                select(
                    BED_ORIGINS.map((o) => ({ value: o, label: t(`laser.origin.${o}`) })),
                    p.origin,
                    (v) => this.host.setProfile((q) => (q.origin = v)),
                ),
            ),
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
            ...this.shapeSection(o),
            ...this.operationSection(o),
        ];
    }

    /** The drawn figure's own parameters, applied as they are typed; «В кривые» drops them. */
    private shapeSection(o: LaserObject): HTMLElement[] {
        if (o.kind !== "vector") return [];
        const shape = o.shape;
        if (shape === undefined) return [];
        const rows: HTMLElement[] = [heading(`laser.shape.${shape.type}`)];
        if (shape.type === "polyline") {
            const edit = this.editAs(shape);
            rows.push(
                row(
                    "laser.shape.closed",
                    checkbox(shape.closed, (v) => edit((s) => (s.closed = v && s.points.length >= 3))),
                ),
            );
        } else if (shape.type === "rect") {
            const edit = this.editAs(shape);
            rows.push(
                row(
                    "laser.shape.radius",
                    numberField(shape.radius, (v) => edit((s) => (s.radius = v)), { min: 0 }),
                ),
            );
        } else if (shape.type === "polygon") {
            const edit = this.editAs(shape);
            rows.push(
                row(
                    "laser.shape.sides",
                    numberField(
                        shape.sides,
                        (v) =>
                            edit((s) => {
                                s.sides = Math.round(v);
                                this.host.polygonDefaults.sides = s.sides;
                            }),
                        { min: 3, max: 200, step: 1 },
                    ),
                ),
                row(
                    "laser.shape.star",
                    numberField(
                        shape.star * 100,
                        (v) =>
                            edit((s) => {
                                s.star = v / 100;
                                this.host.polygonDefaults.star = s.star;
                            }),
                        { min: 0, max: 99, step: 1 },
                    ),
                ),
            );
        } else if (shape.type === "text") {
            rows.push(...this.textRows(shape, this.editAs(shape)));
        }
        rows.push(
            el(
                "div",
                { className: style.buttons },
                button(
                    "laser.shape.toCurves",
                    () => this.host.convertToCurves(),
                    "laser.shape.toCurves.hint",
                ),
            ),
        );
        return rows;
    }

    /** An edit of the figure as it is now, typed by its kind (it is that kind still when applied). */
    private editAs<S extends LaserShape>(current: S): (f: (s: S) => void) => void {
        return (f) =>
            this.host.editShape((s) => {
                if (s.type === current.type) f(s as S);
            });
    }

    private textRows(
        shape: Extract<LaserShape, { type: "text" }>,
        edit: (f: (s: Extract<LaserShape, { type: "text" }>) => void) => void,
    ): HTMLElement[] {
        const area = el("textarea", { rows: 3 });
        area.setAttribute("data-shape-text", "");
        area.value = shape.text;
        area.className = style.textArea;
        // as it is typed, a moment after the last key
        let timer: ReturnType<typeof setTimeout> | undefined;
        area.oninput = () => {
            if (timer !== undefined) clearTimeout(timer);
            const value = area.value;
            timer = setTimeout(() => edit((s) => (s.text = value)), 250);
        };
        const fonts = [...catalogFonts(), ...(localFamilies ?? [])];
        if (!fonts.some((f) => f.family === shape.font.family)) fonts.unshift(shape.font);
        const keyOf = (f: LaserFontRef) => `${f.local ? "local" : "web"}:${f.family}`;
        const options = fonts.map((f) => ({
            value: keyOf(f),
            label: f.local ? f.family : `${f.family} (${t("laser.shape.font.web")})`,
        }));
        if (localFamilies === undefined && localFontsAvailable())
            options.push({ value: LOCAL_FONTS, label: t("laser.shape.font.local") });
        const fontSelect = select(options, keyOf(shape.font), (v) => {
            if (v === LOCAL_FONTS) {
                void localFontFamilies().then((list) => {
                    localFamilies = list;
                    this.render();
                });
                return;
            }
            const font = fonts.find((f) => keyOf(f) === v);
            if (font !== undefined) edit((s) => (s.font = { ...font }));
        });
        return [
            area,
            row("laser.shape.font", fontSelect),
            row(
                "laser.shape.size",
                numberField(shape.size, (v) => edit((s) => (s.size = v)), { min: 0.1 }),
            ),
            el(
                "div",
                { className: style.pair },
                row(
                    "laser.shape.letterSpacing",
                    numberField(shape.letterSpacing, (v) => edit((s) => (s.letterSpacing = v))),
                ),
                row(
                    "laser.shape.lineSpacing",
                    numberField(shape.lineSpacing, (v) => edit((s) => (s.lineSpacing = v)), {
                        min: 0.1,
                        step: 0.1,
                    }),
                ),
            ),
            row(
                "laser.shape.align",
                select(
                    TEXT_ALIGNS.map((a) => ({ value: a, label: t(`laser.shape.align.${a}`) })),
                    shape.align,
                    (v) => edit((s) => (s.align = v)),
                ),
            ),
            row(
                "laser.shape.arc",
                numberField(shape.arcRadius, (v) => edit((s) => (s.arcRadius = v))),
            ),
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

function restoreFocus(root: HTMLElement, path: number[], caret?: (number | null)[]) {
    let node: Element | undefined = root;
    for (const i of path) node = node?.children[i];
    if (!(node instanceof HTMLElement)) return;
    node.focus();
    // the caret where it was: a rebuilt text field would otherwise put it at the start
    if (caret !== undefined && (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement)) {
        try {
            node.setSelectionRange(caret[0], caret[1]);
        } catch {
            // a number field has no caret to set
        }
    }
}
