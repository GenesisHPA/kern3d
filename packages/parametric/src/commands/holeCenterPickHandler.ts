// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    Config,
    CurveUtils,
    type IDocument,
    type IEdge,
    type IFace,
    type IView,
    MeshDataUtils,
    PubSub,
    ShapeSelectionHandler,
    ShapeTypes,
    screenDistance,
    ViewUtils,
    VisualConfig,
    VisualStates,
    XYZ,
} from "@chili3d/core";
import { ParametricBodyNode } from "../parametricBodyNode";
import { pointCrossMesh } from "../sketch/curveMesh";
import { toUV, toWorld } from "../sketch/sketchModel";
import { SketchNode } from "../sketch/sketchNode";
import { capturePickedHoleFace, type PickedHoleFace } from "./holeFace";

/**
 * A sketch's standalone point the handler hit-tested — under the cursor right now, or
 * remembered as selected. `world` is the entity's position in world coordinates.
 */
export interface SketchPointGlyphHit {
    readonly sketch: SketchNode;
    readonly entityId: number;
    readonly world: XYZ;
}

/**
 * The nearest visible sketch's standalone point within `tolerancePx` screen pixels of (x, y).
 * A sketch point is NOT a sub-shape — it never enters the sketch's geometry, so the pick
 * pipeline cannot hit it and the handler hit-tests the glyphs itself, in pixels like the snap
 * system does (`screenDistance`). Construction points are skipped: they draw no cross outside
 * the editor, and a pick must land on something visible.
 */
export function sketchPointGlyphAt(
    document: IDocument,
    view: IView,
    x: number,
    y: number,
    tolerancePx: number = Config.instance.SnapDistance,
): SketchPointGlyphHit | undefined {
    let best: SketchPointGlyphHit | undefined;
    let bestDistance = tolerancePx;
    const sketches = document.modelManager.findNodes((n) => n instanceof SketchNode) as SketchNode[];
    for (const sketch of sketches) {
        if (!sketch.visible || !sketch.parentVisible) continue;
        const transform = sketch.worldTransform();
        for (const entity of sketch.data.entities) {
            if (entity.type !== "point" || entity.construction === true) continue;
            const world = transform.ofPoint(toWorld(sketch.plane, entity.params[0], entity.params[1]));
            const distance = screenDistance(view, x, y, world);
            if (distance <= bestDistance) {
                bestDistance = distance;
                best = { sketch, entityId: entity.id, world };
            }
        }
    }
    return best;
}

/**
 * The hole command's first step: pick the hole centers straight off the sketches' point
 * glyphs — a click toggles one, Enter or the confirm bar finishes — or click a planar face of
 * a parametric body to take the face instead (`faceResult`, ending the step, since
 * `multiMode` is off). A point glyph wins over the face under it: the cross the user is
 * aiming at is what the click takes, so the face highlight comes down while one is hovered.
 *
 * All centers come from ONE sketch (`HoleSketchPoints` is a one-sketch list): a click on
 * another sketch's point is refused with a toast. Selected points keep their crosses — the
 * selected tone against the hover one, the same green-vs-lime split the viewport's
 * selected-vs-highlight faces use — until toggled off or the handler is disposed.
 *
 * `selectedPoints` is the COMMAND's list, handed in so a re-entered step (a failed face
 * deduction asks for a face next) keeps what was picked; the handler mutates it in place.
 */
/** The area centroid of a face, from its display triangles (the face's own coordinates). */
export function faceCentroid(face: IFace): XYZ | undefined {
    const mesh = face.mesh?.faces;
    if (mesh === undefined || mesh.index.length < 3) return undefined;
    const p = mesh.position;
    let area = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i + 2 < mesh.index.length; i += 3) {
        const [a, b, c] = [mesh.index[i] * 3, mesh.index[i + 1] * 3, mesh.index[i + 2] * 3];
        const ux = p[b] - p[a];
        const uy = p[b + 1] - p[a + 1];
        const uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a];
        const vy = p[c + 1] - p[a + 1];
        const vz = p[c + 2] - p[a + 2];
        const w = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
        area += w;
        cx += (w * (p[a] + p[b] + p[c])) / 3;
        cy += (w * (p[a + 1] + p[b + 1] + p[c + 1])) / 3;
        cz += (w * (p[a + 2] + p[b + 2] + p[c + 2])) / 3;
    }
    if (area <= 0) return undefined;
    return new XYZ({ x: cx / area, y: cy / area, z: cz / area });
}

/**
 * The points a hole is aimed at on a face: the face's own center, then the centers of its
 * circular edges (a cylinder's end, an existing hole) — in the face's own coordinates.
 */
function circleCentersOf(face: IFace): XYZ[] {
    const centers: XYZ[] = [];
    const own = faceCentroid(face);
    if (own !== undefined) centers.push(own);
    const edges = (face.findSubShapes?.(ShapeTypes.edge) ?? []) as IEdge[];
    if (edges.length > 64) return centers;
    for (const edge of edges) {
        try {
            // the edge owns its cached curve: read it, never dispose it
            const basis = edge.curve.basisCurve;
            if (CurveUtils.isCircle(basis) && !centers.some((c) => c.distanceTo(basis.center) < 1e-6)) {
                centers.push(basis.center);
            }
        } catch {
            // a degenerate edge has no curve
        }
    }
    return centers;
}

export class HoleCenterPickHandler extends ShapeSelectionHandler {
    /** The face a click captured — the step's "place the holes on this face" answer. */
    faceResult: PickedHoleFace | undefined;
    /** Where on the face the click landed (world), the hole's center when it lands on the face. */
    facePoint: XYZ | undefined;
    /** True when the click was within snap reach of a shown center and `facePoint` is that center. */
    faceSnapped = false;

    private _hovered: SketchPointGlyphHit | undefined;
    /** The hovered face's round-edge centers (world) and their markers. */
    private _centerFace: object | undefined;
    private _centers: XYZ[] = [];
    private _centerMeshIds: number[] = [];
    private _nearMeshId: number | undefined;
    private _hoverMeshId: number | undefined;
    private _selectedMeshIds: number[] = [];

    constructor(
        document: IDocument,
        controller: AsyncController,
        readonly selectedPoints: SketchPointGlyphHit[],
    ) {
        super(
            document,
            ShapeTypes.face,
            false,
            controller,
            { allow: (shape) => (shape as IFace).surface().isPlanar() },
            { allow: (node) => node instanceof ParametricBodyNode },
        );
        this.highlightState = VisualStates.faceHighlight;
        const view = document.application.activeView;
        if (view !== undefined && this.selectedPoints.length > 0) this.rebuildSelectedMeshes(view);
    }

    protected override setHighlight(view: IView, event: PointerEvent): void {
        const hit = sketchPointGlyphAt(this.document, view, event.offsetX, event.offsetY);
        if (hit !== undefined) {
            // Drawing and picking stay in step: a glyph under the pointer wins over the face
            // behind it, so the face highlight has to come down (the datum picker's contract).
            this.cleanHighlights();
        } else {
            super.setHighlight(view, event);
        }
        this.setHoveredPoint(view, hit);
        this.showCenters(view, event);
    }

    /**
     * The hovered face's circle centers (a cylinder's end, an existing hole), drawn as points so
     * they can be aimed at; the one under the cursor's snap reach is drawn larger — a click there
     * puts the hole exactly on it.
     */
    private showCenters(view: IView, event: PointerEvent): void {
        const face = this._highlights?.[0];
        const context = this.document.visual.context;
        if (face?.shape !== this._centerFace) {
            this._centerMeshIds.forEach((id) => context.removeMesh(id));
            this._centerMeshIds = [];
            this._centers = [];
            this._centerFace = face?.shape;
            if (face !== undefined) {
                this._centers = circleCentersOf(face.shape as IFace).map((c) => face.transform.ofPoint(c));
                this._centerMeshIds = this._centers.map((c) =>
                    context.displayMesh(
                        [
                            MeshDataUtils.createVertexMesh(
                                c,
                                VisualConfig.hintVertexSize,
                                VisualConfig.hintVertexColor,
                            ),
                        ],
                        { onTop: true },
                    ),
                );
            }
        }
        if (this._nearMeshId !== undefined) {
            context.removeMesh(this._nearMeshId);
            this._nearMeshId = undefined;
        }
        const near = this._centers.find(
            (c) => screenDistance(view, event.offsetX, event.offsetY, c) < Config.instance.SnapDistance,
        );
        if (near !== undefined) {
            this._nearMeshId = context.displayMesh(
                [
                    MeshDataUtils.createVertexMesh(
                        near,
                        VisualConfig.editVertexSize * 1.6,
                        VisualConfig.selectedEdgeColor,
                    ),
                ],
                { onTop: true },
            );
        }
        view.update();
    }

    private clearCenters(): void {
        const context = this.document.visual.context;
        this._centerMeshIds.forEach((id) => context.removeMesh(id));
        this._centerMeshIds = [];
        if (this._nearMeshId !== undefined) context.removeMesh(this._nearMeshId);
        this._nearMeshId = undefined;
        this._centers = [];
        this._centerFace = undefined;
    }

    override pointerOut(view: IView, event: PointerEvent): void {
        super.pointerOut(view, event);
        this.setHoveredPoint(view, undefined);
        this.clearCenters();
    }

    private setHoveredPoint(view: IView, hit: SketchPointGlyphHit | undefined): void {
        if (hit?.sketch === this._hovered?.sketch && hit?.entityId === this._hovered?.entityId) return;
        this._hovered = hit;
        if (this._hoverMeshId !== undefined) {
            this.document.visual.context.removeMesh(this._hoverMeshId);
            this._hoverMeshId = undefined;
        }
        if (hit !== undefined) {
            this._hoverMeshId = this.displayCross(view, hit, VisualConfig.highlightFaceColor);
        }
        view.update();
    }

    protected override select(view: IView, event: PointerEvent): number {
        const hit = sketchPointGlyphAt(this.document, view, event.offsetX, event.offsetY);
        if (hit !== undefined) {
            this.togglePoint(view, hit);
            return 0; // toggling never ends the step — Enter or the confirm bar does
        }
        const face = this._highlights?.[0];
        const body = face?.owner.node;
        if (face === undefined || !(body instanceof ParametricBodyNode)) return 0;
        this.faceResult = capturePickedHoleFace(body, face.shape as IFace, face.transform, face.indexes[0]);
        const near = this._centers.find(
            (c) => screenDistance(view, event.offsetX, event.offsetY, c) < Config.instance.SnapDistance,
        );
        this.faceSnapped = near !== undefined;
        this.facePoint =
            near ?? this.faceResult?.worldFrame.intersectRay(view.rayAt(event.offsetX, event.offsetY));
        return 1;
    }

    private togglePoint(view: IView, hit: SketchPointGlyphHit): void {
        const index = this.selectedPoints.findIndex(
            (x) => x.sketch === hit.sketch && x.entityId === hit.entityId,
        );
        if (index >= 0) {
            this.selectedPoints.splice(index, 1);
        } else {
            const pinned = this.selectedPoints[0]?.sketch;
            if (pinned !== undefined && pinned !== hit.sketch) {
                PubSub.default.pub(
                    "showToast",
                    "error.default:{0}",
                    "Hole centers must come from one sketch",
                );
                return;
            }
            this.selectedPoints.push(hit);
        }
        this.rebuildSelectedMeshes(view);
    }

    private rebuildSelectedMeshes(view: IView): void {
        const context = this.document.visual.context;
        this._selectedMeshIds.forEach((id) => context.removeMesh(id));
        this._selectedMeshIds = this.selectedPoints.map((hit) =>
            this.displayCross(view, hit, VisualConfig.selectedEdgeColor),
        );
    }

    /**
     * A cross on the point's own sketch plane, on top like the datum quads: the sketch's own
     * cross sits at the same spot, and a pick affordance must not z-fight or hide behind the
     * geometry it floats over. `half` is the arm half-length in world units, measured off the
     * view so the cross reads at a constant pixel size.
     */
    private displayCross(view: IView, hit: SketchPointGlyphHit, color: number): number {
        const plane = hit.sketch.plane.transformed(hit.sketch.worldTransform());
        const half = (ViewUtils.viewPixelSize(view, hit.world) ?? 0) * (VisualConfig.editVertexSize / 2);
        return this.document.visual.context.displayMesh(
            [pointCrossMesh(plane, toUV(plane, hit.world), half, color)],
            { onTop: true },
        );
    }

    protected override highlightNext(_view: IView): void {
        // no cycling: at most one face is highlighted, and the glyphs hit-test per move
    }

    protected override disposeInternal(): void {
        super.disposeInternal();
        this.clearCenters();
        const context = this.document.visual.context;
        if (this._hoverMeshId !== undefined) {
            context.removeMesh(this._hoverMeshId);
            this._hoverMeshId = undefined;
        }
        this._selectedMeshIds.forEach((id) => context.removeMesh(id));
        this._selectedMeshIds = [];
    }
}
