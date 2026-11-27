// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    Binding,
    Config,
    command,
    type FaceMeshData,
    I18n,
    type IApplication,
    type ICommand,
    type IDocument,
    type INode,
    MeshNode,
    NodeUtils,
    Observable,
    PubSub,
    type ShapeNode,
} from "@chili3d/core";
import { ClosestPointGrid } from "../scanTools/closestPoint";
import {
    type DeviationStats,
    type DisplayMesh,
    deviationColors,
    deviationRange,
    deviationStats,
    legendGradient,
    refineForDisplay,
    signedDistances,
} from "../scanTools/deviation";
import { estimateNoise } from "../scanTools/noise";
import { weldSoup } from "../scanTools/scanPrep";
import { sourceTriangles } from "../stlRebuild/sourceMesh";
import { isMeshSource, worldTriangles } from "./scanCommon";

/** Below this the map reads green: the CAD rebuild's own reach, or three times the scan's noise. */
const MIN_TOLERANCE = 0.05;

interface ShownMap {
    readonly document: IDocument;
    readonly node: MeshNode | ShapeNode;
    readonly meshId: number;
    readonly legend: HTMLElement | undefined;
    readonly stopWatching: () => void;
}

/**
 * Whether the deviation map is on — the ribbon toggle's state — and what it put up: the coloured
 * copy of the body (a temporary mesh, the body itself hidden meanwhile), the legend over the
 * viewport. One map at a time; it goes when toggled off, when the body changes, or when the
 * setting switches the tool off.
 */
export class DeviationMapState extends Observable {
    static readonly instance = new DeviationMapState();
    #shown: ShownMap | undefined;

    private constructor() {
        super();
        Config.instance.onPropertyChanged((property) => {
            if (property === "scanDeviationMap" && !Config.instance.scanDeviationMap) this.hide();
        });
    }

    get active(): boolean {
        return this.getPrivateValue("active", false);
    }
    private set active(value: boolean) {
        this.setProperty("active", value);
    }

    get shownNode(): INode | undefined {
        return this.#shown?.node;
    }

    show(
        document: IDocument,
        node: MeshNode | ShapeNode,
        data: FaceMeshData,
        legend: HTMLElement | undefined,
    ) {
        this.hide();
        const meshId = document.visual.context.displayMesh([data]);
        document.visual.context.setVisible(node, false);
        const watch = (property: string | number | symbol) => {
            if (property === "shape" || property === "transform" || property === "mesh") this.hide();
        };
        const observed = node as INode;
        observed.onPropertyChanged(watch);
        this.#shown = {
            document,
            node,
            meshId,
            legend,
            stopWatching: () => observed.removePropertyChanged(watch),
        };
        this.active = true;
        document.visual.update();
    }

    hide() {
        const shown = this.#shown;
        this.#shown = undefined;
        if (shown !== undefined) {
            shown.stopWatching();
            shown.legend?.remove();
            try {
                shown.document.visual.context.removeMesh(shown.meshId);
                shown.document.visual.context.setVisible(
                    shown.node,
                    shown.node.visible && shown.node.parentVisible,
                );
                shown.document.visual.update();
            } catch {
                // the document closed under the map: nothing left to take down
            }
        }
        this.active = false;
    }
}

/** The body's display mesh in world coordinates: a shape's faces, or a mesh node's own triangles. */
function displayMeshOf(node: MeshNode | ShapeNode): DisplayMesh | undefined {
    const matrix = node.worldTransform();
    if (node instanceof MeshNode) {
        const position = node.mesh.position;
        if (position === undefined) return undefined;
        const index = node.mesh.index?.length
            ? node.mesh.index
            : Uint32Array.from({ length: position.length / 3 }, (_, i) => i);
        const normal =
            node.mesh.normal?.length === position.length
                ? node.mesh.normal
                : new Float32Array(position.length);
        return {
            position: Float32Array.from(matrix.ofPoints(position)),
            normal: Float32Array.from(matrix.ofVectors(normal)),
            index,
        };
    }
    const faces = node.shape.value.mesh.faces;
    if (faces === undefined || faces.index.length === 0) return undefined;
    return {
        position: Float32Array.from(matrix.ofPoints(faces.position)),
        normal: Float32Array.from(matrix.ofVectors(faces.normal)),
        index: faces.index,
    };
}

export interface DeviationMapResult {
    readonly display: DisplayMesh;
    readonly colors: number[];
    readonly stats: DeviationStats;
    readonly tol: number;
    readonly range: number;
}

/**
 * The map's numbers for a body against the reference triangles: the body's display mesh
 * refined (`refineForDisplay`), every vertex's signed distance to the reference, the colours.
 * The tolerance is the larger of 0.05 mm and three times the reference's noise.
 */
export function computeDeviationMap(
    body: DisplayMesh,
    reference: Float64Array,
    size: number,
): DeviationMapResult {
    const display = refineForDisplay(body, Math.max(size / 120, 1e-3));
    const grid = new ClosestPointGrid(reference);
    const d = signedDistances(display.position, grid);
    const noise = reference.length / 9 <= 2_000_000 ? estimateNoise(weldSoup(reference)) : 0;
    const tol = Math.max(MIN_TOLERANCE, 3 * noise);
    const range = deviationRange(d, tol);
    return { display, colors: deviationColors(d, tol, range), stats: deviationStats(d, tol), tol, range };
}

/**
 * The reference the body is measured against: the hidden node the rebuild left right before
 * it (the imported part), else the only other mesh in the document, else the one picked.
 */
async function referenceFor(document: IDocument, body: INode): Promise<(MeshNode | ShapeNode) | undefined> {
    const previous = body.previousSibling;
    if (previous !== undefined && isMeshSource(previous) && !previous.visible) return previous;
    const others = [...NodeUtils.children(document.modelManager.rootNode)].filter(
        (n): n is MeshNode | ShapeNode =>
            n !== body && isMeshSource(n) && (n instanceof MeshNode || sourceTriangles(n.id) !== undefined),
    );
    if (others.length === 1) return others[0];
    const picked = await document.picker.pickNode("prompt.select.scanReference", new AsyncController(), {
        nodeFilter: { allow: (n) => n !== body && isMeshSource(n) },
    });
    const node = picked[0];
    return node !== undefined && isMeshSource(node) ? node : undefined;
}

function legendElement(view: HTMLElement | undefined, result: DeviationMapResult): HTMLElement | undefined {
    if (view === undefined) return undefined;
    const { tol, range, stats } = result;
    const mm = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)}`;
    const root = document.createElement("div");
    root.className = "kern3d-deviation-legend";
    Object.assign(root.style, {
        position: "absolute",
        left: "12px",
        bottom: "12px",
        zIndex: "5",
        padding: "8px 10px",
        borderRadius: "8px",
        background: "var(--panel-background-color, rgba(30,30,30,0.85))",
        color: "var(--foreground-color, #eee)",
        border: "1px solid var(--border-color, #555)",
        font: "12px sans-serif",
        pointerEvents: "none",
        display: "flex",
        gap: "8px",
    });
    const bar = document.createElement("div");
    Object.assign(bar.style, {
        width: "14px",
        height: "160px",
        borderRadius: "3px",
        background: `linear-gradient(to bottom, ${legendGradient(tol, range)})`,
    });
    const ticks = document.createElement("div");
    Object.assign(ticks.style, { position: "relative", height: "160px", width: "58px" });
    for (const v of [range, tol, 0, -tol, -range]) {
        const tick = document.createElement("div");
        tick.textContent = v === 0 ? "0" : mm(v);
        Object.assign(tick.style, {
            position: "absolute",
            top: `${((range - v) / (2 * range)) * 160 - 7}px`,
            whiteSpace: "nowrap",
        });
        ticks.append(tick);
    }
    const text = document.createElement("div");
    text.style.whiteSpace = "pre";
    text.textContent = I18n.translate(
        "scan.deviation.legend{0}{1}{2}{3}{4}",
        mm(stats.max),
        mm(stats.min),
        stats.meanAbs.toFixed(3),
        (stats.within * 100).toFixed(1),
        tol.toFixed(3),
    );
    root.append(bar, ticks, text);
    view.append(root);
    return root;
}

/**
 * «Карта отклонений» (a toggle): a body coloured by its distance to the source mesh — green
 * within tolerance, red where it stands outside the mesh, blue where inside — with a legend in
 * mm and the max / mean numbers. On: pick the body (the rebuilt one, say); the reference is the
 * imported part the rebuild left beside it, the only mesh, or one picked. Off: the body as it was.
 */
@command({
    key: "scan.deviationMap",
    icon: "icon-checkShape",
    toggle: new Binding(DeviationMapState.instance, "active"),
    isEnabled: () => Config.instance.scanDeviationMap,
})
export class ScanDeviationMapCommand implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const state = DeviationMapState.instance;
        if (state.active) {
            state.hide();
            return;
        }
        const document = app.activeView?.document;
        if (document === undefined) return;
        let body = document.selection.getSelectedNodes().find(isMeshSource);
        if (body === undefined) {
            const picked = await document.picker.pickNode("prompt.select.scanBody", new AsyncController(), {
                nodeFilter: { allow: isMeshSource },
            });
            body = picked.find(isMeshSource);
        }
        if (body === undefined) return;
        const reference = await referenceFor(document, body);
        if (reference === undefined) {
            PubSub.default.pub("showToast", "toast.scan.deviation.noReference");
            return;
        }
        const display = displayMeshOf(body);
        if (display === undefined) return;
        const box = body.boundingBox();
        const size =
            box === undefined
                ? 100
                : Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
        const result = computeDeviationMap(display, worldTriangles(reference), size);
        const data: FaceMeshData = {
            position: result.display.position,
            normal: result.display.normal,
            index: result.display.index,
            uv: new Float32Array((result.display.position.length / 3) * 2),
            groups: [],
            range: [],
            color: result.colors,
        };
        document.selection.clearSelection();
        state.show(document, body, data, legendElement(app.activeView?.dom, result));
    }
}
