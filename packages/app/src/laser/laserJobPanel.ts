// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { BARCODE_FORMATS } from "./barcodeShape";
import { QR_LEVELS } from "./barcodes";
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
import {
    catalogFonts,
    isStandardFont,
    localFontFamilies,
    localFontsAvailable,
    strokeFonts,
    systemFonts,
    systemFontsAvailable,
} from "./laserFonts";
import { button, checkbox, el, heading, numberField, row, select, t, textField } from "./laserUi";
import { BED_ORIGINS, type MachineProfile } from "./machineProfile";
import { defaultRotaryJob, type RotaryJob } from "./rotary";
import { ALIGNS, type Align } from "./selection";
import { defaultQuiet, type LaserFontRef, type LaserShape, TEXT_ALIGNS } from "./shapes";

/** The installed fonts, once listed (asking the browser's permission) this session. */
let localFamilies: LaserFontRef[] | undefined;
/** Windows' installed fonts as the desktop app lists them, once loaded. */
let systemFamilies: LaserFontRef[] | undefined;
const LOCAL_FONTS = "__local";

/** What the job panel needs from the editor it sits in. */
export interface LaserJobPanelHost {
    readonly data: LaserJobData;
    readonly selection: string | undefined;
    /** Every selected object (several with Shift / Ctrl or a rubber band). */
    readonly selectedIds: readonly string[];
    readonly profile: MachineProfile;
    /** `additive`: Shift / Ctrl — added to the selection, or taken out of it. */
    select(id: string | undefined, additive?: boolean): void;
    alignSelected(align: Align, toBed: boolean): void;
    distributeSelected(axis: "x" | "y"): void;
    /** Applies `edit` to the selected object and writes the job back as one undo step. */
    editSelected(edit: (o: LaserObject) => void): void;
    /** Applies `edit` to the job itself (its rotary settings) as one undo step. */
    editJob(edit: (job: LaserJobData) => void): void;
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
    /** The node tool is on, and a node is picked. */
    readonly nodeMode: boolean;
    readonly nodeSelected: boolean;
    nodeAction(action: "smooth" | "break" | "join" | "close" | "delete"): void;
    editNodes(): void;
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
    /** Align to the bed rather than to the selection's box. */
    private alignToBed = false;
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
            ...this.rotarySection(),
            ...this.bedSection(),
            ...this.objectsSection(),
            ...this.modelSection(),
            ...this.arrangeSection(),
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
            // a rotary job's bed is the part unrolled: its size comes from the part, not the table
            ...(this.host.data.rotary?.enabled === true
                ? []
                : [
                      el(
                          "div",
                          { className: style.pair },
                          row(
                              "laser.bedWidth",
                              numberField(p.bedWidth, (v) => this.host.setProfile((q) => (q.bedWidth = v)), {
                                  min: 1,
                              }),
                          ),
                          row(
                              "laser.bedHeight",
                              numberField(
                                  p.bedHeight,
                                  (v) => this.host.setProfile((q) => (q.bedHeight = v)),
                                  {
                                      min: 1,
                                  },
                              ),
                          ),
                      ),
                  ]),
        ];
    }

    /** A rotary job: the part (its size sets the unrolled bed) and how it is marked round. */
    private rotarySection(): HTMLElement[] {
        const r = this.host.data.rotary;
        if (r?.enabled !== true) return [];
        const set = (change: (q: RotaryJob) => void) =>
            this.host.editJob((job) => {
                const next = { ...(job.rotary ?? defaultRotaryJob()), enabled: true };
                change(next);
                job.rotary = next;
            });
        const parts: HTMLElement[] = [heading("laser.rotary.part")];
        if (this.host.profile.controller !== "jcz")
            parts.push(el("div", { className: style.warning, textContent: t("laser.rotary.needsJcz") }));
        parts.push(
            row(
                "laser.rotary.diameter",
                numberField(r.diameter, (v) => set((q) => (q.diameter = Math.max(0.5, v))), { min: 0.5 }),
            ),
            row(
                "laser.rotary.length",
                numberField(r.length, (v) => set((q) => (q.length = Math.max(1, v))), { min: 1 }),
            ),
            row(
                "laser.rotary.mode",
                select(
                    [
                        { value: "strips", label: t("laser.rotary.mode.strips") },
                        { value: "index", label: t("laser.rotary.mode.index") },
                    ],
                    r.mode,
                    (v) => set((q) => (q.mode = v)),
                ),
            ),
        );
        if (r.mode === "strips")
            parts.push(
                row(
                    "laser.rotary.strip",
                    numberField(r.stripWidth, (v) => set((q) => (q.stripWidth = Math.max(0.2, v))), {
                        min: 0.2,
                    }),
                ),
            );
        parts.push(
            el("div", {
                className: style.muted,
                textContent: t(
                    r.mode === "strips" ? "laser.rotary.hint.strips" : "laser.rotary.hint.index",
                    (Math.PI * r.diameter).toFixed(1),
                ),
            }),
        );
        return parts;
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
            const current = this.host.selectedIds.includes(o.id);
            list.append(
                el(
                    "div",
                    {
                        className: current ? `${style.listRow} ${style.current}` : style.listRow,
                        onclick: (e: MouseEvent) =>
                            this.host.select(o.id, e.shiftKey || e.ctrlKey || e.metaKey),
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

    /** Align and distribute the selection (one object: to the bed), as in EzCAD's toolbar. */
    private arrangeSection(): HTMLElement[] {
        const count = this.host.selectedIds.length;
        if (count === 0) return [];
        const toBed = this.alignToBed || count === 1;
        const rows: HTMLElement[] = [heading("laser.arrange")];
        if (count > 1)
            rows.push(el("div", { className: style.muted, textContent: t("laser.arrange.count", count) }));
        rows.push(
            el(
                "div",
                { className: style.buttons },
                ...ALIGNS.map((a) =>
                    button(
                        `laser.align.${a}`,
                        () => this.host.alignSelected(a, toBed),
                        `laser.align.${a}.hint`,
                    ),
                ),
            ),
        );
        if (count > 1)
            rows.push(
                row(
                    "laser.align.toBed",
                    checkbox(this.alignToBed, (v) => {
                        this.alignToBed = v;
                        this.render();
                    }),
                ),
            );
        if (count > 2)
            rows.push(
                el(
                    "div",
                    { className: style.buttons },
                    button("laser.distribute.x", () => this.host.distributeSelected("x")),
                    button("laser.distribute.y", () => this.host.distributeSelected("y")),
                ),
            );
        return rows;
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
        // X / Y are the drawing's centre (0, 0 = on the origin), as EzCAD shows them; a new
        // width or height grows the object about that centre, which stays where it is
        const resize = (x: LaserObject, width: number, height: number) => {
            const cx = x.x + x.width / 2;
            const cy = x.y + x.height / 2;
            x.width = width;
            x.height = height;
            x.x = cx - width / 2;
            x.y = cy - height / 2;
        };
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
                    numberField(o.x + o.width / 2, (v) => edit((x) => (x.x = v - x.width / 2))),
                ),
                row(
                    "laser.y",
                    numberField(o.y + o.height / 2, (v) => edit((x) => (x.y = v - x.height / 2))),
                ),
            ),
            el(
                "div",
                { className: style.pair },
                row(
                    "laser.width",
                    numberField(
                        o.width,
                        (v) => edit((x) => resize(x, v, x.lockAspect ? v / aspect : x.height)),
                        { min: 0.01 },
                    ),
                ),
                row(
                    "laser.height",
                    numberField(
                        o.height,
                        (v) => edit((x) => resize(x, x.lockAspect ? v * aspect : x.width, v)),
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
            ...(this.host.data.rotary?.enabled && this.host.data.rotary.mode === "index"
                ? [
                      row(
                          "laser.rotary.objectAngle",
                          numberField(o.rotaryAngle ?? 0, (v) =>
                              edit((x) => (x.rotaryAngle = v === 0 ? undefined : v)),
                          ),
                      ),
                  ]
                : []),
            row(
                "laser.hidden",
                checkbox(o.hidden === true, (v) => edit((x) => (x.hidden = v ? true : undefined))),
            ),
            ...this.shapeSection(o),
            ...this.operationSection(o),
        ];
    }

    /** The drawn figure's own parameters, applied as they are typed; «В кривые» drops them. */
    private nodesSection(): HTMLElement[] {
        const picked = this.host.nodeSelected;
        const b = (key: string, action: Parameters<LaserJobPanelHost["nodeAction"]>[0], needsNode = true) => {
            const x = button(key, () => this.host.nodeAction(action), `${key}.hint`);
            x.disabled = needsNode && !picked;
            return x;
        };
        return [
            heading("laser.nodes"),
            el("div", { className: style.muted, textContent: t("laser.nodes.help") }),
            el(
                "div",
                { className: style.buttons },
                b("laser.nodes.smooth", "smooth"),
                b("laser.nodes.break", "break"),
                b("laser.nodes.join", "join"),
                b("laser.nodes.close", "close", false),
                b("laser.nodes.delete", "delete"),
            ),
        ];
    }

    private shapeSection(o: LaserObject): HTMLElement[] {
        if (o.kind !== "vector") return [];
        if (this.host.nodeMode) return this.nodesSection();
        const shape = o.shape;
        const editNodes = el(
            "div",
            { className: style.buttons },
            button("laser.nodes.edit", () => this.host.editNodes(), "laser.nodes.edit.hint"),
        );
        if (shape === undefined) return [editNodes];
        if (shape.type === "path") return [heading("laser.shape.path"), editNodes];
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
        } else if (shape.type === "barcode") {
            rows.push(...this.barcodeRows(shape, this.editAs(shape)));
        } else if (shape.type === "scale") {
            rows.push(...this.scaleRows(shape, this.editAs(shape)));
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

    private barcodeRows(
        shape: Extract<LaserShape, { type: "barcode" }>,
        edit: (f: (s: Extract<LaserShape, { type: "barcode" }>) => void) => void,
    ): HTMLElement[] {
        const area = el("textarea", { rows: 2 });
        area.setAttribute("data-shape-text", "");
        area.value = shape.data;
        area.className = style.textArea;
        let timer: ReturnType<typeof setTimeout> | undefined;
        area.oninput = () => {
            if (timer !== undefined) clearTimeout(timer);
            const value = area.value;
            timer = setTimeout(() => edit((s) => (s.data = value)), 300);
        };
        const linear = shape.format === "code128" || shape.format === "ean13";
        const rows: HTMLElement[] = [
            row(
                "laser.barcode.format",
                select(
                    BARCODE_FORMATS.map((f) => ({ value: f, label: t(`laser.barcode.${f}.name`) })),
                    shape.format,
                    (v) =>
                        edit((s) => {
                            s.format = v;
                            s.quiet = defaultQuiet(v);
                            if (v === "ean13" && !/^\d{12,13}$/.test(s.data)) s.data = "400638133393";
                        }),
                ),
            ),
            area,
        ];
        if (shape.format === "qr")
            rows.push(
                row(
                    "laser.barcode.level",
                    select(
                        QR_LEVELS.map((l) => ({ value: l, label: t(`laser.barcode.level.${l}`) })),
                        shape.level,
                        (v) => edit((s) => (s.level = v)),
                    ),
                ),
            );
        rows.push(
            el(
                "div",
                { className: style.pair },
                row(
                    "laser.barcode.module",
                    numberField(shape.module, (v) => edit((s) => (s.module = v)), { min: 0.01, step: 0.05 }),
                ),
                row(
                    "laser.barcode.quiet",
                    numberField(shape.quiet, (v) => edit((s) => (s.quiet = Math.round(v))), {
                        min: 0,
                        step: 1,
                    }),
                ),
            ),
        );
        if (linear)
            rows.push(
                row(
                    "laser.barcode.barHeight",
                    numberField(shape.barHeight, (v) => edit((s) => (s.barHeight = v)), { min: 0.1 }),
                ),
                row(
                    "laser.barcode.showText",
                    checkbox(shape.showText, (v) => edit((s) => (s.showText = v))),
                ),
            );
        rows.push(
            row(
                "laser.barcode.invert",
                checkbox(shape.invert, (v) => edit((s) => (s.invert = v))),
            ),
        );
        return rows;
    }

    /** A scale's settings: range and step, tick lengths, figures and their look. */
    private scaleRows(
        shape: Extract<LaserShape, { type: "scale" }>,
        edit: (f: (s: Extract<LaserShape, { type: "scale" }>) => void) => void,
    ): HTMLElement[] {
        const num = (
            key: string,
            value: number,
            apply: (s: Extract<LaserShape, { type: "scale" }>, v: number) => void,
            options: { min?: number; step?: number } = {},
        ) =>
            row(
                key,
                numberField(value, (v) => edit((s) => apply(s, v)), options),
            );
        const check = (
            key: string,
            value: boolean,
            apply: (s: Extract<LaserShape, { type: "scale" }>, v: boolean) => void,
        ) =>
            row(
                key,
                checkbox(value, (v) => edit((s) => apply(s, v))),
            );
        const suffix = el("input", { type: "text", value: shape.suffix });
        suffix.onchange = () => edit((s) => (s.suffix = suffix.value));
        const fonts = strokeFonts();
        const fontSelect = select(
            fonts.map((f) => ({ value: f.stroke ?? f.family, label: f.family })),
            shape.font.stroke ?? shape.font.family,
            (v) =>
                edit((s) => {
                    const f = fonts.find((x) => (x.stroke ?? x.family) === v);
                    if (f !== undefined) s.font = f;
                }),
        );
        const rows: HTMLElement[] = [
            heading("laser.scale.range"),
            num("laser.scale.span", shape.span, (s, v) => (s.span = Math.max(0.1, v)), { min: 0.1 }),
            el(
                "div",
                { className: style.pair },
                num("laser.scale.from", shape.from, (s, v) => (s.from = v)),
                num("laser.scale.to", shape.to, (s, v) => (s.to = v)),
            ),
            num("laser.scale.step", shape.step, (s, v) => (s.step = Math.max(1e-6, v)), { min: 0 }),
            el(
                "div",
                { className: style.pair },
                num(
                    "laser.scale.majorEvery",
                    shape.majorEvery,
                    (s, v) => (s.majorEvery = Math.max(0, Math.round(v))),
                    { min: 0, step: 1 },
                ),
                num(
                    "laser.scale.midEvery",
                    shape.midEvery,
                    (s, v) => (s.midEvery = Math.max(0, Math.round(v))),
                    { min: 0, step: 1 },
                ),
            ),
            check("laser.scale.reverse", shape.reverse, (s, v) => (s.reverse = v)),
            check("laser.scale.skipLast", shape.skipLast, (s, v) => (s.skipLast = v)),
            heading("laser.scale.ticks"),
            num("laser.scale.lineWidth", shape.lineWidth, (s, v) => (s.lineWidth = Math.max(0, v)), {
                min: 0,
                step: 0.05,
            }),
            ...(shape.lineWidth > 0
                ? [
                      num(
                          "laser.scale.linePitch",
                          shape.linePitch,
                          (s, v) => (s.linePitch = Math.max(0.005, v)),
                          { min: 0.005, step: 0.01 },
                      ),
                  ]
                : []),
            num("laser.scale.majorLength", shape.majorLength, (s, v) => (s.majorLength = Math.max(0, v)), {
                min: 0,
            }),
            num("laser.scale.midLength", shape.midLength, (s, v) => (s.midLength = Math.max(0, v)), {
                min: 0,
            }),
            num("laser.scale.minorLength", shape.minorLength, (s, v) => (s.minorLength = Math.max(0, v)), {
                min: 0,
            }),
            check("laser.scale.flip", shape.flip, (s, v) => (s.flip = v)),
            check("laser.scale.baseline", shape.baseline, (s, v) => (s.baseline = v)),
            heading("laser.scale.labels"),
            check("laser.scale.showLabels", shape.labels, (s, v) => (s.labels = v)),
        ];
        if (shape.labels)
            rows.push(
                num(
                    "laser.scale.labelEvery",
                    shape.labelEvery,
                    (s, v) => (s.labelEvery = Math.max(1, Math.round(v))),
                    { min: 1, step: 1 },
                ),
                num("laser.scale.labelSize", shape.labelSize, (s, v) => (s.labelSize = Math.max(0.1, v)), {
                    min: 0.1,
                }),
                num("laser.scale.labelGap", shape.labelGap, (s, v) => (s.labelGap = Math.max(0, v)), {
                    min: 0,
                }),
                row("laser.scale.suffix", suffix),
                num(
                    "laser.scale.decimals",
                    shape.decimals,
                    (s, v) => (s.decimals = Math.max(0, Math.min(6, Math.round(v)))),
                    { min: 0, step: 1 },
                ),
                check("laser.scale.labelsAlong", shape.labelsAlong, (s, v) => (s.labelsAlong = v)),
                row("laser.scale.font", fontSelect),
            );
        return rows;
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
        if (systemFamilies === undefined && systemFontsAvailable()) {
            void systemFonts().then((list) => {
                systemFamilies = list;
                this.render();
            });
        }
        const system = systemFamilies ?? [];
        const groups: { label: string; fonts: LaserFontRef[] }[] = [
            { label: t("laser.shape.font.stroke"), fonts: strokeFonts() },
            { label: t("laser.shape.font.standard"), fonts: system.filter((f) => isStandardFont(f.family)) },
            {
                label: t("laser.shape.font.installed"),
                fonts: system.filter((f) => !isStandardFont(f.family)),
            },
            { label: t("laser.shape.font.installed"), fonts: localFamilies ?? [] },
            { label: t("laser.shape.font.webGroup"), fonts: catalogFonts() },
        ].filter((g) => g.fonts.length > 0);
        const keyOf = (f: LaserFontRef) =>
            f.stroke !== undefined
                ? `stroke:${f.stroke}`
                : `${f.system ? "system" : f.local ? "local" : "web"}:${f.family}`;
        const all = groups.flatMap((g) => g.fonts);
        if (!all.some((f) => keyOf(f) === keyOf(shape.font))) {
            groups.unshift({ label: t("laser.shape.font.current"), fonts: [shape.font] });
            all.unshift(shape.font);
        }
        const fontSelect = el("select");
        for (const g of groups) {
            const group = el("optgroup");
            group.label = g.label;
            for (const f of g.fonts) {
                const option = el("option", { value: keyOf(f), textContent: f.family });
                // each name in its own face, as font menus show them (installed ones only)
                if (f.system || f.local) option.style.fontFamily = `"${f.family}"`;
                option.selected = keyOf(f) === keyOf(shape.font);
                group.append(option);
            }
            fontSelect.append(group);
        }
        if (localFamilies === undefined && !systemFontsAvailable() && localFontsAvailable())
            fontSelect.append(el("option", { value: LOCAL_FONTS, textContent: t("laser.shape.font.local") }));
        fontSelect.onchange = () => {
            const v = fontSelect.value;
            if (v === LOCAL_FONTS) {
                void localFontFamilies().then((list) => {
                    localFamilies = list;
                    this.render();
                });
                return;
            }
            const font = all.find((f) => keyOf(f) === v);
            if (font !== undefined) edit((s) => (s.font = { ...font }));
        };
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
        // a single-line font's strokes are traced; there is no inside to fill
        const strokeText =
            o.kind === "vector" && o.shape?.type === "text" && o.shape.font.stroke !== undefined;
        const modes =
            o.kind === "image"
                ? (["image"] as const)
                : strokeText
                  ? (["line"] as const)
                  : (["line", "fill"] as const);
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
        ];
        const jcz = this.host.profile.controller === "jcz" ? this.host.profile.jcz : undefined;
        if (jcz !== undefined) {
            // a fiber source's pulse rate, within the range its markcfg allows
            rows.push(
                row(
                    "laser.frequency",
                    numberField(op.frequency, (v) => edit((x) => (x.frequency = v)), {
                        min: jcz.minFrequency,
                        max: jcz.maxFrequency,
                        digits: 1,
                    }),
                ),
            );
        }
        rows.push(
            row(
                jcz !== undefined ? "laser.speedPerSecond" : "laser.speed",
                // a galvo's speed reads in mm/s, as EzCAD shows it; the job keeps mm/min
                jcz !== undefined
                    ? numberField(op.speed / 60, (v) => edit((x) => (x.speed = v * 60)), {
                          min: 0.1,
                          digits: 1,
                      })
                    : numberField(op.speed, (v) => edit((x) => (x.speed = v)), { min: 1 }),
            ),
            row(
                "laser.passes",
                numberField(op.passes, (v) => edit((x) => (x.passes = Math.round(v))), { min: 1, step: 1 }),
            ),
            row(
                "laser.air",
                checkbox(op.air, (v) => edit((x) => (x.air = v))),
            ),
        );
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
