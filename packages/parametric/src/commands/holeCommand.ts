// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    AsyncController,
    Combobox,
    Config,
    CurveUtils,
    command,
    Dimensions,
    type EdgeMeshData,
    type I18nKeys,
    type ICurve,
    Id,
    type IEdge,
    type IFace,
    type IStep,
    type IView,
    LENGTH_UNITS,
    MultistepCommand,
    type ParameterValue,
    PointOnPlaneStep,
    type PointSnapData,
    PubSub,
    property,
    type ShapeMeshData,
    ShapeTypes,
    type SnapResult,
    Transaction,
    ViewUtils,
    VisualConfig,
    type XYZ,
} from "@chili3d/core";
import type { HoleFeatureData, HoleSketchPoints } from "../features/feature";
import { findSketchPointAt, holePointUV, previewHoleTools, type SketchPointSnap } from "../features/hole";
import { pointCrossMesh } from "../sketch/curveMesh";
import type { PlaneFaceRef } from "../sketch/planeRef";
import { HoleCenterPickHandler, type SketchPointGlyphHit } from "./holeCenterPickHandler";
import { deduceHoleFace, type PickedHoleFace } from "./holeFace";

/**
 * Hole: pick hole centers straight off the sketches' point glyphs (click toggles, Enter or the
 * confirm bar finishes), and the face to drill is DEDUCED from the points' sketch — the planar
 * body face coplanar with it that the picks land on. Clicking a face instead of a glyph takes
 * that face directly and opens the raw-center loop on it (with the picked points already
 * bound), which is also the fallback a failed deduction asks for. One feature is appended to
 * the body's chain. The style and sizes ride on the options panel here (and the feature's own
 * rows afterwards — the panel row is also where the standard-size presets live).
 *
 * The centers are stored as (u, v) coordinates in the face's sketch-plane frame (see
 * `HoleFeatureData`), so a later rebuild moves them with the face. Each raw pick is validated
 * to land on the face (a boundary tolerance included) before it is accepted. A pick that lands
 * within snap reach of a sketch's standalone point BINDS to it instead (`sketchPoints`): the
 * center then follows the entity on every rebuild. The first bound point pins the sketch —
 * later picks snap to its points only, and one near another sketch's point stays a raw pick.
 */
/** Whether `point` is the center of a circular edge of `face` — an existing hole's rim. */
export function isOpeningCenterOf(face: IFace, point: XYZ): boolean {
    for (const edge of face.findSubShapes(ShapeTypes.edge) as IEdge[]) {
        let curve: ICurve | undefined;
        try {
            curve = edge.curve;
            const basis = CurveUtils.isTrimmed(curve) ? curve.basisCurve : curve;
            if (
                CurveUtils.isCircle(basis) &&
                basis.center.distanceTo(point) < 1e-4 * Math.max(1, basis.radius)
            ) {
                return true;
            }
        } catch {
            // a degenerate edge has no curve
        } finally {
            (curve as { dispose?: () => void } | undefined)?.dispose?.();
        }
    }
    return false;
}

const STYLE_SIMPLE: I18nKeys = "feature.hole.style.simple";
const STYLE_COUNTERBORE: I18nKeys = "feature.hole.style.counterbore";
const STYLE_COUNTERSINK: I18nKeys = "feature.hole.style.countersink";

@command({ key: "feature.hole", icon: "icon-hole" })
export class HoleFeatureCommand extends MultistepCommand {
    @property("common.type", {
        combobox: Combobox.from([STYLE_SIMPLE, STYLE_COUNTERBORE, STYLE_COUNTERSINK]),
    })
    get style(): I18nKeys {
        return this.getPrivateValue("style", STYLE_SIMPLE);
    }
    set style(value: I18nKeys) {
        this.setProperty("style", value);
    }

    @property("dimension.diameter", { unit: LENGTH_UNITS })
    get diameter(): ParameterValue {
        return this.getPrivateValue("diameter", 5);
    }
    set diameter(value: ParameterValue) {
        this.setProperty("diameter", value);
    }

    /** Blind depth, drill point included; empty drills through everything (the default). */
    @property("feature.hole.depth", { unit: LENGTH_UNITS })
    get depth(): ParameterValue {
        return this.getPrivateValue("depth", "");
    }
    set depth(value: ParameterValue) {
        this.setProperty("depth", value);
    }

    @property("feature.hole.drillAngle", { unit: ANGLE_UNITS })
    get drillAngle(): ParameterValue {
        return this.getPrivateValue("drillAngle", 118);
    }
    set drillAngle(value: ParameterValue) {
        this.setProperty("drillAngle", value);
    }

    @property("feature.hole.counterboreDiameter", {
        unit: LENGTH_UNITS,
        dependencies: [{ property: "style", value: STYLE_COUNTERBORE }],
    })
    get counterboreDiameter(): ParameterValue {
        return this.getPrivateValue("counterboreDiameter", 10);
    }
    set counterboreDiameter(value: ParameterValue) {
        this.setProperty("counterboreDiameter", value);
    }

    @property("feature.hole.counterboreDepth", {
        unit: LENGTH_UNITS,
        dependencies: [{ property: "style", value: STYLE_COUNTERBORE }],
    })
    get counterboreDepth(): ParameterValue {
        return this.getPrivateValue("counterboreDepth", 3);
    }
    set counterboreDepth(value: ParameterValue) {
        this.setProperty("counterboreDepth", value);
    }

    @property("feature.hole.countersinkDiameter", {
        unit: LENGTH_UNITS,
        dependencies: [{ property: "style", value: STYLE_COUNTERSINK }],
    })
    get countersinkDiameter(): ParameterValue {
        return this.getPrivateValue("countersinkDiameter", 10);
    }
    set countersinkDiameter(value: ParameterValue) {
        this.setProperty("countersinkDiameter", value);
    }

    @property("feature.hole.countersinkAngle", {
        unit: ANGLE_UNITS,
        dependencies: [{ property: "style", value: STYLE_COUNTERSINK }],
    })
    get countersinkAngle(): ParameterValue {
        return this.getPrivateValue("countersinkAngle", 90);
    }
    set countersinkAngle(value: ParameterValue) {
        this.setProperty("countersinkAngle", value);
    }

    private picked: PickedHoleFace | undefined;
    private isConfirm = false;
    /**
     * The sketch points bound so far — a bound pick adds NO stepData, so `stepDatas` stays
     * the raw centers alone. The first entry's sketch is the pinned one (see the class doc).
     */
    private boundCenters: SketchPointSnap[] = [];
    /**
     * The sketch points picked in step one. The handler mutates this list in place, and it
     * survives a re-entry of the step, so a failed face deduction keeps the picks.
     */
    private centerPicks: SketchPointGlyphHit[] = [];

    protected override onRestarting(): void {
        super.onRestarting();
        this.picked = undefined;
        this.boundCenters = [];
        this.centerPicks = [];
    }

    protected override getSteps(): IStep[] {
        // The whole interaction runs from `executeSteps` — there is no fixed step list.
        return [];
    }

    /**
     * Step one picks sketch points as hole centers and/or the face to drill, repeating until
     * one of three exits: a cancel (false); a face click — the centers picked so far bind and
     * the raw-center loop opens on the face; or a confirm with centers and no face — the face
     * is then deduced from the points' sketch (`deduceHoleFace`), and a failed deduction keeps
     * the picks and asks again, where a face click takes the mixed path. A confirm with
     * nothing picked toasts and repeats.
     */
    protected override async executeSteps(): Promise<boolean> {
        try {
            while (true) {
                this.controller = new AsyncController();
                const handler = new HoleCenterPickHandler(this.document, this.controller, this.centerPicks);
                try {
                    this.document.selection.clearSelection();
                    await this.document.picker.pickAsync(
                        handler,
                        "prompt.select.sketchPoints",
                        this.controller,
                        "confirm",
                        "select.default",
                    );
                } finally {
                    handler.dispose();
                }
                if (this.controller.result?.status !== "success") return false;

                if (handler.faceResult !== undefined) {
                    this.picked = handler.faceResult;
                    this.bindCenterPicks();
                    return await this.collectRawPoints();
                }
                if (this.centerPicks.length === 0) {
                    PubSub.default.pub("showToast", "error.default:{0}", "Pick at least one hole center");
                    continue;
                }
                const deduced = deduceHoleFace(
                    this.document,
                    this.centerPicks[0].sketch,
                    this.centerPicks.map((x) => x.entityId),
                );
                if (deduced === undefined) {
                    PubSub.default.pub(
                        "showToast",
                        "error.default:{0}",
                        "No coplanar face found — click the hole face",
                    );
                    continue;
                }
                this.picked = deduced;
                this.bindCenterPicks();
                return true;
            }
        } finally {
            this.picked?.worldFace.dispose();
        }
    }

    /**
     * The raw-center loop after a face click: drop points on the face until Enter or the
     * confirm bar ends the list. The polygon's finish contract applies: Enter/Space reports
     * as a cancel with `isConfirm` set first, the confirm bar succeeds with no point under
     * the cursor; either is "done", anything else aborts.
     */
    private async collectRawPoints(): Promise<boolean> {
        this.isConfirm = false; // a restart re-enters here with the flag from the last run
        this.onPropertyChanged(this.onOptionChanged);
        try {
            return await this.rawPointLoop();
        } finally {
            this.removePropertyChanged(this.onOptionChanged);
            this.redrawPreview = undefined;
        }
    }

    private async rawPointLoop(): Promise<boolean> {
        while (true) {
            this.controller = new AsyncController();
            const step = new PointOnPlaneStep("prompt.select.holeCenters", this.pointData, false, true);
            const data = await step.execute(this.document, this.controller);
            if (data === undefined || this.controller.result?.status !== "success") {
                return this.isConfirm || this.controller.result?.status === "success";
            }
            // A pick snapped to a sketch point binds to it rather than adding a raw center.
            if (!this.bindSketchPoint(data)) this.stepDatas.push(data);
        }
    }

    /** The picked sketch points as bound centers, projected onto the now-known face frame. */
    private bindCenterPicks(): void {
        const frame = this.picked!.worldFrame;
        this.boundCenters = this.centerPicks.map((pick) => ({
            sketchId: pick.sketch.id,
            entityId: pick.entityId,
            center: frame.project(pick.world),
        }));
    }

    private readonly pointData = (): PointSnapData => ({
        dimension: Dimensions.D1D2D3,
        plane: () => this.picked!.worldFrame,
        validator: this.pointOnFace,
        preview: this.previewPoints,
        // a panel edit (diameter, depth, style…) redraws the holes at once
        onPreviewReady: (redraw) => {
            this.redrawPreview = redraw;
        },
        onKeyDown: (e) => {
            this.isConfirm = e.code === "Space" || e.code === "Enter";
        },
    });

    /**
     * A center counts where it lands on the face itself (a boundary tolerance included), or on
     * the axis of a round opening in it — the center of an existing hole, so a wider, shallower
     * hole can be drilled over it (a hand-made counterbore).
     */
    private readonly pointOnFace = (point: XYZ): boolean => {
        const picked = this.picked;
        if (picked === undefined) return false;
        const projected = picked.worldFrame.project(point);
        if (picked.worldFace.intersectLine(projected, picked.worldFrame.normal, 1e-6) !== undefined)
            return true;
        return this.isOpeningCenter(projected);
    };

    private isOpeningCenter(point: XYZ): boolean {
        return isOpeningCenterOf(this.picked!.worldFace, point);
    }

    /** Redraws the step's preview; set while the raw-center step is up. */
    private redrawPreview: (() => void) | undefined;

    private readonly onOptionChanged = () => {
        this.redrawPreview?.();
    };

    /** Whether the cursor's center would be accepted — the preview never fails the pick. */
    private previewable(point: XYZ): boolean {
        try {
            return this.pointOnFace(point);
        } catch {
            return false;
        }
    }

    /**
     * The hole solids at `centers` with the panel's current values, as wireframe meshes. A
     * value the hole cannot be built from (an empty field mid-typing) just shows no hole.
     */
    private holeMeshes(centers: readonly XYZ[]): ShapeMeshData[] {
        try {
            return this.buildHoleMeshes(centers);
        } catch {
            return [];
        }
    }

    private buildHoleMeshes(centers: readonly XYZ[]): ShapeMeshData[] {
        const picked = this.picked;
        const shape = picked?.body?.shape;
        if (picked === undefined || centers.length === 0 || shape === undefined || !shape.isOk) return [];
        const feature = this.feature(picked.ref, [], undefined);
        const tools = previewHoleTools(
            feature,
            this.document.variables.evaluate().scope,
            picked.worldFrame,
            shape.value,
            centers,
        );
        if (!tools.isOk) return [];
        return tools.value.map((tool) => this.meshShape(tool));
    }

    /**
     * Records the pick as a sketch-point binding and returns true when it snapped to one.
     * Re-picking an already bound entity is a no-op pick (true either way): the loop asks
     * again rather than stacking a second center on the same point.
     */
    private bindSketchPoint(data: SnapResult): boolean {
        if (data.point === undefined) return false;
        const snap = this.snapAt(data.view, data.point);
        if (snap === undefined) return false;
        if (!this.boundCenters.some((x) => x.entityId === snap.entityId)) this.boundCenters.push(snap);
        return true;
    }

    /** The sketch point a pick at `point` would bind to — screen-distance snap, pinned sketch. */
    private snapAt(view: IView, point: XYZ): SketchPointSnap | undefined {
        const picked = this.picked;
        if (picked === undefined) return undefined;
        const pixel = ViewUtils.viewPixelSize(view, point);
        if (pixel === undefined) return undefined;
        return findSketchPointAt(
            this.document,
            picked.worldFrame,
            point,
            pixel * Config.instance.SnapDistance,
            this.boundCenters[0]?.sketchId,
        );
    }

    /** A bound center's marker: the sketch point's own cross, on the face where the hole lands. */
    private crossPoint(center: XYZ): EdgeMeshData {
        const view = this.document.application.activeView;
        const pixel = view === undefined ? undefined : ViewUtils.viewPixelSize(view, center);
        // No view to measure against collapses the cross onto the point — nothing to see then.
        const half = (pixel ?? 0) * (VisualConfig.editVertexSize / 2);
        return pointCrossMesh(
            this.picked!.worldFrame,
            holePointUV(this.picked!.worldFrame, center),
            half,
            VisualConfig.highlightEdgeColor,
        );
    }

    /**
     * The centers picked so far, plus the one under the cursor — dots for raw picks, crosses
     * for bound (or about-to-bind) sketch points, so the marker says which kind a click adds.
     */
    private readonly previewPoints = (point: XYZ | undefined): ShapeMeshData[] => {
        const points: ShapeMeshData[] = this.stepDatas.map((data) => this.meshPoint(data.point!));
        const centers: XYZ[] = this.stepDatas.map((data) => this.picked!.worldFrame.project(data.point!));
        for (const bound of this.boundCenters) {
            points.push(this.crossPoint(bound.center));
            centers.push(bound.center);
        }
        if (point !== undefined) {
            const snap =
                this.document.application.activeView === undefined
                    ? undefined
                    : this.snapAt(this.document.application.activeView!, point);
            points.push(snap === undefined ? this.meshPoint(point) : this.crossPoint(snap.center));
            const under = snap?.center ?? this.picked!.worldFrame.project(point);
            if (this.previewable(under)) centers.push(under);
        }
        // the holes themselves, as they will be cut, follow the cursor and the panel
        return [...points, ...this.holeMeshes(centers)];
    };

    protected override executeMainTask(): void {
        const picked = this.picked;
        if (picked === undefined || (this.stepDatas.length === 0 && this.boundCenters.length === 0)) {
            PubSub.default.pub("showToast", "error.default:{0}", "Pick at least one hole center");
            return;
        }
        if (!this.validateParams()) return;
        // (u, v) in the world frame equals (u, v) in the body-local frame — one is the other's
        // rigid transform, and the projection is equivariant under it.
        const points = this.stepDatas.map(
            (data) => holePointUV(picked.worldFrame, data.point!) as [number, number],
        );
        const sketchPoints = this.sketchPoints();
        Transaction.execute(this.document, "excute feature.hole", () => {
            picked.body.setFeaturesEmitShapeChanged([
                ...picked.body.features,
                this.feature(picked.ref, points, sketchPoints),
            ]);
            this.document.visual.update();
        });
    }

    /** The bound centers as the feature's one-sketch list; undefined when nothing was bound. */
    private sketchPoints(): HoleSketchPoints | undefined {
        if (this.boundCenters.length === 0) return undefined;
        return {
            sketchId: this.boundCenters[0].sketchId,
            entityIds: this.boundCenters.map((x) => x.entityId),
        };
    }

    /**
     * The options-panel values checked at commit time — a bad one toasts and aborts rather
     * than standing a feature up to fail its first rebuild. The feature re-checks all of this
     * on every rebuild; here is just where the user is still looking.
     */
    private validateParams(): boolean {
        const invalid = (label: string) => {
            PubSub.default.pub("showToast", "error.default:{0}", label);
            return false;
        };
        const diameter = this.resolveParameter(this.diameter, LENGTH_UNITS);
        if (!diameter.isOk || diameter.value <= 0) return invalid("Invalid hole diameter");
        if (this.depth !== "") {
            const depth = this.resolveParameter(this.depth, LENGTH_UNITS);
            if (!depth.isOk || depth.value <= 0) return invalid("Invalid hole depth");
        }
        const drillAngle = this.resolveParameter(this.drillAngle, ANGLE_UNITS);
        if (!drillAngle.isOk || drillAngle.value <= 0 || drillAngle.value >= 180) {
            return invalid("Invalid drill angle");
        }
        if (this.style === STYLE_COUNTERBORE) {
            const diameter2 = this.resolveParameter(this.counterboreDiameter, LENGTH_UNITS);
            const depth2 = this.resolveParameter(this.counterboreDepth, LENGTH_UNITS);
            if (!diameter2.isOk || diameter2.value <= 0 || !depth2.isOk || depth2.value <= 0) {
                return invalid("Invalid counterbore");
            }
        }
        if (this.style === STYLE_COUNTERSINK) {
            const diameter2 = this.resolveParameter(this.countersinkDiameter, LENGTH_UNITS);
            const angle2 = this.resolveParameter(this.countersinkAngle, ANGLE_UNITS);
            if (
                !diameter2.isOk ||
                diameter2.value <= 0 ||
                !angle2.isOk ||
                angle2.value <= 0 ||
                angle2.value >= 180
            ) {
                return invalid("Invalid countersink");
            }
        }
        return true;
    }

    private feature(
        face: PlaneFaceRef,
        points: [number, number][],
        sketchPoints: HoleSketchPoints | undefined,
    ): HoleFeatureData {
        const style: HoleFeatureData["style"] =
            this.style === STYLE_COUNTERBORE
                ? "counterbore"
                : this.style === STYLE_COUNTERSINK
                  ? "countersink"
                  : "simple";
        return {
            id: Id.generate(),
            type: "hole",
            face,
            points,
            ...(sketchPoints === undefined ? {} : { sketchPoints }),
            style,
            diameter: this.diameter,
            ...(this.depth === "" ? {} : { depth: this.depth }),
            drillAngle: this.drillAngle,
            ...(style === "counterbore"
                ? { counterbore: { diameter: this.counterboreDiameter, depth: this.counterboreDepth } }
                : {}),
            ...(style === "countersink"
                ? { countersink: { diameter: this.countersinkDiameter, angle: this.countersinkAngle } }
                : {}),
        };
    }
}
