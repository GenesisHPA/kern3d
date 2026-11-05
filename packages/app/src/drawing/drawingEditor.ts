// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    download,
    I18n,
    type I18nKeys,
    type INode,
    PubSub,
    ShapeNode,
    Transaction,
    type WorkspaceTab,
    workspaceTabs,
} from "@chili3d/core";
import {
    autoDimension,
    autoDrawing,
    dimensionKey,
    featureDimensions,
    sectionThrough,
    settleSectionLabels,
} from "./autoDrawing";
import {
    composeDrawing,
    fromSheet,
    linearGeometry,
    placementOf,
    toSheet,
    type ViewPlacement,
} from "./compose";
import {
    type DrawingData,
    isRadialDimension,
    type LinearDimensionKind,
    newDrawingItemId,
    type Point2,
    type ProjectionSide,
} from "./drawingData";
import style from "./drawingEditor.module.css";
import { loadDrawingFont } from "./drawingFont";
import type { DrawingNode } from "./drawingNode";
import { DrawingPanel, type DrawingPanelHost } from "./drawingPanel";
import {
    alignProjectedViews,
    findSourceNode,
    isometricView,
    layoutStandardViews,
    newView,
    projectedView,
    removeView,
    resolveSource,
    ViewGeometryCache,
} from "./drawingViews";
import { sheetToDxf } from "./dxfExport";
import type { ViewGeometry } from "./hlr";
import { sheetToPdf } from "./pdfExport";
import { type ComposedSheet, ownerBounds, type Rect } from "./primitives";
import { primitivesMarkup, sheetToSvg } from "./svgExport";

const SVG_NS = "http://www.w3.org/2000/svg";
const SNAP_PIXELS = 10;

type Tool =
    | { kind: "select" }
    | { kind: "baseView" }
    | { kind: "projected"; parentId: string }
    | { kind: "linear"; dimension: LinearDimensionKind; picks: { viewId: string; point: Point2 }[] }
    | { kind: "radial"; dimension: "diameter" | "radius" }
    | { kind: "note" }
    | { kind: "feature" };

type Drag =
    | { kind: "pan"; x: number; y: number; box: ViewBox }
    | { kind: "owner"; owner: string; start: Point2; moved: boolean; origin: DrawingData };

interface ViewBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

interface Snap {
    viewId: string;
    point: Point2;
    sheet: Point2;
}

function svgElement<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attributes: Record<string, string | number> = {},
) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attributes)) e.setAttribute(k, String(v));
    return e;
}

function t(key: string): string {
    return I18n.translate(key as I18nKeys);
}

/**
 * The sheet editor: a workspace over the 3D view with a toolbar, the sheet, and a property
 * panel for whatever is selected. It lives in a tab beside the document tabs — clicking the
 * document's tab goes back to the model, the drawing's tab comes back to the sheet, and its ×
 * closes it; several drawings can be open at once. Every change is written back to the node in
 * one transaction (so undo/redo in the editor are the document's), and the views are
 * projected again from the model whenever it changes.
 */
export class DrawingEditor {
    private static readonly editors = new Map<string, DrawingEditor>();

    static open(node: DrawingNode) {
        let editor = DrawingEditor.editors.get(node.id);
        if (editor === undefined) {
            editor = new DrawingEditor(node);
            DrawingEditor.editors.set(node.id, editor);
            editor.mount();
        }
        workspaceTabs.open(editor.tab);
    }

    /** Whether a drawing is in front of the 3D view. */
    static get isOpen() {
        const active = workspaceTabs.active;
        return active !== undefined && DrawingEditor.editors.has(active);
    }

    private readonly tab: WorkspaceTab;

    private readonly dialog: HTMLDialogElement;
    private readonly svg: SVGSVGElement;
    private readonly paper: SVGRectElement;
    private readonly sheetGroup: SVGGElement;
    private readonly hitGroup: SVGGElement;
    private readonly overlayGroup: SVGGElement;
    private readonly status: HTMLDivElement;
    private readonly toolButtons = new Map<string, HTMLButtonElement>();
    private readonly sourceSelect: HTMLSelectElement;
    private readonly panel: DrawingPanel;
    private readonly cache: ViewGeometryCache;
    private data: DrawingData;
    private committed: string;
    private geometries = new Map<string, ViewGeometry>();
    private composed: ComposedSheet = { width: 0, height: 0, primitives: [] };
    private bounds = new Map<string, Rect>();
    private selection: string | undefined;
    private tool: Tool = { kind: "select" };
    private drag: Drag | undefined;
    private viewBox: ViewBox = { x: 0, y: 0, w: 420, h: 297 };
    private watched = new Set<INode>();
    private refreshPending = false;

    private constructor(private readonly node: DrawingNode) {
        this.tab = {
            id: node.id,
            title: () => this.node.name,
            icon: "icon-file-plus",
            show: () => this.reveal(),
            hide: () => this.conceal(),
            close: () => this.close(),
        };
        this.data = node.data;
        this.committed = node.content;
        const document = node.document;
        this.cache = new ViewGeometryCache((id) => resolveSource(document, id));
        this.dialog = window.document.createElement("dialog");
        this.dialog.className = style.dialog;
        this.svg = svgElement("svg", { class: style.canvas });
        this.paper = svgElement("rect", { fill: "#fff" });
        this.sheetGroup = svgElement("g");
        this.hitGroup = svgElement("g");
        this.overlayGroup = svgElement("g");
        this.svg.append(this.paper, this.sheetGroup, this.hitGroup, this.overlayGroup);
        this.status = window.document.createElement("div");
        this.status.className = style.status;
        this.sourceSelect = window.document.createElement("select");
        this.panel = new DrawingPanel(this.panelHost());
        const root = window.document.createElement("div");
        root.className = style.root;
        root.tabIndex = -1;
        const body = window.document.createElement("div");
        body.className = style.body;
        body.append(this.svg, this.panel.element);
        root.append(this.createToolbar(), body, this.status);
        this.dialog.append(root);
    }

    // ---- lifecycle ------------------------------------------------------------------------

    /** Builds the editor once; `reveal` / `conceal` then show and hide it as its tab is picked. */
    private mount() {
        window.document.body.append(this.dialog);
        this.dialog.addEventListener("cancel", this.onCancel);
        this.dialog.addEventListener("keydown", this.onKeyDown);
        this.svg.addEventListener("pointerdown", this.onPointerDown);
        this.svg.addEventListener("pointermove", this.onPointerMove);
        this.svg.addEventListener("pointerup", this.onPointerUp);
        this.svg.addEventListener("wheel", this.onWheel, { passive: false });
        this.svg.addEventListener("contextmenu", (e) => e.preventDefault());
        this.node.onPropertyChanged(this.onNodeChanged);
        this.refresh();
    }

    private fitted = false;

    /** In front of the 3D view (non-modal: the tab strip above stays usable). */
    private reveal() {
        if (!this.dialog.open) this.dialog.show();
        if (!this.fitted) {
            this.fitted = true;
            this.fit();
        }
        (this.dialog.firstElementChild as HTMLElement).focus();
    }

    /** Out of the way so the model is seen; the sheet keeps its state. */
    private conceal() {
        if (this.dialog.open) this.dialog.close();
    }

    close() {
        this.unwatchSources();
        this.node.removePropertyChanged(this.onNodeChanged);
        this.dialog.close();
        this.dialog.remove();
        DrawingEditor.editors.delete(this.node.id);
        workspaceTabs.remove(this.node.id);
    }

    private readonly onCancel = (e: Event) => {
        e.preventDefault();
        this.escape();
    };

    private readonly onNodeChanged = (property: string | number | symbol) => {
        if (property === "name") workspaceTabs.changed();
        if (property !== "content" || this.node.content === this.committed) return;
        // undo / redo replaced the description under us
        this.committed = this.node.content;
        this.data = this.node.data;
        if (this.selection !== undefined && !this.ownerExists(this.selection)) this.selection = undefined;
        this.refresh();
    };

    private watchSources() {
        const wanted = new Set<INode>();
        for (const view of this.data.views) {
            const node = findSourceNode(this.node.document, view.sourceId);
            if (node !== undefined) wanted.add(node);
        }
        for (const node of this.watched) {
            if (!wanted.has(node)) node.removePropertyChanged(this.onSourceChanged);
        }
        for (const node of wanted) {
            if (!this.watched.has(node)) node.onPropertyChanged(this.onSourceChanged);
        }
        this.watched = wanted;
    }

    private unwatchSources() {
        for (const node of this.watched) node.removePropertyChanged(this.onSourceChanged);
        this.watched.clear();
    }

    private readonly onSourceChanged = (property: string | number | symbol) => {
        if (property === "shape" || property === "transform") this.scheduleRefresh();
    };

    private scheduleRefresh() {
        if (this.refreshPending) return;
        this.refreshPending = true;
        setTimeout(() => {
            this.refreshPending = false;
            this.refresh();
        }, 150);
    }

    // ---- data -----------------------------------------------------------------------------

    /** Writes the working description back to the node as one undoable step. */
    commit() {
        alignProjectedViews(this.data);
        const content = JSON.stringify(this.data);
        if (content === this.committed) return;
        this.committed = content;
        Transaction.execute(this.node.document, "drawing", () => {
            this.node.content = content;
        });
    }

    private ownerExists(owner: string): boolean {
        const [kind, id] = owner.split(":");
        if (kind === "view") return this.data.views.some((v) => v.id === id);
        if (kind === "dim") return this.data.dimensions.some((d) => d.id === id);
        if (kind === "note") return this.data.notes.some((n) => n.id === id);
        return false;
    }

    private placement(viewId: string): ViewPlacement | undefined {
        const view = this.data.views.find((v) => v.id === viewId);
        return view === undefined ? undefined : placementOf(view, this.geometries.get(view.id));
    }

    private geometryOf = (view: DrawingData["views"][number]) => this.cache.geometryOf(view);

    private shapeNodes(): ShapeNode[] {
        return this.node.document.modelManager
            .findNodes((n) => n instanceof ShapeNode && !n.isReferenceGeometry && n.shape.isOk)
            .filter((n): n is ShapeNode => n instanceof ShapeNode);
    }

    private currentSource(): string | undefined {
        return this.sourceSelect.value || this.data.views[0]?.sourceId;
    }

    // ---- rendering --------------------------------------------------------------------------

    refresh(recompute = false) {
        if (recompute) this.cache.clear();
        alignProjectedViews(this.data);
        this.geometries = this.cache.all(this.data);
        this.composed = composeDrawing(this.data, this.geometries);
        this.bounds = ownerBounds(this.composed.primitives);
        const { width, height } = this.composed;
        this.paper.setAttribute("width", String(width));
        this.paper.setAttribute("height", String(height));
        const flip = `matrix(1 0 0 -1 0 ${height})`;
        for (const g of [this.sheetGroup, this.hitGroup, this.overlayGroup])
            g.setAttribute("transform", flip);
        this.sheetGroup.innerHTML = primitivesMarkup(this.composed.primitives, "owner");
        this.sheetGroup.setAttribute("color", "#000");
        this.drawHitAreas();
        this.drawSelection();
        this.updateSources();
        this.watchSources();
        this.panel.render();
        this.updateStatus();
    }

    private drawHitAreas() {
        this.hitGroup.replaceChildren();
        const owners = [...this.bounds.keys()].sort(
            (a, b) => Number(!a.startsWith("view:")) - Number(!b.startsWith("view:")),
        );
        for (const owner of owners) {
            const r = this.bounds.get(owner)!;
            const pad = owner.startsWith("view:") ? 2 : 1;
            this.hitGroup.append(
                svgElement("rect", {
                    x: r.minX - pad,
                    y: r.minY - pad,
                    width: r.maxX - r.minX + 2 * pad,
                    height: r.maxY - r.minY + 2 * pad,
                    fill: "transparent",
                    "data-hit": owner,
                }),
            );
        }
    }

    private drawSelection() {
        for (const g of this.sheetGroup.querySelectorAll<SVGGElement>("g[data-owner]")) {
            g.setAttribute("color", g.dataset["owner"] === this.selection ? "#1677ff" : "#000");
        }
        this.overlayGroup.replaceChildren();
        const r = this.selection === undefined ? undefined : this.bounds.get(this.selection);
        if (r !== undefined) {
            this.overlayGroup.append(
                svgElement("rect", {
                    x: r.minX - 2,
                    y: r.minY - 2,
                    width: r.maxX - r.minX + 4,
                    height: r.maxY - r.minY + 4,
                    fill: "none",
                    stroke: "#1677ff",
                    "stroke-width": 0.3,
                    "stroke-dasharray": "2 1",
                    "pointer-events": "none",
                }),
            );
        }
    }

    private marker(x: number, y: number, radius = 1.2) {
        this.overlayGroup.append(
            svgElement("circle", {
                cx: x,
                cy: y,
                r: radius,
                fill: "none",
                stroke: "#e8590c",
                "stroke-width": 0.35,
                "pointer-events": "none",
            }),
        );
    }

    private setViewBox(box: ViewBox) {
        this.viewBox = box;
        this.svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.w} ${box.h}`);
    }

    fit() {
        const { width, height } = this.composed;
        const rect = this.svg.getBoundingClientRect();
        const aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : width / height;
        const margin = 0.05;
        let w = width * (1 + 2 * margin);
        let h = height * (1 + 2 * margin);
        if (w / h < aspect) w = h * aspect;
        else h = w / aspect;
        this.setViewBox({ x: width / 2 - w / 2, y: height / 2 - h / 2, w, h });
    }

    private updateSources() {
        const nodes = this.shapeNodes();
        const current = this.currentSource();
        this.sourceSelect.replaceChildren(
            ...nodes.map((n) => {
                const option = window.document.createElement("option");
                option.value = n.id;
                option.textContent = n.name;
                option.selected = n.id === current;
                return option;
            }),
        );
    }

    private updateStatus() {
        const prompts: Record<Tool["kind"], string> = {
            select: "drawing.prompt.select",
            baseView: "drawing.prompt.placeView",
            projected: "drawing.prompt.placeProjected",
            linear: "drawing.prompt.pickPoint",
            radial: "drawing.prompt.pickCircle",
            note: "drawing.prompt.placeNote",
            feature: "drawing.prompt.pickFeature",
        };
        let text = t(prompts[this.tool.kind]);
        if (this.tool.kind === "linear" && this.tool.picks.length === 2)
            text = t("drawing.prompt.placeDimension");
        this.status.textContent = text;
        for (const [key, button] of this.toolButtons) {
            const active = key === this.toolKey();
            button.classList.toggle(style.active, active);
        }
    }

    private toolKey(): string {
        if (this.tool.kind === "linear" || this.tool.kind === "radial") return this.tool.dimension;
        return this.tool.kind;
    }

    // ---- toolbar ----------------------------------------------------------------------------

    private button(key: string, action: () => void, toolKey?: string): HTMLButtonElement {
        const b = window.document.createElement("button");
        b.textContent = t(key);
        b.onclick = action;
        if (toolKey !== undefined) this.toolButtons.set(toolKey, b);
        return b;
    }

    private separator() {
        const s = window.document.createElement("div");
        s.className = style.separator;
        return s;
    }

    private createToolbar(): HTMLElement {
        const bar = window.document.createElement("div");
        bar.className = style.toolbar;
        this.sourceSelect.title = t("drawing.view.source");
        bar.append(
            this.button("drawing.select", () => this.setTool({ kind: "select" }), "select"),
            this.separator(),
            this.sourceSelect,
            this.button("drawing.baseView", () => this.setTool({ kind: "baseView" }), "baseView"),
            this.button("drawing.standardViews", () => this.addStandardViews()),
            this.button("drawing.auto", () => this.autoDrawing()),
            this.button("drawing.autoDims", () => this.autoDimensions()),
            this.button("drawing.featureDims", () => this.setTool({ kind: "feature" }), "feature"),
            this.button("drawing.projectedView", () => this.startProjected(), "projected"),
            this.separator(),
            this.button("drawing.dim.horizontal", () => this.startLinear("horizontal"), "horizontal"),
            this.button("drawing.dim.vertical", () => this.startLinear("vertical"), "vertical"),
            this.button("drawing.dim.aligned", () => this.startLinear("aligned"), "aligned"),
            this.button(
                "drawing.dim.diameter",
                () => this.setTool({ kind: "radial", dimension: "diameter" }),
                "diameter",
            ),
            this.button(
                "drawing.dim.radius",
                () => this.setTool({ kind: "radial", dimension: "radius" }),
                "radius",
            ),
            this.button("drawing.note", () => this.setTool({ kind: "note" }), "note"),
            this.separator(),
            this.button("drawing.delete", () => this.deleteSelection()),
            this.button("drawing.update", () => this.refresh(true)),
            this.button("drawing.fit", () => this.fit()),
            this.separator(),
            this.button("drawing.export.svg", () => this.exportSvg()),
            this.button("drawing.export.pdf", () => void this.exportPdf()),
            this.button("drawing.export.dxf", () => this.exportDxf()),
            this.separator(),
            this.button("drawing.toModel", () => workspaceTabs.activate(undefined)),
            this.button("drawing.close", () => this.close()),
        );
        return bar;
    }

    private setTool(tool: Tool) {
        this.tool = tool;
        this.drawSelection();
        this.updateStatus();
    }

    private startLinear(dimension: LinearDimensionKind) {
        this.setTool({ kind: "linear", dimension, picks: [] });
    }

    private startProjected() {
        const view = this.selectedView();
        if (view === undefined) {
            PubSub.default.pub("showToast", "toast.drawing.selectView");
            return;
        }
        this.setTool({ kind: "projected", parentId: view.id });
    }

    private addStandardViews() {
        const source = this.currentSource();
        if (source === undefined) {
            PubSub.default.pub("showToast", "toast.drawing.selectBody");
            return;
        }
        layoutStandardViews(this.data, source, this.geometryOf);
        this.commit();
        this.refresh();
    }

    /** Rebuilds the sheet by the rules: views, cuts, centre lines and dimensions. */
    private autoDrawing() {
        const source = this.currentSource();
        if (source === undefined) {
            PubSub.default.pub("showToast", "toast.drawing.selectBody");
            return;
        }
        this.selection = undefined;
        autoDrawing(this.data, source, this.cache);
        this.commit();
        this.refresh();
    }

    /** Replaces the automatic dimensions (hand-placed ones stay) and spaces the views for them. */
    private autoDimensions() {
        const source = this.currentSource();
        if (source === undefined) {
            PubSub.default.pub("showToast", "toast.drawing.selectBody");
            return;
        }
        if (this.selection?.startsWith("dim:")) this.selection = undefined;
        settleSectionLabels(this.data, this.cache.all(this.data));
        autoDimension(this.data, source, this.cache);
        this.commit();
        this.refresh();
    }

    /** Turns a view into a full cut through the most holes across it, or back into a view. */
    setSection(viewId: string, on: boolean) {
        const view = this.data.views.find((v) => v.id === viewId);
        if (view === undefined) return;
        if (!on) {
            view.section = undefined;
        } else {
            const input = this.cache.inputFor(view.sourceId);
            view.section = sectionThrough(this.data, view, input);
            view.showHidden = false;
        }
        this.refresh(true);
        settleSectionLabels(this.data, this.geometries);
        this.commit();
        this.refresh();
    }

    private escape() {
        if (this.tool.kind !== "select") this.setTool({ kind: "select" });
        else if (this.selection !== undefined) this.select(undefined);
        // nothing left to drop: back to the model, the drawing stays open in its tab
        else workspaceTabs.activate(undefined);
    }

    // ---- selection & editing ------------------------------------------------------------------

    select(owner: string | undefined) {
        this.selection = owner;
        this.drawSelection();
        this.panel.render();
    }

    private selectedView() {
        if (!this.selection?.startsWith("view:")) return undefined;
        const id = this.selection.slice(5);
        return this.data.views.find((v) => v.id === id);
    }

    deleteSelection() {
        const owner = this.selection;
        if (owner === undefined) return;
        const [kind, id] = owner.split(":");
        if (kind === "view") removeView(this.data, id);
        if (kind === "dim") {
            const dim = this.data.dimensions.find((d) => d.id === id);
            const key = dim?.auto ? dimensionKey(this.data, dim) : undefined;
            if (key !== undefined)
                this.data.suppressed = [...new Set([...(this.data.suppressed ?? []), key])];
            this.data.dimensions = this.data.dimensions.filter((d) => d.id !== id);
        }
        if (kind === "note") this.data.notes = this.data.notes.filter((n) => n.id !== id);
        this.selection = undefined;
        this.commit();
        this.refresh();
    }

    addProjected(parentId: string, side: ProjectionSide) {
        const parent = this.data.views.find((v) => v.id === parentId);
        if (parent === undefined) return;
        const view = projectedView(this.data, parent, side, this.geometryOf);
        this.data.views.push(view);
        this.selection = `view:${view.id}`;
        this.commit();
        this.refresh();
    }

    addIsometric(parentId: string) {
        const parent = this.data.views.find((v) => v.id === parentId);
        if (parent === undefined) return;
        const view = isometricView(this.data, parent, this.geometryOf);
        this.data.views.push(view);
        this.selection = `view:${view.id}`;
        this.commit();
        this.refresh();
    }

    // ---- pointer --------------------------------------------------------------------------------

    private sheetPoint(e: PointerEvent | WheelEvent): Point2 {
        const ctm = this.svg.getScreenCTM();
        if (ctm === null) return [0, 0];
        const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
        return [p.x, this.composed.height - p.y];
    }

    /** Sheet millimetres per screen pixel. */
    private pixel(): number {
        const rect = this.svg.getBoundingClientRect();
        return rect.width > 0 ? this.viewBox.w / rect.width : 1;
    }

    private nearestVertex(p: Point2, viewId?: string): Snap | undefined {
        let best: Snap | undefined;
        let bestDistance = SNAP_PIXELS * this.pixel();
        for (const view of this.data.views) {
            if (viewId !== undefined && view.id !== viewId) continue;
            const placement = this.placement(view.id);
            const g = placement?.geometry;
            if (placement === undefined || g === undefined) continue;
            for (let k = 0; k + 1 < g.vertices.length; k += 2) {
                const s = toSheet(placement, g.vertices[k], g.vertices[k + 1]);
                const d = Math.hypot(s[0] - p[0], s[1] - p[1]);
                if (d < bestDistance) {
                    bestDistance = d;
                    best = { viewId: view.id, point: [g.vertices[k], g.vertices[k + 1]], sheet: s };
                }
            }
        }
        return best;
    }

    private nearestCircle(p: Point2) {
        let best: { viewId: string; center: Point2; radius: number } | undefined;
        let bestDistance = SNAP_PIXELS * this.pixel();
        for (const view of this.data.views) {
            const placement = this.placement(view.id);
            const g = placement?.geometry;
            if (placement === undefined || g === undefined) continue;
            const candidates = [
                ...g.circles,
                ...g.visible.flatMap((l) =>
                    l.arc === undefined ? [] : [{ cx: l.arc.cx, cy: l.arc.cy, r: l.arc.r }],
                ),
            ];
            for (const c of candidates) {
                const s = toSheet(placement, c.cx, c.cy);
                const d = Math.abs(Math.hypot(s[0] - p[0], s[1] - p[1]) - c.r * view.scale);
                if (d < bestDistance) {
                    bestDistance = d;
                    best = { viewId: view.id, center: [c.cx, c.cy], radius: c.r };
                }
            }
        }
        return best;
    }

    private viewAt(p: Point2): string | undefined {
        for (const view of this.data.views) {
            const r = this.bounds.get(`view:${view.id}`);
            if (r !== undefined && p[0] >= r.minX && p[0] <= r.maxX && p[1] >= r.minY && p[1] <= r.maxY) {
                return view.id;
            }
        }
        return undefined;
    }

    private readonly onPointerDown = (e: PointerEvent) => {
        this.svg.setPointerCapture(e.pointerId);
        if (e.button === 1 || e.button === 2) {
            this.drag = { kind: "pan", x: e.clientX, y: e.clientY, box: { ...this.viewBox } };
            return;
        }
        if (e.button !== 0) return;
        const p = this.sheetPoint(e);
        if (this.tool.kind !== "select") {
            this.toolClick(p);
            return;
        }
        const hit = (e.target as Element).closest("[data-hit]")?.getAttribute("data-hit") ?? undefined;
        this.select(hit);
        this.drag =
            hit === undefined
                ? { kind: "pan", x: e.clientX, y: e.clientY, box: { ...this.viewBox } }
                : { kind: "owner", owner: hit, start: p, moved: false, origin: structuredClone(this.data) };
    };

    private readonly onPointerMove = (e: PointerEvent) => {
        const drag = this.drag;
        if (drag?.kind === "pan") {
            const k = this.pixel();
            this.setViewBox({
                ...drag.box,
                x: drag.box.x - (e.clientX - drag.x) * k,
                y: drag.box.y - (e.clientY - drag.y) * k,
            });
            return;
        }
        const p = this.sheetPoint(e);
        if (drag?.kind === "owner") {
            this.dragOwner(drag, p);
            return;
        }
        this.preview(p);
    };

    private readonly onPointerUp = (e: PointerEvent) => {
        if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
        const drag = this.drag;
        this.drag = undefined;
        if (drag?.kind === "owner" && drag.moved) {
            // a dimension placed by hand is the user's: automatic runs keep it where it is
            if (drag.owner.startsWith("dim:")) {
                const dim = this.data.dimensions.find((d) => d.id === drag.owner.slice(4));
                if (dim !== undefined) dim.auto = undefined;
            }
            this.commit();
        }
    };

    private readonly onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const ctm = this.svg.getScreenCTM();
        if (ctm === null) return;
        const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
        const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
        const box = this.viewBox;
        this.setViewBox({
            x: p.x - (p.x - box.x) * factor,
            y: p.y - (p.y - box.y) * factor,
            w: box.w * factor,
            h: box.h * factor,
        });
    };

    private readonly onKeyDown = (e: KeyboardEvent) => {
        // the app's own hotkeys listen on window: nothing typed here may reach them
        e.stopPropagation();
        const target = e.target as HTMLElement;
        const typing =
            target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
        if (typing) return;
        if (typeof e.key !== "string") return; // autofill keydowns carry no key
        const key = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && key === "z") {
            e.preventDefault();
            if (e.shiftKey) this.node.document.history.redo();
            else this.node.document.history.undo();
        } else if ((e.ctrlKey || e.metaKey) && key === "y") {
            e.preventDefault();
            this.node.document.history.redo();
        } else if (key === "delete" || key === "backspace") {
            e.preventDefault();
            this.deleteSelection();
        }
    };

    private dragOwner(drag: Extract<Drag, { kind: "owner" }>, p: Point2) {
        const dx = p[0] - drag.start[0];
        const dy = p[1] - drag.start[1];
        if (!drag.moved && Math.hypot(dx, dy) < 3 * this.pixel()) return;
        drag.moved = true;
        const [kind, id] = drag.owner.split(":");
        const origin = drag.origin;
        if (kind === "view") {
            const view = this.data.views.find((v) => v.id === id);
            const start = origin.views.find((v) => v.id === id);
            if (view === undefined || start === undefined) return;
            const horizontal = view.side === "right" || view.side === "left";
            if (view.parentId === undefined || horizontal) view.x = start.x + dx;
            if (view.parentId === undefined || !horizontal) view.y = start.y + dy;
        } else if (kind === "note") {
            const note = this.data.notes.find((n) => n.id === id);
            const start = origin.notes.find((n) => n.id === id);
            if (note === undefined || start === undefined) return;
            note.x = start.x + dx;
            note.y = start.y + dy;
        } else if (kind === "dim") {
            this.dragDimension(id, p);
        }
        this.requestRender();
    }

    private dragDimension(id: string, p: Point2) {
        const d = this.data.dimensions.find((x) => x.id === id);
        const placement = d === undefined ? undefined : this.placement(d.viewId);
        if (d === undefined || placement === undefined) return;
        if (isRadialDimension(d)) {
            const [cx, cy] = toSheet(placement, d.center[0], d.center[1]);
            d.angle = (Math.atan2(p[1] - cy, p[0] - cx) * 180) / Math.PI;
            return;
        }
        const g = linearGeometry(placement, { ...d, offset: 0 });
        const p1 = toSheet(placement, d.a[0], d.a[1]);
        d.offset = (p[0] - p1[0]) * g.normal[0] + (p[1] - p1[1]) * g.normal[1];
    }

    private requestRender() {
        if (this.refreshPending) return;
        this.refreshPending = true;
        requestAnimationFrame(() => {
            this.refreshPending = false;
            this.refresh();
        });
    }

    private preview(p: Point2) {
        if (this.tool.kind === "select") return;
        this.drawSelection();
        if (this.tool.kind === "linear") {
            const viewId = this.tool.picks[0]?.viewId;
            if (this.tool.picks.length < 2) {
                const snap = this.nearestVertex(p, viewId);
                if (snap !== undefined) this.marker(snap.sheet[0], snap.sheet[1]);
            }
            for (const pick of this.tool.picks) {
                const placement = this.placement(pick.viewId);
                if (placement !== undefined)
                    this.marker(...toSheet(placement, pick.point[0], pick.point[1]), 0.8);
            }
        } else if (this.tool.kind === "radial") {
            const circle = this.nearestCircle(p);
            const placement = circle === undefined ? undefined : this.placement(circle.viewId);
            if (circle !== undefined && placement !== undefined) {
                const [x, y] = toSheet(placement, circle.center[0], circle.center[1]);
                this.marker(x, y, circle.radius * placement.view.scale);
            }
        }
    }

    private toolClick(p: Point2) {
        const tool = this.tool;
        switch (tool.kind) {
            case "baseView":
                this.placeBaseView(p);
                return;
            case "projected":
                this.placeProjected(tool.parentId, p);
                return;
            case "linear":
                this.linearClick(tool, p);
                return;
            case "radial":
                this.radialClick(tool.dimension, p);
                return;
            case "note":
                this.placeNote(p);
                return;
            case "feature":
                this.featureClick(p);
                return;
        }
    }

    /** "Размеры элемента": the clicked hole, cylinder or face gets its dimensions by the rules. */
    private featureClick(p: Point2) {
        const viewId = this.viewAt(p);
        const placement = viewId === undefined ? undefined : this.placement(viewId);
        if (viewId === undefined || placement === undefined) return;
        const dims = featureDimensions(this.data, viewId, fromSheet(placement, p[0], p[1]), this.cache);
        if (dims.length === 0) {
            PubSub.default.pub("showToast", "toast.drawing.noFeature");
            return;
        }
        this.data.dimensions.push(...dims);
        this.commit();
        this.refresh();
    }

    private placeBaseView(p: Point2) {
        const source = this.currentSource();
        if (source === undefined) {
            PubSub.default.pub("showToast", "toast.drawing.selectBody");
            return;
        }
        const base = this.data.views.find((v) => v.parentId === undefined);
        const view = newView(source, "front", base?.scale ?? 1, p[0], p[1]);
        this.data.views.push(view);
        this.selection = `view:${view.id}`;
        this.tool = { kind: "select" };
        this.commit();
        this.refresh();
    }

    private placeProjected(parentId: string, p: Point2) {
        const parent = this.data.views.find((v) => v.id === parentId);
        if (parent === undefined) return;
        const dx = p[0] - parent.x;
        const dy = p[1] - parent.y;
        const side: ProjectionSide =
            Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "right" : "left") : dy >= 0 ? "up" : "down";
        const view = projectedView(this.data, parent, side, this.geometryOf);
        if (side === "right" || side === "left") view.x = p[0];
        else view.y = p[1];
        this.data.views.push(view);
        this.selection = `view:${view.id}`;
        this.commit();
        this.refresh();
    }

    private linearClick(tool: Extract<Tool, { kind: "linear" }>, p: Point2) {
        if (tool.picks.length < 2) {
            const snap = this.nearestVertex(p, tool.picks[0]?.viewId);
            if (snap === undefined) {
                const viewId = tool.picks[0]?.viewId ?? this.viewAt(p);
                const placement = viewId === undefined ? undefined : this.placement(viewId);
                if (viewId === undefined || placement === undefined) return;
                tool.picks.push({ viewId, point: fromSheet(placement, p[0], p[1]) });
            } else {
                tool.picks.push({ viewId: snap.viewId, point: snap.point });
            }
            this.preview(p);
            this.updateStatus();
            return;
        }
        const [a, b] = tool.picks;
        const placement = this.placement(a.viewId);
        if (placement === undefined) return;
        const draft = {
            id: newDrawingItemId("d"),
            kind: tool.dimension,
            viewId: a.viewId,
            a: a.point,
            b: b.point,
            offset: 0,
        };
        const g = linearGeometry(placement, draft);
        const p1 = toSheet(placement, a.point[0], a.point[1]);
        draft.offset = (p[0] - p1[0]) * g.normal[0] + (p[1] - p1[1]) * g.normal[1];
        this.data.dimensions.push(draft);
        this.tool = { kind: "linear", dimension: tool.dimension, picks: [] };
        this.commit();
        this.refresh();
    }

    private radialClick(dimension: "diameter" | "radius", p: Point2) {
        const circle = this.nearestCircle(p);
        const placement = circle === undefined ? undefined : this.placement(circle.viewId);
        if (circle === undefined || placement === undefined) return;
        const [cx, cy] = toSheet(placement, circle.center[0], circle.center[1]);
        const angle = (Math.atan2(p[1] - cy, p[0] - cx) * 180) / Math.PI;
        this.data.dimensions.push({
            id: newDrawingItemId("d"),
            kind: dimension,
            viewId: circle.viewId,
            center: circle.center,
            radius: circle.radius,
            angle,
        });
        this.commit();
        this.refresh();
    }

    private placeNote(p: Point2) {
        const note = {
            id: newDrawingItemId("n"),
            x: p[0],
            y: p[1],
            text: t("drawing.note.default"),
            height: 3.5,
        };
        this.data.notes.push(note);
        this.selection = `note:${note.id}`;
        this.tool = { kind: "select" };
        this.commit();
        this.refresh();
        this.panel.focusText();
    }

    // ---- export ---------------------------------------------------------------------------------

    private fileName(extension: string) {
        return `${this.node.name.replace(/[\\/:*?"<>|]+/g, "_")}.${extension}`;
    }

    private exportSvg() {
        download([sheetToSvg(this.composed)], this.fileName("svg"));
    }

    private exportDxf() {
        download([sheetToDxf(this.composed)], this.fileName("dxf"));
    }

    private async exportPdf() {
        this.status.textContent = t("drawing.prompt.exporting");
        const font = await loadDrawingFont();
        if (font === undefined) PubSub.default.pub("showToast", "toast.drawing.fontFallback");
        download([sheetToPdf(this.composed, font) as BlobPart], this.fileName("pdf"));
        this.updateStatus();
    }

    // ---- what the panel works on -------------------------------------------------------------------

    private panelHost(): DrawingPanelHost {
        return {
            data: () => this.data,
            selection: () => this.selection,
            geometry: (viewId: string) => this.geometries.get(viewId),
            sourceName: (id: string) => findSourceNode(this.node.document, id)?.name,
            change: (recompute = false) => {
                this.commit();
                this.refresh(recompute);
            },
            addProjected: (parentId: string, side: ProjectionSide) => this.addProjected(parentId, side),
            addIsometric: (parentId: string) => this.addIsometric(parentId),
            setSection: (viewId: string, on: boolean) => this.setSection(viewId, on),
            restoreAuto: () => {
                this.data.suppressed = undefined;
                this.autoDimensions();
            },
            remove: () => this.deleteSelection(),
        };
    }
}
