// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    download,
    type FontOutline,
    type IDocument,
    PubSub,
    readBinaryFileAsync,
    readFileAsync,
    ShapeNode,
    ShapeTypes,
    Transaction,
    type WorkspaceTab,
    workspaceTabs,
} from "@chili3d/core";
import { DrawingNode } from "../drawing/drawingNode";
import { exportEzd } from "./ezdExport";
import { importEzd } from "./ezdImport";
import { framePaths } from "./framePaths";
import { bodyOutline, drawingSheet, faceOutline, type ModelView } from "./fromModel";
import { type Affine, apply, type Bounds, invert, type LaserPath, type Pt } from "./geometry";
import { BeamAnimation, type BeamProgress } from "./laserBeam";
import {
    defaultOperation,
    type LaserJobData,
    type LaserObject,
    type LaserVectorObject,
    newLaserId,
    objectCorners,
    objectMatrix,
    placement,
    withOrigin,
} from "./laserData";
import {
    constrainAngle,
    type Draft,
    type DrawnFigure,
    type DrawTool,
    draftPaths,
    finishBox,
    finishPolyline,
    type PolygonDefaults,
    snapToGrid,
    TOOL_KEYS,
} from "./laserDraw";
import type { DriverEvent } from "./laserDriver";
import style from "./laserEditor.module.css";
import { defaultLaserFont, loadLaserFont } from "./laserFonts";
import { toolIcon } from "./laserIcons";
import { LaserJobPanel, type LaserJobPanelHost, MODE_COLORS } from "./laserJobPanel";
import { newLaserJob, openLaserHome } from "./laserJobs";
import { LaserMachine } from "./laserMachine";
import { LaserNode } from "./laserNode";
import { LaserOutput } from "./laserOutput";
import { button, el, t } from "./laserUi";
import { bedRect, loadMachineProfile, type MachineProfile, saveMachineProfile } from "./machineProfile";
import {
    breakAt,
    deleteNode,
    flattenSubPaths,
    hitSegment,
    insertNode,
    joinAt,
    moveHandle,
    moveNode,
    smoothStroke,
    subPathsFromOutlines,
    toggleSmooth,
} from "./pathShape";
import { type RotaryStep, rotarySteps } from "./rotary";
import { Rotary3DView } from "./rotary3d";
import { rotary3dSource } from "./rotary3dSource";
import { defaultScale } from "./scaleShape";
import {
    type Align,
    alignObjects,
    boundsOf,
    distributeObjects,
    inside,
    moveAll,
    normalizeAngle,
    type Placement,
    rotateAll,
    scaleAll,
} from "./selection";
import { bakeSize, convertToPath, pathObject, rebuildPath, regenerate, shapeObject } from "./shapeObject";
import type { LaserFontRef } from "./shapes";
import { defaultQuiet, type LaserShape, needsFont } from "./shapes";
import type { SvgImport } from "./svgImport";
import { importSvg } from "./svgImport";
import { formatDuration } from "./toolpath";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgElement<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attributes: Record<string, string | number> = {},
) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attributes)) e.setAttribute(k, String(v));
    return e;
}

/** SVG path data of outlines. */
function pathData(paths: readonly LaserPath[]): string {
    let d = "";
    for (const path of paths) {
        const pts = path.points;
        if (pts.length === 0) continue;
        d += `M${pts[0].x.toFixed(3)} ${pts[0].y.toFixed(3)}`;
        for (let k = 1; k < pts.length; k++) d += `L${pts[k].x.toFixed(3)} ${pts[k].y.toFixed(3)}`;
        if (path.closed) d += "Z";
    }
    return d;
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
    | { kind: "rotate"; id: string; center: Pt; startAngle: number; origin: LaserObject }
    /** A rubber band on empty bed: what it wholly holds is selected (added with Shift / Ctrl). */
    | { kind: "band"; start: Pt; end: Pt; additive: boolean; base: string[] }
    | { kind: "groupMove"; ids: string[]; origins: Placement[]; start: Pt; moved: boolean }
    | { kind: "groupScale"; ids: string[]; origins: Placement[]; anchor: Pt; from: Pt }
    | { kind: "groupRotate"; ids: string[]; origins: Placement[]; centre: Pt; startAngle: number };

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
/** A new object's speed on a galvo (JCZ) machine: 300 mm/s, in the job's mm/min. */
const GALVO_DEFAULT_SPEED = 300 * 60;

/** The job list's last entry: a new job of the open mode. */
const NEW_JOB = "__new__";

export class LaserEditor {
    private static readonly editors = new Map<string, LaserEditor>();

    /** The job last opened or edited in each document: what the «Лазер» workspace opens. */
    private static readonly lastJob = new WeakMap<IDocument, string>();

    /** Closes the job's editor if it is open (the job is being deleted). */
    static closeFor(id: string) {
        LaserEditor.editors.get(id)?.close();
    }

    static lastEdited(document: IDocument): string | undefined {
        return LaserEditor.lastJob.get(document);
    }

    /** Remembers the job as its document's last one; a job no longer in a document is skipped. */
    private static remember(node: LaserNode) {
        const document = node.document as IDocument | undefined;
        if (document !== undefined && document !== null && typeof document === "object")
            LaserEditor.lastJob.set(document, node.id);
    }

    static open(node: LaserNode) {
        LaserEditor.remember(node);
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
    /** The beam over the preview while the machine runs the job. */
    private readonly beam: BeamAnimation;
    private beamPercent = -1;
    private readonly objectElements = new Map<string, SVGGraphicsElement>();
    data: LaserJobData;
    private committed: string;
    /** Every selected object, in the order picked; one of them is «the» selection. */
    private chosen: string[] = [];

    /** The selected object when exactly one is. */
    get selection(): string | undefined {
        return this.chosen.length === 1 ? this.chosen[0] : undefined;
    }

    set selection(id: string | undefined) {
        this.chosen = id === undefined ? [] : [id];
    }

    get selectedIds(): readonly string[] {
        return this.chosen;
    }
    profile: MachineProfile = loadMachineProfile();
    private viewBox: ViewBox = { x: 0, y: 0, w: 400, h: 400 };
    private drag: Drag | undefined;
    private fitted = false;
    /** The drawing tool, kept after a figure when its button was double-clicked. */
    private tool: DrawTool = "select";
    private keepTool = false;
    private draft: Draft | undefined;
    /** Drawn points land on the millimetre grid (Alt held: not). */
    private snap = true;
    readonly polygonDefaults: PolygonDefaults = { sides: 6, star: 0 };
    private readonly draftGroup: SVGGElement;
    private readonly toolButtons = new Map<DrawTool, HTMLButtonElement>();
    private readonly snapButton: HTMLButtonElement;
    /** G-code only: hidden for a galvo (JCZ) board, which takes the job itself. */
    private readonly gcodeButtons: HTMLButtonElement[] = [];

    private constructor(readonly node: LaserNode) {
        this.tab = {
            id: node.id,
            title: () => this.node.name,
            icon: "icon-layer-group",
            show: () => this.reveal(),
            hide: () => this.conceal(),
            close: () => this.close(),
        };
        // a job laid out from the other origin is shown (and next saved) from the machine's
        this.data = withOrigin(node.data, this.profile);
        this.committed = node.content;
        this.dialog = document.createElement("dialog");
        this.dialog.className = style.dialog;
        this.svg = svgElement("svg", { class: style.canvas });
        this.world = svgElement("g");
        this.bedGroup = svgElement("g");
        this.objectsGroup = svgElement("g");
        this.previewGroup = svgElement("g", { "pointer-events": "none" });
        this.overlayGroup = svgElement("g");
        this.draftGroup = svgElement("g", { "pointer-events": "none" });
        this.world.append(
            this.bedGroup,
            this.objectsGroup,
            this.previewGroup,
            this.overlayGroup,
            this.draftGroup,
        );
        this.snapButton = this.paletteButton(
            toolIcon("snap"),
            "laser.draw.snap",
            "laser.draw.snap.hint",
            () => this.toggleSnap(),
        );
        this.svg.append(this.world);
        this.statusText = el("span");
        this.statusPosition = el("span");
        this.beam = new BeamAnimation(this.world, (p) => this.showBeamProgress(p));
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
                return {
                    job: this.data,
                    profile: this.profile,
                    images: r.images,
                    gcode: r.lines,
                    seconds: r.stats.seconds,
                    rotary: this.rotaryPlan(),
                };
            },
            framePaths: (mode) => framePaths(this.data, mode),
            showMachinePanel: () => this.showPanel("machine"),
            jobStarted: () => this.startBeam(),
            driverEvent: (event) => this.beamEvent(event),
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
                this.createPalette(),
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
        this.svg.addEventListener("dblclick", this.onDoubleClick);
        this.svg.addEventListener("wheel", this.onWheel, { passive: false });
        this.svg.addEventListener("contextmenu", (e) => e.preventDefault());
        this.node.onPropertyChanged(this.onNodeChanged);
        this.showPanel("job");
        this.render();
    }

    private reveal() {
        // the job's document was closed (or the job deleted): its tab has nothing to show
        if (this.node.document === undefined || this.node.document === null) {
            this.close();
            return;
        }
        if (!this.dialog.open) this.dialog.show();
        LaserEditor.remember(this.node);
        this.updateJobPicker();
        if (!this.fitted) {
            this.fitted = true;
            this.fit();
        }
        (this.dialog.firstElementChild as HTMLElement).focus();
    }

    private conceal() {
        if (this.dialog.open) this.dialog.close();
    }

    /** The chuck's stops when the job is marked round a part (galvo board only). */
    private rotaryPlan(): { steps: RotaryStep[] } | undefined {
        const rotary = this.data.rotary;
        if (rotary?.enabled !== true || this.profile.controller !== "jcz") return undefined;
        // in the job's coordinates as the board program sees them (the machine's origin)
        const job = withOrigin(this.data, this.profile);
        const centerY = this.profile.origin === "center" ? 0 : this.profile.bedHeight / 2;
        return { steps: rotarySteps(job, rotary, centerY) };
    }

    /** The job went to the machine: the beam follows it over the preview. */
    private startBeam() {
        const r = this.output.current;
        if (r === undefined) return;
        this.beamPercent = -1;
        this.view3d?.setFraction(0);
        // a galvo board reports no position while marking: the beam keeps the job's time
        this.beam.start(r.moves, r.stats.seconds, this.profile.controller === "jcz" ? "time" : "position");
    }

    private beamEvent(event: DriverEvent) {
        if (!this.beam.active) return;
        switch (event.type) {
            case "job":
                if (event.state === "running") this.beam.resume();
                else if (event.state === "paused") this.beam.pause();
                else if (event.state === "done") {
                    this.beam.finish();
                    this.setStatus(this.output.summary());
                } else if (event.state === "stopped" || event.state === "error") {
                    this.beam.halt();
                    this.setStatus(this.output.summary());
                }
                break;
            case "progress":
                this.beam.lists(event.done, event.total);
                break;
            case "status":
                if (event.status.position !== undefined) this.beam.position(event.status.position);
                break;
        }
    }

    private showBeamProgress(p: BeamProgress) {
        const percent = Math.floor(p.fraction * 100);
        if (percent === this.beamPercent || p.fraction >= 1) return;
        this.beamPercent = percent;
        this.setStatus(t("laser.beam.progress", percent, formatDuration(p.remaining)));
        this.view3d?.setFraction(p.fraction);
    }

    close() {
        this.beam.dispose();
        this.close3d();
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
        // Esc stops the red pointer first, then drops a figure being drawn, then the tool
        if (this.machine.framing) this.machine.stopFraming();
        else if (this.draft !== undefined) this.cancelDraft();
        else if (this.tool !== "select") this.setTool("select");
        else this.select(undefined);
    };

    private readonly onNodeChanged = (property: string | number | symbol) => {
        if (property === "name") workspaceTabs.changed();
        if (property !== "content" || this.node.content === this.committed) return;
        // undo / redo replaced the job under us
        this.committed = this.node.content;
        this.data = withOrigin(this.node.data, this.profile);
        const known = new Set(this.data.objects.map((o) => o.id));
        this.chosen = this.chosen.filter((id) => known.has(id));
        this.changed();
        this.render();
        this.schedule3d();
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
        LaserEditor.remember(this.node);
        this.changed();
        this.schedule3d();
    }

    /** The job changed (an edit, undo): whatever was computed from it is stale. Subclass hook. */
    protected changed() {
        this.output.invalidate();
    }

    selected(): LaserObject | undefined {
        return this.data.objects.find((o) => o.id === this.selection);
    }

    select(id: string | undefined, additive = false) {
        if (additive && id !== undefined) {
            this.chosen = this.chosen.includes(id)
                ? this.chosen.filter((x) => x !== id)
                : [...this.chosen, id];
        } else this.selection = id;
        this.render();
    }

    selectMany(ids: readonly string[]) {
        const known = new Set(this.data.objects.map((o) => o.id));
        this.chosen = ids.filter((id) => known.has(id));
        this.render();
    }

    /** The selected objects in burn order. */
    selectedObjects(): LaserObject[] {
        const ids = new Set(this.chosen);
        return this.data.objects.filter((o) => ids.has(o.id));
    }

    /** Aligned to the selection's box, or with `toBed` (or one object alone) to the bed. */
    alignSelected(align: Align, toBed: boolean) {
        const objects = this.selectedObjects();
        if (objects.length === 0) return;
        const target = toBed || objects.length === 1 ? this.bedBounds() : boundsOf(objects);
        alignObjects(objects, align, target);
        this.commit();
        this.render();
    }

    distributeSelected(axis: "x" | "y") {
        distributeObjects(this.selectedObjects(), axis);
        this.commit();
        this.render();
    }

    setProfile(edit: (p: MachineProfile) => void) {
        edit(this.profile);
        saveMachineProfile(this.profile);
        if (this.data.origin !== this.profile.origin) {
            // the objects keep their place on the bed; their coordinates follow the new origin
            this.data = withOrigin(this.data, this.profile);
            this.commit();
        }
        this.changed();
        this.render();
        this.fit();
    }

    /** Where a new object of this size goes: centred on a centre origin, on the corner otherwise. */
    private newPlace(w: number, h: number): { x: number; y: number } {
        return this.profile.origin === "center" ? { x: -w / 2, y: -h / 2 } : { x: 0, y: 0 };
    }

    private add(o: LaserObject) {
        // a galvo marks hundreds of mm per second: a new object starts at EzCAD's usual
        // 300 mm/s rather than the gantry default meant for GRBL
        if (this.profile.controller === "jcz" && o.op.speed === defaultOperation(o.op.mode).speed)
            o.op.speed = GALVO_DEFAULT_SPEED;
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
            ...this.newPlace(w, h),
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

    /**
     * EzCAD 2 projects: each top-level object (a group whole) with its pen's power, speed,
     * passes, frequency and hatch, measured from the field centre, all of them selected and the
     * view fitted; what was skipped or guessed in one word per kind.
     */
    private async importEzdFile() {
        const files = await readBinaryFileAsync(".ezd", true);
        if (!files.isOk) return;
        for (const file of files.value) {
            const imported = importEzd(file.data);
            if (imported === undefined) {
                PubSub.default.pub("showToast", "laser.ezd.notEzd");
                continue;
            }
            if (imported.objects.length === 0) {
                PubSub.default.pub("showToast", "toast.laser.nothingToEngrave");
                continue;
            }
            const placed = withOrigin(
                { version: 1, origin: "center", objects: imported.objects },
                this.profile,
            );
            this.data.objects.push(...placed.objects);
            this.chosen = placed.objects.map((o) => o.id);
            this.commit();
            this.render();
            this.fit();
            const notes = ezdWarnings(imported.warnings);
            const summary = t("laser.ezd.imported", placed.objects.length, file.fileName);
            this.setStatus(notes === "" ? summary : `${summary}. ${notes}`);
            if (notes !== "") PubSub.default.pub("showToast", "laser.ezd.warnings" as never, notes);
        }
    }

    /**
     * The job as an EzCAD 2 project (.ezd), named after the job, for any controller: outlines as
     * curves, fills as hatches, each operation a pen; what was left out in one word per kind.
     */
    private exportEzdFile() {
        const out = exportEzd(this.data, this.profile);
        if (out.written === 0) {
            PubSub.default.pub("showToast", "toast.laser.nothingToEngrave");
            return;
        }
        const name = `${this.node.name.replace(/[\\/:*?"<>|]/g, "_") || "laser"}.ezd`;
        download([out.bytes], name);
        const notes = ezdWarnings(out.warnings);
        const summary = t("laser.ezd.saved", out.written, name);
        this.setStatus(notes === "" ? summary : `${summary}. ${notes}`);
        if (notes !== "") PubSub.default.pub("showToast", "laser.ezd.warnings" as never, notes);
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
                ...this.newPlace(w, h),
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
        const ids = new Set(this.chosen);
        if (ids.size === 0) return;
        this.data.objects = this.data.objects.filter((o) => !ids.has(o.id));
        this.chosen = [];
        this.commit();
        this.render();
    }

    private duplicateSelected() {
        const copies = this.selectedObjects().map((o) => ({
            ...structuredClone(o),
            id: newLaserId(),
            x: o.x + 5,
            y: o.y + 5,
        }));
        if (copies.length === 0) return;
        this.data.objects.push(...copies);
        this.chosen = copies.map((o) => o.id);
        this.commit();
        this.render();
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
            get selectedIds() {
                return editor.selectedIds;
            },
            get profile() {
                return editor.profile;
            },
            select: (id, additive) => this.select(id, additive),
            alignSelected: (align, toBed) => this.alignSelected(align, toBed),
            distributeSelected: (axis) => this.distributeSelected(axis),
            editSelected: (edit) => {
                const o = this.selected();
                if (o === undefined) return;
                edit(o);
                if (o.kind === "vector") bakeSize(o);
                this.commit();
                this.render();
            },
            editJob: (edit) => {
                edit(this.data);
                this.commit();
                this.render();
            },
            editShape: (edit) => void this.editShape(edit),
            convertToCurves: () => {
                const o = this.selected();
                if (o?.kind !== "vector" || o.shape === undefined) return;
                if (!convertToPath(o)) o.shape = undefined;
                this.commit();
                this.render();
            },
            get polygonDefaults() {
                return editor.polygonDefaults;
            },
            get nodeMode() {
                return editor.nodeMode;
            },
            get nodeSelected() {
                return editor.nodeSelected;
            },
            nodeAction: (action) => this.nodeAction(action),
            editNodes: () => this.setTool("nodes"),
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
            {
                id: "output",
                // a galvo board is sent the job itself: the tab is the preview and the time, no G-code
                title: t(this.profile.controller === "jcz" ? "laser.panel.preview" : "laser.panel.output"),
                render: () => this.output.panel(),
            },
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
            button("laser.import.ezd", () => void this.importEzdFile(), "laser.import.ezd.hint"),
            this.separator(),
            button("laser.duplicate", () => this.duplicateSelected()),
            button("laser.delete", () => this.deleteSelected()),
            this.separator(),
            button("laser.fit", () => this.fit()),
            this.separator(),
            ...this.gcodeOnly(
                button("laser.generate", () => void this.output.generate()),
                button("laser.save", () => void this.output.save()),
            ),
            button("laser.export.ezd", () => this.exportEzdFile(), "laser.export.ezd.hint"),
            this.separator(),
            ...this.machine.toolbarControls(),
        ];
    }

    /** A rotary job: the part in 3D, docked beside the bed, made again after each change. */
    private view3d: Rotary3DView | undefined;
    private refresh3dTimer: ReturnType<typeof setTimeout> | undefined;

    private open3d() {
        if (this.view3d !== undefined) return;
        const view = new Rotary3DView(undefined);
        view.element.classList.add(style.view3dDocked);
        this.view3d = view;
        this.svg.after(view.element);
        void this.refresh3d();
    }

    private close3d() {
        this.view3d?.dispose();
        this.view3d = undefined;
    }

    /** After an edit: the 3D part made again a moment later (not on every keystroke). */
    private schedule3d() {
        if (this.view3d === undefined) return;
        clearTimeout(this.refresh3dTimer);
        this.refresh3dTimer = setTimeout(() => void this.refresh3d(), 300);
    }

    /** The 3D part made again from the job (opened, or the job / its rotary settings changed). */
    private async refresh3d() {
        const view = this.view3d;
        const rotary = this.data.rotary;
        if (view === undefined || rotary === undefined) return;
        const images = this.output.current?.images ?? (await this.output.readImages());
        const job = withOrigin(this.data, this.profile);
        const centerY = this.profile.origin === "center" ? 0 : this.profile.bedHeight / 2;
        // an empty job still shows the part (its size from the settings)
        await view.show(rotary3dSource(job, rotary, images, centerY, this.bedBounds()));
    }

    private gcodeOnly(...buttons: HTMLButtonElement[]): HTMLButtonElement[] {
        this.gcodeButtons.push(...buttons);
        return buttons;
    }

    /** The document's laser jobs, to switch between them; shown only when there are several. */
    private readonly jobPicker = el("select", { title: t("laser.jobs") });

    private laserJobs(): LaserNode[] {
        // the open mode's jobs only: a rotary job and a flat one have nothing to share
        const rotary = this.rotary;
        return (
            this.node.document.modelManager.findNodes((n) => n instanceof LaserNode) as LaserNode[]
        ).filter((n) => (n.data.rotary?.enabled === true) === rotary);
    }

    private updateJobPicker() {
        const jobs = this.laserJobs();
        this.jobPicker.style.display = "";
        this.jobPicker.replaceChildren(
            ...jobs.map((job) => {
                const option = el("option", { value: job.id, textContent: job.name });
                option.selected = job.id === this.node.id;
                return option;
            }),
            el("option", { value: NEW_JOB, textContent: `+ ${t("laser.newJob")}` }),
        );
    }

    private createToolbar(): HTMLDivElement {
        const bar = el("div", { className: style.toolbar });
        this.jobPicker.onchange = () => {
            if (this.jobPicker.value === NEW_JOB) {
                this.jobPicker.value = this.node.id;
                LaserEditor.open(newLaserJob(this.node.document, this.rotary ? "rotary" : "flat"));
                return;
            }
            const job = this.laserJobs().find((n) => n.id === this.jobPicker.value);
            if (job !== undefined && job !== this.node) LaserEditor.open(job);
        };
        bar.append(
            this.jobPicker,
            ...this.toolbarItems(),
            this.separator(),
            button("laser.home.back", () => openLaserHome(), "laser.home.back.hint"),
            button("laser.toModel", () => workspaceTabs.activate(undefined)),
            button("laser.close", () => this.close()),
        );
        return bar;
    }

    // ---- rendering --------------------------------------------------------------------------

    render() {
        this.updateJobPicker();
        const gcode = this.profile.controller !== "jcz";
        for (const b of this.gcodeButtons) b.style.display = gcode ? "" : "none";
        if (this.rotary) this.open3d();
        else if (this.view3d !== undefined) this.close3d();
        this.world.setAttribute("transform", "matrix(1 0 0 -1 0 0)");
        this.renderBed();
        this.renderObjects();
        this.renderOverlay();
        this.renderPanel();
        this.statusText.textContent = this.output.summary() || t("laser.prompt.select");
    }

    /**
     * The bed in job coordinates: white, a 10 mm grid (50 mm darker) running from the origin,
     * figures every 50 mm along the bottom and left edges, and the origin's blue X/Y arrows — in
     * the middle of the bed for a centre origin, at its lower-left corner for a corner one.
     */
    /** A rotary job: the part's surface unrolled is the bed. */
    get rotary(): boolean {
        return this.data.rotary?.enabled === true;
    }

    /**
     * The bed: the machine's, or for a rotary job the part unrolled — its length along X, its
     * circumference (π·D) along Y — placed by the machine's origin like the bed.
     */
    bedBounds(): Bounds {
        const r = this.data.rotary;
        if (r?.enabled !== true) return bedRect(this.profile);
        const w = Math.max(1, r.length);
        const h = Math.PI * Math.max(0.5, r.diameter);
        return this.profile.origin === "center"
            ? { minX: -w / 2, minY: -h / 2, maxX: w / 2, maxY: h / 2 }
            : { minX: 0, minY: 0, maxX: w, maxY: h };
    }

    /** Rotary bed: the seam (the same line of the part, top and bottom) and the angle marks round it. */
    private renderTurnMarks(b: Bounds): SVGGElement {
        const g = svgElement("g", {});
        const h = b.maxY - b.minY;
        const seam = svgElement("path", {
            d: `M${b.minX} ${b.minY}H${b.maxX}M${b.minX} ${b.maxY}H${b.maxX}`,
            stroke: "#e8590c",
            "stroke-width": 2,
            "stroke-dasharray": "6 4",
            "vector-effect": "non-scaling-stroke",
            fill: "none",
        });
        const ticks = svgElement("path", {
            stroke: "#f08c00",
            "stroke-width": 1,
            "vector-effect": "non-scaling-stroke",
            fill: "none",
        });
        const labels = svgElement("g", { fill: "#e8590c", "font-family": "sans-serif" });
        const size = Math.max(b.maxX - b.minX, h) / 70;
        labels.setAttribute("font-size", String(size));
        let d = "";
        for (let a = 0; a <= 360; a += 45) {
            const y = b.minY + (h * a) / 360;
            d += `M${b.maxX} ${y}h${-size * (a % 90 === 0 ? 1.6 : 0.8)}`;
            if (a % 90 !== 0) continue;
            // inside the bed's right edge: outside it the 3D column would cut the figures
            const e = svgElement("text", {
                x: b.maxX - size * 0.4,
                y: -Math.min(b.maxY - size * 0.7, Math.max(b.minY + size * 0.7, y)),
                transform: "scale(1 -1)",
                "text-anchor": "end",
                "dominant-baseline": "middle",
            });
            e.textContent = `${a}°`;
            labels.append(e);
        }
        ticks.setAttribute("d", d);
        g.append(seam, ticks, labels);
        return g;
    }

    private renderBed() {
        const b = this.bedBounds();
        const g = this.bedGroup;
        const w = b.maxX - b.minX;
        const h = b.maxY - b.minY;
        g.replaceChildren(svgElement("rect", { x: b.minX, y: b.minY, width: w, height: h, fill: "#fff" }));
        const line = (stroke: string, width = 1) =>
            svgElement("path", {
                stroke,
                "stroke-width": width,
                "vector-effect": "non-scaling-stroke",
                fill: "none",
            });
        const minor = line("#e9ecef");
        const major = line("#ced4da");
        let dMinor = "";
        let dMajor = "";
        for (let x = Math.ceil(b.minX / 10) * 10; x <= b.maxX; x += 10) {
            if (x === b.minX || x === b.maxX) continue;
            if (x % 50 === 0) dMajor += `M${x} ${b.minY}V${b.maxY}`;
            else dMinor += `M${x} ${b.minY}V${b.maxY}`;
        }
        for (let y = Math.ceil(b.minY / 10) * 10; y <= b.maxY; y += 10) {
            if (y === b.minY || y === b.maxY) continue;
            if (y % 50 === 0) dMajor += `M${b.minX} ${y}H${b.maxX}`;
            else dMinor += `M${b.minX} ${y}H${b.maxX}`;
        }
        minor.setAttribute("d", dMinor);
        major.setAttribute("d", dMajor);
        const arrow = Math.min(30, w / 4, h / 4);
        const axes = line("#1971c2", 2);
        axes.setAttribute(
            "d",
            `M0 0H${arrow}M0 0V${arrow}M${arrow * 0.8} ${arrow * 0.08}L${arrow} 0L${arrow * 0.8} ${-arrow * 0.08}M${arrow * 0.08} ${arrow * 0.8}L0 ${arrow}L${-arrow * 0.08} ${arrow * 0.8}`,
        );
        const frame = svgElement("rect", { x: b.minX, y: b.minY, width: w, height: h, fill: "none" });
        frame.setAttribute("stroke", "#343a40");
        frame.setAttribute("stroke-width", "1");
        frame.setAttribute("vector-effect", "non-scaling-stroke");
        g.append(minor, major, frame, this.rulers(b), axes);
        if (this.rotary) g.append(this.renderTurnMarks(b));
    }

    /** Figures every 50 mm outside the bottom and left edges, upright on screen. */
    private rulers(b: Bounds): SVGGElement {
        const g = svgElement("g", { fill: "#e9ecef", "font-family": "sans-serif" });
        const size = Math.max(b.maxX - b.minX, b.maxY - b.minY) / 70;
        g.setAttribute("font-size", String(size));
        const text = (x: number, y: number, value: number, anchor: string) => {
            const e = svgElement("text", {
                x,
                y: -y,
                transform: "scale(1 -1)",
                "text-anchor": anchor,
                "dominant-baseline": "middle",
            });
            e.textContent = String(value);
            g.append(e);
        };
        for (let x = Math.ceil(b.minX / 50) * 50; x <= b.maxX; x += 50)
            text(x, b.minY - size * 1.2, x, "middle");
        for (let y = Math.ceil(b.minY / 50) * 50; y <= b.maxY; y += 50)
            text(b.minX - size * 0.6, y, y, "end");
        return g;
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
        const d = pathData(o.paths);
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

    /** Several selected: one box round them all, with the handles of a single object. */
    private groupBox(): LaserObject | undefined {
        const objects = this.selectedObjects();
        if (objects.length < 2) return undefined;
        const b = boundsOf(objects);
        return {
            x: b.minX,
            y: b.minY,
            width: Math.max(b.maxX - b.minX, 0.01),
            height: Math.max(b.maxY - b.minY, 0.01),
            angle: 0,
        } as LaserObject;
    }

    private renderOverlay() {
        this.overlayGroup.replaceChildren();
        if (this.tool === "nodes") {
            this.renderNodes();
            return;
        }
        const group = this.groupBox();
        if (group !== undefined) {
            for (const each of this.selectedObjects()) {
                this.overlayGroup.append(
                    svgElement("polygon", {
                        points: objectCorners(each)
                            .map((p) => `${p.x},${p.y}`)
                            .join(" "),
                        fill: "none",
                        stroke: "#1677ff",
                        "stroke-width": 1,
                        opacity: 0.55,
                        "vector-effect": "non-scaling-stroke",
                        "pointer-events": "none",
                    }),
                );
            }
        }
        const band = this.drag?.kind === "band" ? this.drag : undefined;
        if (band !== undefined) {
            const x = Math.min(band.start.x, band.end.x);
            const y = Math.min(band.start.y, band.end.y);
            this.overlayGroup.append(
                svgElement("rect", {
                    x,
                    y,
                    width: Math.abs(band.end.x - band.start.x),
                    height: Math.abs(band.end.y - band.start.y),
                    fill: "rgba(22,119,255,0.08)",
                    stroke: "#1677ff",
                    "stroke-width": 1,
                    "stroke-dasharray": "3 3",
                    "vector-effect": "non-scaling-stroke",
                    "pointer-events": "none",
                }),
            );
        }
        const o = group ?? this.selected();
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
        const b = this.bedBounds();
        const width = b.maxX - b.minX;
        const height = b.maxY - b.minY;
        const rect = this.svg.getBoundingClientRect();
        const aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : width / height;
        // room for the rulers below and to the left
        let w = width * 1.14;
        let h = height * 1.14;
        if (w / h < aspect) w = h * aspect;
        else h = w / aspect;
        // the world is flipped: bed y runs up, the screen's down
        const cx = (b.minX + b.maxX) / 2 - width * 0.02;
        const cy = -(b.minY + b.maxY) / 2 + height * 0.02;
        this.setViewBox({ x: cx - w / 2, y: cy - h / 2, w, h });
        this.renderOverlay();
    }

    protected setStatus(text: string) {
        this.statusText.textContent = text;
    }

    // ---- drawing tools ----------------------------------------------------------------------

    /** An icon button of the palette; its name and hint (with the key) are the tooltip. */
    private paletteButton(icon: string, label: string, hint: string, action: () => void): HTMLButtonElement {
        const b = el("button", { className: style.paletteButton, onclick: action });
        b.innerHTML = icon;
        b.title = `${t(label)}
${t(hint)}`;
        b.setAttribute("aria-label", t(label));
        return b;
    }

    /**
     * The tools in a column on the left, as graphics editors have them: selection, lines and
     * curves, figures, text and codes, then the grid snap at the bottom.
     */
    private createPalette(): HTMLElement {
        const groups: DrawTool[][] = [
            ["select", "nodes"],
            ["line", "curve", "pencil"],
            ["rect", "ellipse", "polygon"],
            ["text", "barcode", "scale"],
        ];
        const palette = el("div", { className: style.palette });
        groups.forEach((group, i) => {
            if (i > 0) palette.append(el("div", { className: style.paletteSeparator }));
            for (const tool of group) {
                const b = this.paletteButton(
                    toolIcon(tool),
                    `laser.tool.${tool}`,
                    `laser.tool.${tool}.hint`,
                    () => this.setTool(tool),
                );
                // a double click keeps the tool for figure after figure (EzCAD returns to select)
                b.ondblclick = () => this.setTool(tool, tool !== "select");
                this.toolButtons.set(tool, b);
                palette.append(b);
            }
        });
        palette.append(el("div", { className: style.paletteSpacer }), this.snapButton);
        this.showTool();
        return palette;
    }

    setTool(tool: DrawTool, keep = false) {
        this.cancelDraft();
        if (tool === "nodes" && !this.enterNodes()) tool = "select";
        this.nodeSel = undefined;
        this.nodeDrag = undefined;
        this.tool = tool;
        this.keepTool = keep;
        this.svg.style.cursor =
            tool === "select"
                ? ""
                : tool === "text"
                  ? "text"
                  : tool === "barcode" || tool === "scale"
                    ? "copy"
                    : "crosshair";
        this.showTool();
        this.setStatus(
            tool === "select"
                ? this.output.summary() || t("laser.prompt.select")
                : t(`laser.tool.${tool}.prompt`),
        );
        this.renderOverlay();
        this.renderPanel();
    }

    // ---- node editing ---------------------------------------------------------------------------

    private nodeSel: { sub: number; node: number } | undefined;
    private nodeDrag: { kind: "node" | "in" | "out"; sub: number; node: number; moved: boolean } | undefined;

    get nodeMode(): boolean {
        return this.tool === "nodes";
    }

    get nodeSelected(): boolean {
        return this.nodeSel !== undefined;
    }

    private nodeTarget(): LaserVectorObject | undefined {
        const o = this.selected();
        return o?.kind === "vector" && o.shape?.type === "path" ? o : undefined;
    }

    /**
     * The selected object opened node by node: a polyline or plain outlines become a path of
     * corner nodes (the outlines unchanged); a rectangle, ellipse, polygon, text or barcode
     * must be converted to curves first — said, not done behind the user's back.
     */
    private enterNodes(): boolean {
        const o = this.selected();
        if (o?.kind !== "vector") {
            PubSub.default.pub("showToast", "laser.nodes.selectOne");
            return false;
        }
        const shape = o.shape;
        if (shape !== undefined && shape.type !== "path" && shape.type !== "polyline") {
            PubSub.default.pub("showToast", "laser.nodes.convertFirst");
            return false;
        }
        if (shape?.type === "polyline")
            o.shape = {
                type: "path",
                subpaths: [{ closed: shape.closed, nodes: shape.points.map((q) => ({ x: q.x, y: q.y })) }],
            };
        else if (shape === undefined) {
            const subpaths = subPathsFromOutlines(o.paths);
            if (subpaths.length === 0) return false;
            o.shape = { type: "path", subpaths };
        }
        return true;
    }

    private renderNodes() {
        const o = this.nodeTarget();
        if (o?.shape?.type !== "path") return;
        const m = objectMatrix(o);
        const px = this.pixel();
        const sel = this.nodeSel;
        const attrs = { stroke: "#1677ff", "stroke-width": 1, "vector-effect": "non-scaling-stroke" };
        o.shape.subpaths.forEach((sub, si) => {
            const count = sub.nodes.length;
            sub.nodes.forEach((n, ni) => {
                const at = apply(m, n);
                const selected = sel?.sub === si && sel.node === ni;
                const near =
                    sel?.sub === si &&
                    (selected ||
                        Math.abs(sel.node - ni) === 1 ||
                        (sub.closed && Math.abs(sel.node - ni) === count - 1));
                if (near) {
                    for (const h of [n.in, n.out]) {
                        if (h === undefined) continue;
                        const hp = apply(m, h);
                        this.overlayGroup.append(
                            svgElement("line", { x1: at.x, y1: at.y, x2: hp.x, y2: hp.y, ...attrs }),
                            svgElement("circle", { cx: hp.x, cy: hp.y, r: 3 * px, fill: "#fff", ...attrs }),
                        );
                    }
                }
                const size = (selected ? 5 : 4) * px;
                const fill = selected ? "#1677ff" : "#fff";
                this.overlayGroup.append(
                    n.smooth
                        ? svgElement("circle", { cx: at.x, cy: at.y, r: size, fill, ...attrs })
                        : svgElement("rect", {
                              x: at.x - size,
                              y: at.y - size,
                              width: 2 * size,
                              height: 2 * size,
                              fill,
                              ...attrs,
                          }),
                );
            });
        });
    }

    private nodesPointerDown(e: PointerEvent) {
        const p = this.bedPoint(e);
        const o = this.nodeTarget();
        const reach = 6 * this.pixel();
        if (o?.shape?.type === "path") {
            const m = objectMatrix(o);
            const subs = o.shape.subpaths;
            const sel = this.nodeSel;
            if (sel !== undefined) {
                const n = subs[sel.sub]?.nodes[sel.node];
                for (const which of ["in", "out"] as const) {
                    const h = n?.[which];
                    if (h === undefined) continue;
                    const hp = apply(m, h);
                    if (Math.hypot(hp.x - p.x, hp.y - p.y) <= reach) {
                        this.nodeDrag = { kind: which, sub: sel.sub, node: sel.node, moved: false };
                        return;
                    }
                }
            }
            for (let si = 0; si < subs.length; si++)
                for (let ni = 0; ni < subs[si].nodes.length; ni++) {
                    const at = apply(m, subs[si].nodes[ni]);
                    if (Math.hypot(at.x - p.x, at.y - p.y) <= reach) {
                        this.nodeSel = { sub: si, node: ni };
                        this.nodeDrag = { kind: "node", sub: si, node: ni, moved: false };
                        this.renderOverlay();
                        this.renderPanel();
                        return;
                    }
                }
            // a click on the outline puts a node there
            const q = apply(invert(m), p);
            const scale = Math.max(1e-9, Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])));
            const hit = hitSegment(subs, q, reach / scale);
            if (hit !== undefined) {
                const ni = insertNode(subs[hit.sub], hit.segment, hit.t);
                this.nodeSel = { sub: hit.sub, node: ni };
                this.nodeDrag = { kind: "node", sub: hit.sub, node: ni, moved: true };
                o.paths = flattenSubPaths(subs);
                this.renderObjects();
                this.renderOverlay();
                this.renderPanel();
                return;
            }
        }
        const other = this.hitObject(p);
        if (other !== undefined && other.id !== o?.id) {
            this.selection = other.id;
            if (!this.enterNodes()) this.setTool("select");
            this.nodeSel = undefined;
            this.render();
            return;
        }
        this.nodeSel = undefined;
        this.renderOverlay();
        this.renderPanel();
    }

    private nodesPointerMove(e: PointerEvent) {
        const drag = this.nodeDrag;
        const o = this.nodeTarget();
        if (drag === undefined || o?.shape?.type !== "path" || (e.buttons & 1) === 0) return;
        const n = o.shape.subpaths[drag.sub]?.nodes[drag.node];
        if (n === undefined) return;
        const q = apply(invert(objectMatrix(o)), this.drawPoint(e));
        if (drag.kind === "node") moveNode(n, q.x, q.y);
        else moveHandle(n, drag.kind, q, e.altKey);
        drag.moved = true;
        o.paths = flattenSubPaths(o.shape.subpaths);
        this.renderObjects();
        this.renderOverlay();
    }

    private nodesPointerUp() {
        const drag = this.nodeDrag;
        this.nodeDrag = undefined;
        const o = this.nodeTarget();
        if (drag?.moved !== true || o === undefined) return;
        rebuildPath(o);
        this.commit();
        this.render();
    }

    /** The node buttons of the panel and the Delete key, on the selected node. */
    nodeAction(action: "smooth" | "break" | "join" | "close" | "delete") {
        const o = this.nodeTarget();
        const sel = this.nodeSel;
        if (o?.shape?.type !== "path") return;
        const subs = o.shape.subpaths;
        if (action === "close") {
            const sub = subs[sel?.sub ?? 0];
            if (sub === undefined || sub.nodes.length < 3) return;
            sub.closed = !sub.closed;
        } else {
            if (sel === undefined || subs[sel.sub]?.nodes[sel.node] === undefined) {
                PubSub.default.pub("showToast", "laser.nodes.pickNode");
                return;
            }
            if (action === "delete") {
                const total = subs.reduce((a, x) => a + x.nodes.length, 0);
                if (total <= 2) return;
                deleteNode(subs, sel.sub, sel.node);
                this.nodeSel = undefined;
            } else if (action === "smooth") toggleSmooth(subs[sel.sub], sel.node);
            else if (action === "break") breakAt(subs, sel.sub, sel.node);
            else if (!joinAt(subs, sel.sub, sel.node)) {
                PubSub.default.pub("showToast", "laser.nodes.joinEnds");
                return;
            } else this.nodeSel = undefined;
        }
        rebuildPath(o);
        this.commit();
        this.render();
    }

    private showTool() {
        for (const [tool, b] of this.toolButtons) b.classList.toggle(style.active, tool === this.tool);
        this.snapButton.classList.toggle(style.active, this.snap);
    }

    private toggleSnap() {
        this.snap = !this.snap;
        this.showTool();
    }

    private cancelDraft() {
        this.draft = undefined;
        this.draftGroup.replaceChildren();
    }

    /** A drawn point: on the grid unless Alt is held or the grid is off. */
    private drawPoint(e: PointerEvent | MouseEvent): Pt {
        const p = this.bedPoint(e);
        return this.snap && !e.altKey ? snapToGrid(p) : p;
    }

    private renderDraft() {
        this.draftGroup.replaceChildren();
        const draft = this.draft;
        if (draft === undefined) return;
        const paths = draftPaths(draft, this.polygonDefaults);
        this.draftGroup.append(
            svgElement("path", {
                d: pathData(paths),
                fill: "none",
                stroke: "#1677ff",
                "stroke-width": 1.2,
                "stroke-dasharray": "4 3",
                "vector-effect": "non-scaling-stroke",
            }),
        );
        if (draft.kind === "polyline") {
            const px = this.pixel();
            for (const [i, p] of draft.points.entries()) {
                this.draftGroup.append(
                    svgElement("circle", {
                        cx: p.x,
                        cy: p.y,
                        r: (i === 0 ? 4 : 2.5) * px,
                        fill: i === 0 ? "#fff" : "#1677ff",
                        stroke: "#1677ff",
                        "stroke-width": 1,
                        "vector-effect": "non-scaling-stroke",
                    }),
                );
            }
        }
    }

    /** The drawn figure as a new object, selected; the tool back to select unless it was kept. */
    private addFigure(figure: DrawnFigure | undefined, font?: FontOutline) {
        this.cancelDraft();
        if (figure === undefined) return;
        const o = shapeObject(figure.shape, t(`laser.shape.${figure.shape.type}`), figure.at, font);
        if (o === undefined) return;
        this.add(o);
        if (!this.keepTool) this.setTool("select");
    }

    private finishPolylineDraft(closed: boolean) {
        const draft = this.draft;
        if (draft?.kind !== "polyline") return;
        this.addFigure(finishPolyline(draft.points, closed));
    }

    /** A click with the text tool: a word to change in the panel, typed straight away. */
    private async placeText(at: Pt) {
        const font = defaultLaserFont();
        const shape: LaserShape = {
            type: "text",
            text: t("laser.draw.textDefault"),
            font,
            size: 10,
            letterSpacing: 0,
            lineSpacing: 1.2,
            align: "left",
            arcRadius: 0,
        };
        this.setStatus(t("laser.draw.fontLoading"));
        const outline = await loadLaserFont(font);
        if (outline === undefined) {
            PubSub.default.pub("showToast", "laser.draw.fontFailed");
            this.setTool("select");
            return;
        }
        this.addFigure({ shape, at: { corner: at } }, outline);
        this.showPanel("job");
        this.jobPanel.focusText();
    }

    /** A click with the barcode tool: a QR code to change in the panel. */
    private async placeBarcode(at: Pt) {
        const shape: LaserShape = {
            type: "barcode",
            format: "qr",
            data: "Kern3D",
            level: "M",
            module: 0.5,
            quiet: defaultQuiet("qr"),
            barHeight: 15,
            showText: true,
            invert: false,
        };
        this.addFigure({ shape, at: { centre: at } });
        this.showPanel("job");
        this.jobPanel.focusText();
    }

    /**
     * A click with the scale tool. On a rotary job a dial ring round the whole part — 0…360°,
     * its 0 on the seam, at the clicked place along the axis; on a flat job a 100 mm ruler.
     */
    private async placeScale(at: Pt) {
        const font: LaserFontRef = { family: "ГОСТ тип Б", stroke: "gost-b" };
        const bed = this.bedBounds();
        const rotary = this.rotary;
        const span = rotary ? bed.maxY - bed.minY : 100;
        const shape: LaserShape = { type: "scale", ...defaultScale(span, rotary, font) };
        const outline = await this.fontFor(shape);
        this.addFigure({ shape, at: { corner: rotary ? { x: at.x, y: bed.minY } : at } }, outline);
        const o = this.selected();
        if (o !== undefined) {
            // ticks are open strokes: traced, never filled
            o.op.mode = "line";
            this.commit();
            this.render();
        }
        this.showPanel("job");
    }

    /** The font a figure is drawn with: a text's or a scale's own, a barcode's digits in the default one. */
    private async fontFor(shape: LaserShape): Promise<FontOutline | undefined> {
        if (!needsFont(shape)) return undefined;
        return loadLaserFont(
            shape.type === "text" || shape.type === "scale" ? shape.font : defaultLaserFont(),
        );
    }

    /**
     * A parameter of the selected figure changed: its outlines again, a text with its font. A
     * change the figure cannot take (a font out of reach, data a barcode cannot hold) is undone
     * with a word why.
     */
    private async editShape(edit: (shape: LaserShape) => void) {
        const o = this.selected();
        if (o?.kind !== "vector" || o.shape === undefined) return;
        const before = structuredClone(o.shape);
        edit(o.shape);
        const font = await this.fontFor(o.shape);
        if (o.shape.type === "text" && font === undefined) {
            o.shape = before;
            PubSub.default.pub("showToast", "laser.draw.fontFailed");
            this.render();
            return;
        }
        const result = regenerate(o, font);
        if (!result.ok) {
            o.shape = before;
            PubSub.default.pub("showToast", (result.error ?? "laser.barcode.cannot") as never);
            this.render();
            return;
        }
        // single-line letters are open strokes: traced, never filled
        if (o.shape.type === "text" && o.shape.font.stroke !== undefined && o.op.mode === "fill")
            o.op.mode = "line";
        this.commit();
        this.render();
    }

    /** The pen's path as a new object; the first click closes it, a double click or Enter ends it. */
    private finishCurve(closed: boolean) {
        const draft = this.draft;
        if (draft?.kind !== "curve") return;
        this.cancelDraft();
        if (draft.nodes.length < 2) return;
        this.addDrawn(
            pathObject(
                [{ nodes: draft.nodes, closed: closed && draft.nodes.length >= 2 }],
                t("laser.shape.path"),
            ),
        );
    }

    /** The pencil's stroke: simplified to what the eye sees, smoothed into Bézier nodes. */
    private finishPencil() {
        const draft = this.draft;
        if (draft?.kind !== "pencil") return;
        this.cancelDraft();
        const pts = draft.points;
        if (pts.length < 2) return;
        const px = this.pixel();
        const first = pts[0];
        const last = pts[pts.length - 1];
        const closed = pts.length > 4 && Math.hypot(last.x - first.x, last.y - first.y) <= 8 * px;
        const sub = smoothStroke(pts, Math.max(0.05, 1.5 * px), closed);
        this.addDrawn(pathObject([sub], t("laser.shape.path")));
    }

    private addDrawn(o: LaserObject | undefined) {
        if (o === undefined) return;
        this.add(o);
        if (!this.keepTool) this.setTool("select");
    }

    private drawPointerDown(e: PointerEvent) {
        if (this.tool === "nodes") {
            this.nodesPointerDown(e);
            return;
        }
        if (this.tool === "pencil") {
            this.draft = { kind: "pencil", points: [this.bedPoint(e)] };
            return;
        }
        const p = this.drawPoint(e);
        if (this.tool === "curve") {
            const draft = this.draft?.kind === "curve" ? this.draft : undefined;
            if (draft === undefined) {
                this.draft = { kind: "curve", nodes: [{ x: p.x, y: p.y }], dragging: true, hover: undefined };
            } else {
                const first = draft.nodes[0];
                const last = draft.nodes[draft.nodes.length - 1];
                const px = this.pixel();
                if (draft.nodes.length >= 2 && Math.hypot(p.x - first.x, p.y - first.y) <= 6 * px) {
                    this.finishCurve(true);
                    return;
                }
                if (Math.hypot(p.x - last.x, p.y - last.y) > 2 * px) draft.nodes.push({ x: p.x, y: p.y });
                draft.dragging = true;
            }
            this.renderDraft();
            return;
        }
        if (this.tool === "text") {
            void this.placeText(p);
            return;
        }
        if (this.tool === "barcode") {
            void this.placeBarcode(p);
            return;
        }
        if (this.tool === "scale") {
            void this.placeScale(p);
            return;
        }
        if (this.tool === "line") {
            const draft = this.draft?.kind === "polyline" ? this.draft : undefined;
            if (draft === undefined) {
                this.draft = { kind: "polyline", points: [p], hover: undefined };
            } else {
                const first = draft.points[0];
                const last = draft.points[draft.points.length - 1];
                const reach = 6 * this.pixel();
                // back on the first point: a closed outline
                if (draft.points.length >= 3 && Math.hypot(p.x - first.x, p.y - first.y) <= reach) {
                    this.finishPolylineDraft(true);
                    return;
                }
                const q = e.shiftKey ? constrainAngle(last, p) : p;
                // the second click of a double click lands on the same point
                if (Math.hypot(q.x - last.x, q.y - last.y) > 2 * this.pixel()) draft.points.push(q);
            }
            this.renderDraft();
            return;
        }
        if (this.tool === "rect" || this.tool === "ellipse" || this.tool === "polygon") {
            this.draft = { kind: "box", tool: this.tool, start: p, end: p, square: e.shiftKey };
            this.renderDraft();
        }
    }

    private drawPointerMove(e: PointerEvent) {
        if (this.tool === "nodes") {
            this.nodesPointerMove(e);
            return;
        }
        const draft = this.draft;
        if (draft === undefined) return;
        if (draft.kind === "pencil") {
            const q = this.bedPoint(e);
            const last = draft.points[draft.points.length - 1];
            if ((e.buttons & 1) !== 0 && Math.hypot(q.x - last.x, q.y - last.y) > 0.5 * this.pixel())
                draft.points.push(q);
            this.renderDraft();
            return;
        }
        const p = this.drawPoint(e);
        if (draft.kind === "curve") {
            const n = draft.nodes[draft.nodes.length - 1];
            if (draft.dragging && (e.buttons & 1) !== 0) {
                // a drag pulls the handles out: a smooth node; Alt leaves the incoming one (a cusp)
                if (Math.hypot(p.x - n.x, p.y - n.y) > 2 * this.pixel()) {
                    n.out = { ...p };
                    if (!e.altKey) n.in = { x: 2 * n.x - p.x, y: 2 * n.y - p.y };
                    n.smooth = !e.altKey;
                }
            } else draft.hover = p;
            this.renderDraft();
            return;
        }
        if (draft.kind === "polyline") {
            const last = draft.points[draft.points.length - 1];
            draft.hover = e.shiftKey ? constrainAngle(last, p) : p;
        } else {
            draft.end = p;
            draft.square = e.shiftKey;
        }
        this.renderDraft();
    }

    private drawPointerUp() {
        if (this.tool === "nodes") {
            this.nodesPointerUp();
            return;
        }
        const draft = this.draft;
        if (draft?.kind === "curve") {
            draft.dragging = false;
            return;
        }
        if (draft?.kind === "pencil") {
            this.finishPencil();
            return;
        }
        if (draft?.kind !== "box") return;
        this.addFigure(finishBox(draft, this.polygonDefaults, 3 * this.pixel()));
    }

    private readonly onDoubleClick = (e: MouseEvent) => {
        if (this.tool === "line" && this.draft?.kind === "polyline") {
            e.preventDefault();
            this.finishPolylineDraft(false);
        } else if (this.tool === "curve" && this.draft?.kind === "curve") {
            e.preventDefault();
            this.finishCurve(false);
        } else if (this.tool === "select") {
            // a double click on an object opens its nodes (EzCAD: edit the curve)
            const hit = this.hitObject(this.bedPoint(e));
            if (hit?.kind === "vector") {
                this.selection = hit.id;
                this.setTool("nodes");
                this.render();
            }
        } else if (this.tool === "nodes" && this.hitObject(this.bedPoint(e)) === undefined)
            this.setTool("select");
    };

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
        if (this.tool !== "select") {
            this.drawPointerDown(e);
            return;
        }
        const p = this.bedPoint(e);
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        const group = this.groupBox();
        if (group !== undefined) {
            const h = this.hitHandle(group, p);
            if (h !== undefined) {
                const objects = this.selectedObjects();
                const ids = objects.map((o) => o.id);
                const origins = objects.map(({ x, y, width, height, angle }) => ({
                    x,
                    y,
                    width,
                    height,
                    angle,
                }));
                const corners = objectCorners(group);
                if (h.kind === "rotate") {
                    const centre = { x: group.x + group.width / 2, y: group.y + group.height / 2 };
                    const startAngle = Math.atan2(p.y - centre.y, p.x - centre.x);
                    this.drag = { kind: "groupRotate", ids, origins, centre, startAngle };
                } else {
                    const anchor = corners[(h.index + 2) % 4];
                    this.drag = { kind: "groupScale", ids, origins, anchor, from: corners[h.index] };
                }
                return;
            }
        }
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
            // EzCAD: a drag on empty bed selects what it encloses (the view pans with the
            // middle or right button)
            const base = additive ? [...this.chosen] : [];
            if (!additive && this.chosen.length > 0) this.select(undefined);
            this.drag = { kind: "band", start: p, end: p, additive, base };
            return;
        }
        if (additive) {
            this.select(hit.id, true);
            return;
        }
        if (this.chosen.length > 1 && this.chosen.includes(hit.id)) {
            const objects = this.selectedObjects();
            this.drag = {
                kind: "groupMove",
                ids: objects.map((o) => o.id),
                origins: objects.map(({ x, y, width, height, angle }) => ({ x, y, width, height, angle })),
                start: p,
                moved: false,
            };
            return;
        }
        if (hit.id !== this.selection) this.select(hit.id);
        this.drag = { kind: "move", id: hit.id, start: p, origin: { ...hit }, moved: false };
    };

    private readonly onPointerMove = (e: PointerEvent) => {
        const p = this.bedPoint(e);
        this.statusPosition.textContent = `X ${p.x.toFixed(1)}  Y ${p.y.toFixed(1)}`;
        const drag = this.drag;
        if (drag === undefined) {
            if (this.tool !== "select") this.drawPointerMove(e);
            return;
        }
        if (drag.kind === "pan") {
            const k = this.pixel();
            this.setViewBox({
                ...drag.box,
                x: drag.box.x - (e.clientX - drag.x) * k,
                y: drag.box.y - (e.clientY - drag.y) * k,
            });
            return;
        }
        if (drag.kind === "band") {
            drag.end = p;
            this.renderOverlay();
            return;
        }
        if (drag.kind === "groupMove" || drag.kind === "groupScale" || drag.kind === "groupRotate") {
            this.dragGroup(drag, p, e);
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
        if (drag === undefined && this.tool !== "select") {
            this.drawPointerUp();
            return;
        }
        if (drag === undefined || drag.kind === "pan") return;
        if (drag.kind === "band") {
            const band = {
                minX: Math.min(drag.start.x, drag.end.x),
                minY: Math.min(drag.start.y, drag.end.y),
                maxX: Math.max(drag.start.x, drag.end.x),
                maxY: Math.max(drag.start.y, drag.end.y),
            };
            const caught = inside(this.data.objects, band).map((o) => o.id);
            this.selectMany([...new Set([...drag.base, ...caught])]);
            return;
        }
        if (drag.kind === "groupMove" || drag.kind === "groupScale" || drag.kind === "groupRotate") {
            if (drag.kind === "groupMove" && !drag.moved) {
                // a click on one of several selected: that one alone
                const hit = this.hitObject(drag.start);
                if (hit !== undefined) this.select(hit.id);
                return;
            }
            for (const o of this.selectedObjects()) if (o.kind === "vector") bakeSize(o);
            this.commit();
            this.render();
            return;
        }
        if (drag.kind === "move" && !drag.moved) return;
        const o = this.data.objects.find((x) => x.id === drag.id);
        // a rectangle or ellipse takes its new size as its own: round corners stay round
        if (drag.kind === "scale" && o?.kind === "vector") bakeSize(o);
        this.commit();
        this.render();
    };

    private dragGroup(
        drag: Extract<Drag, { kind: "groupMove" | "groupScale" | "groupRotate" }>,
        p: Pt,
        e: PointerEvent,
    ) {
        const ids = new Set(drag.ids);
        const objects = this.data.objects.filter((o) => ids.has(o.id));
        // origins follow the ids' order; the objects come in burn order
        const order = objects.map((o) => drag.origins[drag.ids.indexOf(o.id)]);
        if (drag.kind === "groupMove") {
            const dx = p.x - drag.start.x;
            const dy = p.y - drag.start.y;
            if (!drag.moved && Math.hypot(dx, dy) < 3 * this.pixel()) return;
            drag.moved = true;
            moveAll(objects, order, dx, dy);
        } else if (drag.kind === "groupScale") {
            const w = drag.from.x - drag.anchor.x;
            const h = drag.from.y - drag.anchor.y;
            const sx = Math.abs(w) > 1e-9 ? (p.x - drag.anchor.x) / w : 1;
            const sy = Math.abs(h) > 1e-9 ? (p.y - drag.anchor.y) / h : 1;
            // the group keeps its proportions, as a locked object does
            const k = Math.max(0.01, Math.max(sx, sy));
            scaleAll(objects, order, drag.anchor, k, k);
        } else {
            const a = Math.atan2(p.y - drag.centre.y, p.x - drag.centre.x);
            let deg = ((a - drag.startAngle) * 180) / Math.PI;
            if (e.shiftKey) deg = Math.round(deg / 15) * 15;
            rotateAll(objects, order, drag.centre, normalizeAngle(deg));
        }
        for (const o of objects) this.updateObjectTransform(o);
        this.renderOverlay();
    }

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
        if (typeof e.key !== "string") return;
        // EzCAD's keys, here only while the laser editor has the focus (F1 is the browser's help)
        if (e.key === "F1" || e.key === "F2") {
            e.preventDefault();
            if (e.key === "F1") this.machine.toggleFraming("red");
            else void this.machine.mark();
            return;
        }
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
            return;
        const key = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && key === "z") {
            e.preventDefault();
            if (e.shiftKey) this.node.document.history.redo();
            else this.node.document.history.undo();
        } else if ((e.ctrlKey || e.metaKey) && key === "a") {
            e.preventDefault();
            this.selectMany(this.data.objects.map((o) => o.id));
        } else if ((e.ctrlKey || e.metaKey) && key === "d") {
            e.preventDefault();
            this.duplicateSelected();
        } else if ((e.ctrlKey || e.metaKey) && key === "y") {
            e.preventDefault();
            this.node.document.history.redo();
        } else if (key === "enter" && this.draft?.kind === "polyline") {
            e.preventDefault();
            this.finishPolylineDraft(false);
        } else if (key === "enter" && this.draft?.kind === "curve") {
            e.preventDefault();
            this.finishCurve(false);
        } else if ((key === "delete" || key === "backspace") && this.tool === "nodes") {
            e.preventDefault();
            this.nodeAction("delete");
        } else if (!e.ctrlKey && !e.metaKey && !e.altKey && TOOL_KEYS[key] !== undefined) {
            e.preventDefault();
            this.setTool(TOOL_KEYS[key]);
        } else if (key === "delete") {
            e.preventDefault();
            this.deleteSelected();
        } else if (key.startsWith("arrow") && this.chosen.length > 0) {
            e.preventDefault();
            this.nudge(key, e.shiftKey ? 10 : 1);
        }
    };

    private nudge(key: string, step: number) {
        const objects = this.selectedObjects();
        if (objects.length === 0) return;
        for (const o of objects) {
            if (key === "arrowleft") o.x -= step;
            if (key === "arrowright") o.x += step;
            if (key === "arrowup") o.y += step;
            if (key === "arrowdown") o.y -= step;
        }
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

/** The importer's and exporter's warning codes, each kind once with how many times it came up. */
const EZD_WARNINGS = [
    "hatch-auto-rotate-ignored",
    "hatch-extra-patterns-ignored",
    "hatch-crosshatch-single-angle",
    "hatch-contour-not-marked",
    "hatch-settings-guessed",
    "hatch-settings-unreadable",
    "hatch-cached-lines-used",
    "text-without-outline",
    "mixed-pens",
    "image-inside-group-skipped",
    "image-mirror-ignored",
    "control-object-skipped",
    "empty-object-skipped",
    "unsupported-object",
    "unknown-object-type",
    "unreadable-object",
    "unreadable-section",
    "image-skipped",
    "hidden-object-skipped",
    "too-many-pens",
    "pulse-width-not-written",
];

export function ezdWarnings(warnings: readonly string[]): string {
    const counts = new Map<string, number>();
    for (const w of warnings) {
        const code = w.split(":")[0];
        const key = EZD_WARNINGS.includes(code) ? code : "other";
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts]
        .map(([code, n]) => `${t(`laser.ezd.warn.${code}`)}${n > 1 ? ` (${n})` : ""}`)
        .join("; ");
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
