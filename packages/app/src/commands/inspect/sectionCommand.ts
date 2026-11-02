// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    Combobox,
    command,
    GeometryUtils,
    type IFace,
    type IView,
    Line,
    Plane,
    PointOnAxisStep,
    PubSub,
    property,
    SelectShapeStep,
    type ShapeMeshData,
    ShapeTypes,
} from "@chili3d/core";
import { visibleBodies, worldShapeOf } from "./inspectUtils";
import { sectionCap } from "./sectionCaps";

export const SECTION_SOURCES = [
    "inspect.section.face",
    "inspect.section.workplane",
    "inspect.section.xy",
    "inspect.section.yz",
    "inspect.section.zx",
] as const;

export type SectionSource = (typeof SECTION_SOURCES)[number];

const CAP_COLOR = 0xd9534f;
const CAP_EDGE_COLOR = 0x5a1a17;

/** The display meshes of a view's active section, so the toggle can take them away. */
const capMeshes = new WeakMap<IView, { remove: () => void }>();

/** The cut plane a base plane, an offset along its normal and a flip make: its normal points to the removed side. */
export function sectionPlaneOf(base: Plane, offset: number, flip: boolean): Plane {
    const origin = base.origin.add(base.normal.multiply(offset));
    const normal = flip ? base.normal.reverse() : base.normal;
    return new Plane({ origin, normal, xvec: base.xvec });
}

/** Turns a view's section off: the clip goes and so do its caps. */
export function clearSection(view: IView) {
    removeCaps(view);
    view.setSectionPlane?.(undefined);
}

function removeCaps(view: IView) {
    capMeshes.get(view)?.remove();
    capMeshes.delete(view);
}

/**
 * Section analysis: clips the active view by a plane — a picked face or datum plane, the
 * working plane, or a principal plane — offset along its normal by a typed or dragged
 * distance and optionally flipped, and caps the cut faces of every visible body so the
 * section reads as solid. It is view state only: the model is untouched and nothing is
 * saved. The section stays after the tool ends (Esc); running the tool again turns it off.
 */
@command({
    key: "inspect.section",
    icon: "icon-section",
})
export class SectionAnalysisCommand extends CancelableCommand {
    #base?: Plane;
    #started = false;
    /** A drag took the caps away; they are rebuilt for whichever cut the drag ends on. */
    #capsStale = false;

    @property("inspect.section.source", { combobox: Combobox.from([...SECTION_SOURCES]) })
    get source(): SectionSource {
        return this.getPrivateValue("source", "inspect.section.face");
    }
    set source(value: SectionSource) {
        this.setProperty("source", value, () => {
            this.#base = undefined;
            if (this.controller !== undefined) void this.restart();
        });
    }

    /** mm along the plane's normal */
    @property("inspect.section.offset")
    get offset(): number {
        return this.getPrivateValue("offset", 0);
    }
    set offset(value: number) {
        this.setProperty("offset", value, () => this.apply(true));
    }

    @property("inspect.section.flip")
    get flip(): boolean {
        return this.getPrivateValue("flip", false);
    }
    set flip(value: boolean) {
        this.setProperty("flip", value, () => this.apply(true));
    }

    @property("inspect.section.caps")
    get caps(): boolean {
        return this.getPrivateValue("caps", true);
    }
    set caps(value: boolean) {
        this.setProperty("caps", value, () => this.apply(true));
    }

    protected override async executeAsync(): Promise<void> {
        const view = this.application.activeView;
        if (!view?.setSectionPlane) return;
        if (!this.#started) {
            this.#started = true;
            if (view.sectionPlane) {
                clearSection(view);
                PubSub.default.pub("showToast", "inspect.section.off");
                return;
            }
        }
        this.#base ??= await this.pickBasePlane(view);
        if (!this.#base) return;
        this.apply(true);
        await this.dragOffset();
    }

    private async pickBasePlane(view: IView): Promise<Plane | undefined> {
        switch (this.source) {
            case "inspect.section.workplane":
                return view.workplane;
            case "inspect.section.xy":
                return Plane.XY;
            case "inspect.section.yz":
                return Plane.YZ;
            case "inspect.section.zx":
                return Plane.ZX;
        }
        this.controller = new AsyncController();
        const data = await new SelectShapeStep(ShapeTypes.face, "prompt.select.faces", {
            allowReferenceGeometry: true,
        }).execute(this.document, this.controller);
        this.document.selection.clearSelection();
        const picked = data?.shapes[0];
        if (this.controller.result?.status !== "success" || !picked) return undefined;
        const face = picked.shape.transformedMul(picked.transform) as IFace;
        const plane = GeometryUtils.planeFromFace(face);
        face.dispose();
        return plane;
    }

    /** Drag (or type) the offset along the normal until Esc; the clip follows the pointer, caps follow a click. */
    private async dragOffset() {
        const base = this.#base!;
        while (!this.checkCanceled()) {
            this.controller = new AsyncController();
            const step = new PointOnAxisStep("inspect.section.dragOffset", () => ({
                ray: new Line({ point: base.origin, direction: base.normal }),
                preview: (point) => {
                    const view = this.application.activeView;
                    if (!view) return [];
                    // The caps belong to the committed cut; a moving one would leave them floating.
                    if (point && capMeshes.has(view)) {
                        removeCaps(view);
                        this.#capsStale = true;
                    }
                    const offset = point ? point.sub(base.origin).dot(base.normal) : this.offset;
                    view.setSectionPlane?.(sectionPlaneOf(base, offset, this.flip));
                    return [];
                },
            }));
            const data = await step.execute(this.document, this.controller);
            if (this.controller.result?.status !== "success" || !data?.point) {
                // Back to the committed cut; its caps come back only if the drag took them away.
                this.apply(this.#capsStale);
                return;
            }
            const offset = data.point.sub(base.origin).dot(base.normal);
            // A changed offset re-applies through its setter; an unchanged one still needs the caps back.
            if (!this.setProperty("offset", offset, () => this.apply(true))) this.apply(true);
        }
    }

    private apply(withCaps: boolean) {
        // Before the tool runs (a parameter restored or set ahead) there is no plane to move yet.
        if (!this.#base) return;
        const view = this.application.activeView;
        if (!view?.setSectionPlane) return;
        const plane = sectionPlaneOf(this.#base, this.offset, this.flip);
        view.setSectionPlane(plane);
        if (withCaps) this.showCaps(view, plane);
    }

    private showCaps(view: IView, plane: Plane) {
        removeCaps(view);
        this.#capsStale = false;
        if (!this.caps) return;
        const meshes = this.capMeshes(plane);
        if (meshes.length === 0) return;
        const context = this.document.visual.context;
        const id = context.displayMesh(meshes);
        capMeshes.set(view, {
            remove: () => {
                context.removeMesh(id);
                view.update();
            },
        });
        view.update();
    }

    private capMeshes(plane: Plane): ShapeMeshData[] {
        const meshes: ShapeMeshData[] = [];
        for (const node of visibleBodies(this.document)) {
            const shape = worldShapeOf(node);
            const cap = Math.abs(shape.volume()) > 1e-9 ? sectionCap(shape, plane) : undefined;
            shape.dispose();
            if (!cap) continue;
            const { faces, edges } = cap.mesh;
            if (faces) {
                faces.color = CAP_COLOR;
                meshes.push(faces);
            }
            if (edges) {
                edges.color = CAP_EDGE_COLOR;
                meshes.push(edges);
            }
            cap.dispose();
        }
        return meshes;
    }
}
