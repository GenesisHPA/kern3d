// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    PubSub,
    readFileAsync,
    ShapeNode,
    ShapeTypes,
    Transaction,
    type WorkspaceTab,
    workspaceTabs,
} from "@chili3d/core";
import { DrawingNode } from "../drawing/drawingNode";
import { bodyOutline, drawingSheet, faceOutline, type ModelView } from "./fromModel";
import { type Affine, apply, invert, type Pt } from "./geometry";
import {
    defaultOperation,
    jobBounds,
    type LaserJobData,
    type LaserObject,
    newLaserId,
    objectCorners,
    objectMatrix,
    placement,
} from "./laserData";
import style from "./laserEditor.module.css";
import { LaserJobPanel, type LaserJobPanelHost, MODE_COLORS } from "./laserJobPanel";
import { LaserMachine } from "./laserMachine";
import type { LaserNode } from "./laserNode";
import { LaserOutput } from "./laserOutput";
import { button, el, t } from "./laserUi";
import { loadMachineProfile, type MachineProfile, saveMachineProfile } from "./machineProfile";
import type { SvgImport } from "./svgImport";
import { importSvg } from "./svgImport";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgElement<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attributes: Record<string, string | number> = {},
) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attributes)) e.setAttribute(k, String(v));
    return e;
}

function matrixAttribute(m: Affine): string {
    return `matrix(${m.map((v) => Number(v.toFixed(6))).join(" ")})`;
}

interface ViewBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

type Drag =
    | { kind: "pan"; x: number; y: number; box: ViewBox }
    | { kind: "move"; id: string; start: Pt; origin: LaserObject; moved: boolean }
    | { kind: "scale"; id: string; corner: number; origin: LaserObject }
    | { kind: "rotate"; id: string; center: Pt; startAngle: number; origin: LaserObject };

/** Box-frame corners in `objectCorners` order: lower left, lower right, upper right, upper left. */
const CORNER_SIGNS: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
];

/**
 * The laser workspace: the machine's bed with the job's objects on it, a side panel for the
 * objects and their operations, and the machine. Like a drawing it lives in a tab beside the
 * document tabs, over the 3D view, and writes every change back to its node in one transaction,
 * so undo/redo are the document's.
 */
export class LaserEditor {
    private static readonly editors = new Map<string, LaserEditor>();

    static open(node: LaserNode) {
        let editor = LaserEditor.editors.get(node.id);
        if (editor === undefined) {
            editor = new LaserEditor(node);
            LaserEditor.editors.set(node.id, editor);
            editor.mount();
        }
        workspaceTabs.open(editor.tab);
    }

    static get isOpen() {
        const active = workspaceTabs.active;
        return active !== undefined && LaserEditor.editors.has(active);
    }

    private readonly tab: WorkspaceTab;
    private readonly dialog: HTMLDialogElement;
    private readonly svg: SVGSVGElement;
    /** Bed millimetres, y up, inside the screen's y-down SVG. */
    private readonly world: SVGGElement;
    private readonly bedGroup: SVGGElement;
    private readonly objectsGroup: SVGGElement;
    protected readonly previewGroup: SVGGElement;
    private readonly overlayGroup: SVGGElement;
    private readonly statusText: HTMLSpanElement;
    private readonly statusPosition: HTMLSpanElement;
    protected readonly panelTabs: HTMLDivElement;
    protected readonly panelBody: HTMLDivElement;
    protected readonly toolbar: HTMLDivElement;
    private readonly jobPanel: LaserJobPanel;
    protected readonly output: LaserOutput;
    private readonly machine: LaserMachine;
    private readonly objectElements = new Map<string, SVGGraphicsElement>();
    data: LaserJobData;
    private committed: string;
    selection: string | undefined;
    profile: MachineProfile = loadMachineProfile();
    private viewBox: ViewBox = { x: 0, y: 0, w: 400, h: 400 };
    private drag: Drag | undefined;
    private fitted = false;

    private constructor(readonly node: LaserNode) {
        this.tab = {
            id: node.id,
            title: () => this.node.name,
            icon: "icon-layer-group",
            show: () => this.reveal(),
            hide: () => this.conceal(),
            close: () => this.close(),
        };
        this.data = node.data;
        this.committed = node.content;
        this.dialog = document.createElement("dialog");
        this.dialog.className = style.dialog;
        this.svg = svgElement("svg", { class: style.canvas });
        this.world = svgElement("g");
        this.bedGroup = svgElement("g");
        this.objectsGroup = svgElement("g");
        this.previewGroup = svgElement("g", { "pointer-events": "none" });
        this.overlayGroup = svgElement("g");
        this.world.append(this.bedGroup, this.objectsGroup, this.previewGroup, this.overlayGroup);
        this.svg.append(this.world);
        this.statusText = el("span");
        this.statusPosition = el("span");
        this.jobPanel = new LaserJobPanel(this.jobPanelHost());
        const editor = this;
        this.output = new LaserOutput({
            get data() {
                return editor.data;
            },
            get profile() {
                return editor.profile;
            },
            get jobName() {
                return editor.node.name;
            },
            previewGroup: this.previewGroup,
            setProfile: (edit) => this.setProfile(edit),
            setStatus: (text) => this.setStatus(text),
            renderPanel: () => this.renderPanel(),
        });
        this.machine = new LaserMachine({
            get profile() {
                return editor.profile;
            },
            setProfile: (edit) => this.setProfile(edit),
            program: async () => {
                const r = this.output.current ?? (await this.output.generate());
                if (r === undefined || !r.moves.some((m) => m.power > 0)) return undefined;
                return { lines: r.lines, seconds: r.stats.seconds };
            },
            jobBounds: () => jobBounds(this.data),
        });
        this.panelTabs = el("div", { className: style.panelTabs });
        this.panelBody = el("div", { className: style.panelBody });
        this.toolbar = this.createToolbar();
        const root = el("div", { className: style.root, tabIndex: -1 });
        root.append(
            this.toolbar,
            el(
                "div",
                { className: style.body },
                this.svg,
                el("div", { className: style.panel }, this.panelTabs, this.panelBody),
            ),
            el("div", { className: style.status }, this.statusText, this.statusPosition),
        );
        this.dialog.append(root);
    }

    // ---- lifecycle ------------------------------------------------------------------------

    private mount() {
        document.body.append(this.dialog);
        this.dialog.addEventListener("cancel", this.onCancel);
        this.dialog.addEventListener("keydown", this.onKeyDown);
        this.svg.addEventListener("pointerdown", this.onPointerDown);
        this.svg.addEventListener("pointermove", this.onPointerMove);
        this.svg.addEventListener("pointerup", this.onPointerUp);
        this.svg.addEventListener("wheel", this.onWheel, { passive: false });
        this.svg.addEventListener("contextmenu", (e) => e.preventDefault());
        this.node.onPropertyChanged(this.onNodeChanged);
        this.showPanel("job");
        this.render();
    }

    private reveal() {
        if (!this.dialog.open) this.dialog.show();
        if (!this.fitted) {
            this.fitted = true;
            this.fit();
        }
        (this.dialog.firstElementChild as HTMLElement).focus();
    }

    private conceal() {
        if (this.dialog.open) this.dialog.close();
    }

    close() {
        // the laser off and the port free before the editor goes
        if (this.machine.connected) void this.machine.disconnect();
        this.node.removePropertyChanged(this.onNodeChanged);
        this.dialog.close();
        this.dialog.remove();
        LaserEditor.editors.delete(this.node.id);
        workspaceTabs.remove(this.node.id);
    }

    private readonly onCancel = (e: Event) => {
        e.preventDefault();
        this.select(undefined);
    };

    private readonly onNodeChanged = (property: string | number | symbol) => {
        if (property === "name") workspaceTabs.changed();
        if (property !== "content" || this.node.content === this.committed) return;
        // undo / redo replaced the job under us
        this.committed = this.node.content;
        this.data = this.node.data;
        if (!this.data.objects.some((o) => o.id === this.selection)) this.selection = undefined;
        this.changed();
        this.render();
    };

    // ---- data -----------------------------------------------------------------------------

    /** Writes the working job back to the node as one undoable step. */
    commit() {
        const content = JSON.stringify(this.data);
        if (content === this.committed) return;
        this.committed = content;
        Transaction.execute(this.node.document, "laser", () => {
            this.node.content = content;
        });
        this.changed();
    }

    /** The job changed (an edit, undo): whatever was computed from it is stale. Subclass hook. */
    protected changed() {
        this.output.invalidate();
    }

    selected(): LaserObject | undefined {
        return this.data.objects.find((o) => o.id === this.selection);
    }

    select(id: string | undefined) {
        this.selection = id;
        this.render();
    }

    setProfile(edit: (p: MachineProfile) => void) {
        edit(this.profile);
        saveMachineProfile(this.profile);
        this.changed();
        this.render();
    }

    private add(o: LaserObject) {
        this.data.objects.push(o);
        this.selection = o.id;
        this.commit();
        this.render();
    }

    private addImport(imported: SvgImport | undefined, name: string) {
        if (imported === undefined || imported.paths.length === 0) {
            PubSub.default.pub("showToast", "toast.laser.nothingToEngrave");
            return;
        }
        const w = Math.max(imported.width, 0.01);
        const h = Math.max(imported.height, 0.01);
        this.add({
            id: newLaserId(),
            name,
            kind: "vector",
            x: 0,
            y: 0,
            width: w,
            height: h,
            angle: 0,
            lockAspect: true,
            paths: imported.paths,
            sourceWidth: w,
            sourceHeight: h,
            op: defaultOperation("line"),
        });
    }

    private async importSvgFile() {
        const files = await readFileAsync(".svg,image/svg+xml", false, "readAsText");
        if (!files.isOk) return;
        for (const file of files.value)
            this.addImport(importSvg(file.data), file.fileName.replace(/\.svg$/i, ""));
    }

    private async importImageFile() {
        const files = await readFileAsync(
            "image/png,image/jpeg,image/bmp,.bmp,.png,.jpg,.jpeg",
            false,
            "readAsDataURL",
        );
        if (!files.isOk) return;
        for (const file of files.value) {
            const image = await loadImage(file.data);
            if (image === undefined) {
                PubSub.default.pub("showToast", "toast.laser.imageFailed");
                continue;
            }
            // 10 pixels per millimetre — the default engraving resolution — shrunk to fit the bed
            let w = image.naturalWidth / 10;
            let h = image.naturalHeight / 10;
            const fit = Math.min(1, (this.profile.bedWidth * 0.9) / w, (this.profile.bedHeight * 0.9) / h);
            w *= fit;
            h *= fit;
            this.add({
                id: newLaserId(),
                name: file.fileName.replace(/\.(png|jpe?g|bmp)$/i, ""),
                kind: "image",
                x: 0,
                y: 0,
                width: w,
                height: h,
                angle: 0,
                lockAspect: true,
                dataUrl: file.data,
                pixelWidth: image.naturalWidth,
                pixelHeight: image.naturalHeight,
                op: defaultOperation("image"),
            });
        }
    }

    private modelSources() {
        const nodes = this.node.document.modelManager.findNodes(
            (n) =>
                (n instanceof ShapeNode && !n.isReferenceGeometry && n.shape.isOk) ||
                n instanceof DrawingNode,
        );
        return nodes.map((n) => ({
            id: n.id,
            label: n instanceof DrawingNode ? `${t("laser.fromModel.drawing")}: ${n.name}` : n.name,
            kind: (n instanceof DrawingNode ? "drawing" : "body") as "body" | "drawing",
        }));
    }

    private addFromModel(sourceId: string, view: ModelView) {
        const document = this.node.document;
        const node = document.modelManager.findNode((n) => n.id === sourceId);
        if (node === undefined) return;
        const imported =
            node instanceof DrawingNode
                ? drawingSheet(document, node)
                : bodyOutline(document, sourceId, view);
        this.addImport(imported, node.name);
    }

    /** Back to the model to pick a face, then here again with its outline. */
    private async pickFace() {
        const document = this.node.document;
        workspaceTabs.activate(undefined);
        const controller = new AsyncController();
        try {
            const picked = await document.picker.pickShape("prompt.select.faces", controller, {
                shapeType: ShapeTypes.face,
                multi: false,
            });
            const face = picked[0];
            if (face !== undefined) {
                const imported = faceOutline(face.shape, face.transform);
                workspaceTabs.activate(this.node.id);
                this.addImport(imported, `${face.owner.node.name}: ${t("laser.face")}`);
                return;
            }
        } finally {
            if (workspaceTabs.active !== this.node.id) workspaceTabs.activate(this.node.id);
        }
    }

    private deleteSelected() {
        const index = this.data.objects.findIndex((o) => o.id === this.selection);
        if (index < 0) return;
        this.data.objects.splice(index, 1);
        this.selection = undefined;
        this.commit();
        this.render();
    }

    private duplicateSelected() {
        const o = this.selected();
        if (o === undefined) return;
        const copy = { ...structuredClone(o), id: newLaserId(), x: o.x + 5, y: o.y + 5 };
        this.add(copy);
    }

    private move(id: string, delta: -1 | 1) {
        const list = this.data.objects;
        const i = list.findIndex((o) => o.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        this.commit();
        this.render();
    }

    private jobPanelHost(): LaserJobPanelHost {
        const editor = this;
        return {
            get data() {
                return editor.data;
            },
            get selection() {
                return editor.selection;
            },
            get profile() {
                return editor.profile;
            },
            select: (id) => this.select(id),
            editSelected: (edit) => {
                const o = this.selected();
                if (o === undefined) return;
                edit(o);
                this.commit();
                this.render();
            },
            move: (id, delta) => this.move(id, delta),
            setProfile: (edit) => this.setProfile(edit),
            modelSources: () => this.modelSources(),
            addFromModel: (id, view) => this.addFromModel(id, view),
            pickFace: () => void this.pickFace(),
        };
    }

    // ---- side panel -------------------------------------------------------------------------

    private currentPanel = "job";

    /** The side panel's tabs; later stages add theirs through `panels`. */
    protected panels(): { id: string; title: string; render: () => HTMLElement }[] {
        return [
            {
                id: "job",
                title: t("laser.panel.job"),
                render: () => {
                    this.jobPanel.render();
                    return this.jobPanel.element;
                },
            },
            { id: "output", title: t("laser.panel.output"), render: () => this.output.panel() },
            { id: "machine", title: t("laser.panel.machine"), render: () => this.machine.element },
        ];
    }

    protected showPanel(id: string) {
        this.currentPanel = id;
        this.renderPanel();
    }

    protected renderPanel() {
        const panels = this.panels();
        const current = panels.find((p) => p.id === this.currentPanel) ?? panels[0];
        this.panelTabs.replaceChildren(
            ...panels.map((p) =>
                el("div", {
                    className: p.id === current.id ? style.current : "",
                    textContent: p.title,
                    onclick: () => this.showPanel(p.id),
                }),
            ),
        );
        const content = current.render();
        if (this.panelBody.firstElementChild !== content) this.panelBody.replaceChildren(content);
    }

    // ---- toolbar ----------------------------------------------------------------------------

    protected separator() {
        return el("div", { className: style.separator });
    }

    protected toolbarItems(): HTMLElement[] {
        return [
            button("laser.import.svg", () => void this.importSvgFile()),
            button("laser.import.image", () => void this.importImageFile()),
            this.separator(),
            button("laser.duplicate", () => this.duplicateSelected()),
            button("laser.delete", () => this.deleteSelected()),
            this.separator(),
            button("laser.fit", () => this.fit()),
            this.separator(),
            button("laser.generate", () => void this.output.generate()),
            button("laser.save", () => void this.output.save()),
        ];
    }

    private createToolbar(): HTMLDivElement {
        const bar = el("div", { className: style.toolbar });
        bar.append(
            ...this.toolbarItems(),
            this.separator(),
            button("laser.toModel", () => workspaceTabs.activate(undefined)),
            button("laser.close", () => this.close()),
        );
        return bar;
    }

    // ---- rendering --------------------------------------------------------------------------

    render() {
        this.world.setAttribute("transform", `matrix(1 0 0 -1 0 ${this.profile.bedHeight})`);
        this.renderBed();
        this.renderObjects();
        this.renderOverlay();
        this.renderPanel();
        this.statusText.textContent = this.output.summary() || t("laser.prompt.select");
    }

    private renderBed() {
        const { bedWidth: w, bedHeight: h } = this.profile;
        const g = this.bedGroup;
        g.replaceChildren(svgElement("rect", { x: 0, y: 0, width: w, height: h, fill: "#fff" }));
        const minor = svgElement("path", {
            stroke: "#e9ecef",
            "stroke-width": 1,
            "vector-effect": "non-scaling-stroke",
            fill: "none",
        });
        const major = svgElement("path", {
            stroke: "#ced4da",
            "stroke-width": 1,
            "vector-effect": "non-scaling-stroke",
            fill: "none",
        });
        let dMinor = "";
        let dMajor = "";
        for (let x = 10; x < w; x += 10) {
            if (x % 50 === 0) dMajor += `M${x} 0V${h}`;
            else dMinor += `M${x} 0V${h}`;
        }
        for (let y = 10; y < h; y += 10) {
            if (y % 50 === 0) dMajor += `M0 ${y}H${w}`;
            else dMinor += `M0 ${y}H${w}`;
        }
        minor.setAttribute("d", dMinor);
        major.setAttribute("d", dMajor);
        const axes = svgElement("path", {
            d: `M0 0H${Math.min(30, w)}M0 0V${Math.min(30, h)}`,
            stroke: "#e03131",
            "stroke-width": 2,
            "vector-effect": "non-scaling-stroke",
            fill: "none",
        });
        const frame = svgElement("rect", {
            x: 0,
            y: 0,
            width: w,
            height: h,
            fill: "none",
            stroke: "#343a40",
            "stroke-width": 1,
            "vector-effect": "non-scaling-stroke",
        });
        g.append(minor, major, frame, axes);
    }

    /** Each object drawn in its own frame under its placement matrix, so a drag only moves a transform. */
    private renderObjects() {
        this.objectsGroup.replaceChildren();
        this.objectElements.clear();
        for (const o of this.data.objects) {
            const e = o.kind === "image" ? this.imageElement(o) : this.vectorElement(o);
            if (o.hidden) e.setAttribute("opacity", "0.3");
            this.objectsGroup.append(e);
            this.objectElements.set(o.id, e);
        }
    }

    private imageElement(o: Extract<LaserObject, { kind: "image" }>): SVGGraphicsElement {
        const image = svgElement("image", {
            href: o.dataUrl,
            x: 0,
            y: 0,
            width: o.pixelWidth,
            height: o.pixelHeight,
            preserveAspectRatio: "none",
            style: "filter: grayscale(1)",
        });
        image.setAttribute("transform", matrixAttribute(this.imageMatrix(o)));
        return image;
    }

    private imageMatrix(o: LaserObject): Affine {
        const m = objectMatrix(o);
        // a picture's rows run down; the bed's y runs up
        const h = o.kind === "image" ? o.pixelHeight : 0;
        return [m[0], m[1], -m[2], -m[3], m[2] * h + m[4], m[3] * h + m[5]];
    }

    private vectorElement(o: Extract<LaserObject, { kind: "vector" }>): SVGGraphicsElement {
        let d = "";
        for (const path of o.paths) {
            const pts = path.points;
            if (pts.length === 0) continue;
            d += `M${pts[0].x.toFixed(3)} ${pts[0].y.toFixed(3)}`;
            for (let k = 1; k < pts.length; k++) d += `L${pts[k].x.toFixed(3)} ${pts[k].y.toFixed(3)}`;
            if (path.closed) d += "Z";
        }
        const fill = o.op.mode === "fill";
        const e = svgElement("path", {
            d,
            fill: fill ? "rgba(25,113,194,0.18)" : "none",
            "fill-rule": "evenodd",
            stroke: MODE_COLORS[o.op.mode],
            "stroke-width": 1.2,
            "vector-effect": "non-scaling-stroke",
        });
        e.setAttribute("transform", matrixAttribute(objectMatrix(o)));
        return e;
    }

    /** Places an object's drawing anew after a drag changed its placement. */
    private updateObjectTransform(o: LaserObject) {
        const e = this.objectElements.get(o.id);
        if (e === undefined) return;
        e.setAttribute(
            "transform",
            matrixAttribute(o.kind === "image" ? this.imageMatrix(o) : objectMatrix(o)),
        );
    }

    private renderOverlay() {
        this.overlayGroup.replaceChildren();
        const o = this.selected();
        if (o === undefined) return;
        const corners = objectCorners(o);
        const px = this.pixel();
        this.overlayGroup.append(
            svgElement("polygon", {
                points: corners.map((p) => `${p.x},${p.y}`).join(" "),
                fill: "none",
                stroke: "#1677ff",
                "stroke-width": 1,
                "stroke-dasharray": "5 3",
                "vector-effect": "non-scaling-stroke",
                "pointer-events": "none",
            }),
        );
        for (const p of corners) {
            this.overlayGroup.append(
                svgElement("rect", {
                    x: p.x - 4 * px,
                    y: p.y - 4 * px,
                    width: 8 * px,
                    height: 8 * px,
                    fill: "#fff",
                    stroke: "#1677ff",
                    "stroke-width": 1,
                    "vector-effect": "non-scaling-stroke",
                }),
            );
        }
        const r = this.rotateHandle(o);
        this.overlayGroup.append(
            svgElement("line", {
                x1: (corners[2].x + corners[3].x) / 2,
                y1: (corners[2].y + corners[3].y) / 2,
                x2: r.x,
                y2: r.y,
                stroke: "#1677ff",
                "stroke-width": 1,
                "vector-effect": "non-scaling-stroke",
            }),
            svgElement("circle", {
                cx: r.x,
                cy: r.y,
                r: 5 * px,
                fill: "#fff",
                stroke: "#1677ff",
                "stroke-width": 1,
                "vector-effect": "non-scaling-stroke",
            }),
        );
    }

    /** Above the top edge's middle, a fixed distance on screen. */
    private rotateHandle(o: LaserObject): Pt {
        return apply(placement(o), { x: o.width / 2, y: o.height + 24 * this.pixel() });
    }

    private setViewBox(box: ViewBox) {
        this.viewBox = box;
        this.svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.w} ${box.h}`);
    }

    /** Bed millimetres per screen pixel. */
    private pixel(): number {
        const rect = this.svg.getBoundingClientRect();
        return rect.width > 0
            ? Math.max(this.viewBox.w / rect.width, this.viewBox.h / Math.max(1, rect.height))
            : 1;
    }

    fit() {
        const { bedWidth: width, bedHeight: height } = this.profile;
        const rect = this.svg.getBoundingClientRect();
        const aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : width / height;
        let w = width * 1.08;
        let h = height * 1.08;
        if (w / h < aspect) w = h * aspect;
        else h = w / aspect;
        this.setViewBox({ x: width / 2 - w / 2, y: height / 2 - h / 2, w, h });
        this.renderOverlay();
    }

    protected setStatus(text: string) {
        this.statusText.textContent = text;
    }

    // ---- pointer ----------------------------------------------------------------------------

    /** The pointer in bed millimetres. */
    private bedPoint(e: { clientX: number; clientY: number }): Pt {
        const ctm = this.world.getScreenCTM();
        if (ctm === null) return { x: 0, y: 0 };
        const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
        return { x: p.x, y: p.y };
    }

    private hitObject(p: Pt): LaserObject | undefined {
        const slack = 3 * this.pixel();
        for (let i = this.data.objects.length - 1; i >= 0; i--) {
            const o = this.data.objects[i];
            const q = apply(invert(placement(o)), p);
            if (q.x >= -slack && q.y >= -slack && q.x <= o.width + slack && q.y <= o.height + slack) return o;
        }
        return undefined;
    }

    private hitHandle(
        o: LaserObject,
        p: Pt,
    ): { kind: "corner"; index: number } | { kind: "rotate" } | undefined {
        const reach = 7 * this.pixel();
        const r = this.rotateHandle(o);
        if (Math.hypot(p.x - r.x, p.y - r.y) <= reach) return { kind: "rotate" };
        const corners = objectCorners(o);
        const index = corners.findIndex((c) => Math.hypot(p.x - c.x, p.y - c.y) <= reach);
        return index < 0 ? undefined : { kind: "corner", index };
    }

    private readonly onPointerDown = (e: PointerEvent) => {
        this.svg.setPointerCapture(e.pointerId);
        if (e.button === 1 || e.button === 2) {
            this.drag = { kind: "pan", x: e.clientX, y: e.clientY, box: { ...this.viewBox } };
            return;
        }
        if (e.button !== 0) return;
        const p = this.bedPoint(e);
        const current = this.selected();
        const handle = current === undefined ? undefined : this.hitHandle(current, p);
        if (current !== undefined && handle !== undefined) {
            const origin = { ...current };
            if (handle.kind === "rotate") {
                const center = apply(placement(current), { x: current.width / 2, y: current.height / 2 });
                const startAngle = Math.atan2(p.y - center.y, p.x - center.x);
                this.drag = { kind: "rotate", id: current.id, center, startAngle, origin };
            } else {
                this.drag = { kind: "scale", id: current.id, corner: handle.index, origin };
            }
            return;
        }
        const hit = this.hitObject(p);
        if (hit === undefined) {
            if (this.selection !== undefined) this.select(undefined);
            this.drag = { kind: "pan", x: e.clientX, y: e.clientY, box: { ...this.viewBox } };
            return;
        }
        if (hit.id !== this.selection) this.select(hit.id);
        this.drag = { kind: "move", id: hit.id, start: p, origin: { ...hit }, moved: false };
    };

    private readonly onPointerMove = (e: PointerEvent) => {
        const p = this.bedPoint(e);
        this.statusPosition.textContent = `X ${p.x.toFixed(1)}  Y ${p.y.toFixed(1)}`;
        const drag = this.drag;
        if (drag === undefined) return;
        if (drag.kind === "pan") {
            const k = this.pixel();
            this.setViewBox({
                ...drag.box,
                x: drag.box.x - (e.clientX - drag.x) * k,
                y: drag.box.y - (e.clientY - drag.y) * k,
            });
            return;
        }
        const o = this.data.objects.find((x) => x.id === drag.id);
        if (o === undefined) return;
        if (drag.kind === "move") {
            const dx = p.x - drag.start.x;
            const dy = p.y - drag.start.y;
            if (!drag.moved && Math.hypot(dx, dy) < 3 * this.pixel()) return;
            drag.moved = true;
            o.x = drag.origin.x + dx;
            o.y = drag.origin.y + dy;
        } else if (drag.kind === "rotate") {
            const a = Math.atan2(p.y - drag.center.y, p.x - drag.center.x);
            let angle = drag.origin.angle + ((a - drag.startAngle) * 180) / Math.PI;
            if (e.shiftKey) angle = Math.round(angle / 15) * 15;
            o.angle = Math.round((((((angle + 180) % 360) + 360) % 360) - 180) * 100) / 100;
        } else {
            Object.assign(o, scaledPlacement(drag.origin, drag.corner, p));
        }
        this.updateObjectTransform(o);
        this.renderOverlay();
    };

    private readonly onPointerUp = (e: PointerEvent) => {
        if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
        const drag = this.drag;
        this.drag = undefined;
        if (drag === undefined || drag.kind === "pan") return;
        if (drag.kind === "move" && !drag.moved) return;
        this.commit();
        this.render();
    };

    private readonly onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const ctm = this.svg.getScreenCTM();
        if (ctm === null) return;
        const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
        const box = this.viewBox;
        const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
        this.setViewBox({
            x: p.x - (p.x - box.x) * factor,
            y: p.y - (p.y - box.y) * factor,
            w: box.w * factor,
            h: box.h * factor,
        });
        this.renderOverlay();
    };

    private readonly onKeyDown = (e: KeyboardEvent) => {
        // the app's own hotkeys listen on window: nothing typed here may reach them
        e.stopPropagation();
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
            return;
        if (typeof e.key !== "string") return;
        const key = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && key === "z") {
            e.preventDefault();
            if (e.shiftKey) this.node.document.history.redo();
            else this.node.document.history.undo();
        } else if ((e.ctrlKey || e.metaKey) && key === "y") {
            e.preventDefault();
            this.node.document.history.redo();
        } else if (key === "delete") {
            e.preventDefault();
            this.deleteSelected();
        } else if (key.startsWith("arrow") && this.selection !== undefined) {
            e.preventDefault();
            this.nudge(key, e.shiftKey ? 10 : 1);
        }
    };

    private nudge(key: string, step: number) {
        const o = this.selected();
        if (o === undefined) return;
        if (key === "arrowleft") o.x -= step;
        if (key === "arrowright") o.x += step;
        if (key === "arrowup") o.y += step;
        if (key === "arrowdown") o.y -= step;
        this.commit();
        this.render();
    }
}

/**
 * The placement after dragging corner `corner` of `origin` to bed point `p`: the opposite
 * corner stays where it is on the bed, the size follows the pointer in the object's own
 * (turned) frame, proportions kept when the object locks them.
 */
export function scaledPlacement(origin: LaserObject, corner: number, p: Pt) {
    const m = placement(origin);
    const q = apply(invert(m), p);
    const [sx, sy] = CORNER_SIGNS[corner];
    const fx = (1 - sx) * origin.width;
    const fy = (1 - sy) * origin.height;
    let w = Math.max(0.1, Math.abs(q.x - fx));
    let h = Math.max(0.1, Math.abs(q.y - fy));
    if (origin.lockAspect && origin.width > 0 && origin.height > 0) {
        const s = Math.max(w / origin.width, h / origin.height);
        w = origin.width * s;
        h = origin.height * s;
    }
    const minU = sx === 1 ? fx : fx - w;
    const minV = sy === 1 ? fy : fy - h;
    const center = apply(m, { x: minU + w / 2, y: minV + h / 2 });
    return { x: center.x - w / 2, y: center.y - h / 2, width: w, height: h };
}

function loadImage(url: string): Promise<HTMLImageElement | undefined> {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image.naturalWidth > 0 ? image : undefined);
        image.onerror = () => resolve(undefined);
        image.src = url;
    });
}

export { loadImage };
