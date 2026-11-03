// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    AsyncController,
    Combobox,
    command,
    type I18nKeys,
    type IDocument,
    type IShape,
    type IStep,
    LENGTH_UNITS,
    LineEdgeFilter,
    LineOrCircleEdgeFilter,
    MultistepCommand,
    type ParameterValue,
    type Plane,
    PubSub,
    property,
    Result,
    type SnapResult,
    Transaction,
    XYZ,
    type XYZLike,
} from "@chili3d/core";
import { isRevolutionFace } from "../datum/surfaceGeometry";
import type { EdgeRef } from "../features/edgeRef";
import type { NeutralPlaneRef } from "../features/feature";
import { plainVec } from "../features/refGeometry";
import {
    type EdgeSourceRef,
    type PlaneDefinition,
    type PointRef,
    resolvePlaneDefinition,
} from "../plane/planeDefinition";
import { ensurePlaneMaterial, PlaneNode } from "../plane/planeNode";
import type { FaceSourceRef } from "../plane/sourceRefs";
import { datumQuadAt } from "../sketch/commands/planePreview";
import {
    centroid,
    lineDirection,
    midpoint,
    pickEdge,
    pickFace,
    pickNeutralPlane,
    pickPoint,
    pickPoints,
    recordPlaneAnchor,
} from "./constructionPicks";
import { type DragPreview, PreviewConfirmHandler } from "./previewConfirmHandler";

/** Admits the faces a tangent plane can touch: any face with an axis of revolution. */
export const REVOLUTION_FACE_FILTER = { allow: (shape: IShape) => isRevolutionFace(shape) };

const PLANE_TYPES = [
    "feature.plane.offset",
    "feature.plane.planePoint",
    "feature.plane.lineAngle",
    "feature.plane.pointNormal",
    "feature.plane.threePoint",
    "feature.plane.midPlane",
    "feature.plane.curvePoint",
    "feature.plane.tangent",
] as const satisfies readonly I18nKeys[];

type PlaneTypeKey = (typeof PLANE_TYPES)[number];

const PLANE_TYPE_KINDS: Record<PlaneTypeKey, PlaneDefinition["kind"]> = {
    "feature.plane.offset": "offset",
    "feature.plane.planePoint": "planePoint",
    "feature.plane.lineAngle": "lineAngle",
    "feature.plane.pointNormal": "pointNormal",
    "feature.plane.threePoint": "threePoint",
    "feature.plane.midPlane": "midPlane",
    "feature.plane.curvePoint": "curvePoint",
    "feature.plane.tangent": "tangent",
};

const PREVIEW_QUAD_SIZE = 200;

/** Everything the step collected; `buildDefinition` turns it into the stored definition. */
interface CollectedPlaneRefs {
    source?: NeutralPlaneRef;
    reference?: NeutralPlaneRef;
    second?: NeutralPlaneRef;
    point?: PointRef;
    points?: [PointRef, PointRef, PointRef];
    edge?: EdgeSourceRef;
    curve?: EdgeSourceRef;
    face?: FaceSourceRef;
    /** The tangent plane's pick point on the face, in the face source's LOCAL frame. */
    at?: XYZLike;
    anchors: Record<string, number>;
    /** A world point of the resulting plane near the source geometry, for the display square. */
    anchor?: XYZLike;
}

/**
 * Creates a datum plane (Onshape's Plane): pick the construction geometry, adjust its
 * parameters in the floating panel while a translucent quad shows the result, then confirm.
 *
 * The plane is a standalone node rather than a body feature — see `PlaneNode`. Each type
 * has its own pick sequence; changing the type mid-run restarts the command so the new
 * sequence starts cleanly.
 */
@command({ key: "feature.plane", icon: "icon-setWorkingPlane" })
export class PlaneCommand extends MultistepCommand {
    @property("feature.plane.type", { combobox: Combobox.from([...PLANE_TYPES]) })
    get planeType(): I18nKeys {
        return this.getPrivateValue("planeType", PLANE_TYPES[0]);
    }
    set planeType(value: I18nKeys) {
        if (!this.setProperty("planeType", value)) return;
        // The pick sequence is type-specific; restart rather than continue with stale picks.
        // Only while a step owns a controller: restoring a cached value in `beforeExecute`
        // happens before the run starts, and restarting there would commit twice.
        if (this.controller !== undefined) void this.restart();
    }

    @property("option.command.distance", {
        unit: LENGTH_UNITS,
        dependencies: [{ property: "planeType", value: "feature.plane.offset" }],
    })
    get distance(): ParameterValue {
        return this.getPrivateValue("distance", 10);
    }
    set distance(value: ParameterValue) {
        this.setProperty("distance", value, () => this._preview?.refresh());
    }

    @property("option.command.oppositeDirection", {
        dependencies: [{ property: "planeType", value: "feature.plane.offset" }],
    })
    get reverse(): boolean {
        return this.getPrivateValue("reverse", false);
    }
    set reverse(value: boolean) {
        this.setProperty("reverse", value, () => this._preview?.refresh());
    }

    @property("common.angle", {
        unit: ANGLE_UNITS,
        dependencies: [{ property: "planeType", value: "feature.plane.lineAngle" }],
    })
    get angle(): ParameterValue {
        return this.getPrivateValue("angle", 30);
    }
    set angle(value: ParameterValue) {
        this.setProperty("angle", value, () => this._preview?.refresh());
    }

    /** The tangent plane's rotation about the face's axis, from the picked line of contact. */
    @property("common.angle", {
        unit: ANGLE_UNITS,
        dependencies: [{ property: "planeType", value: "feature.plane.tangent" }],
    })
    get tangentAngle(): ParameterValue {
        return this.getPrivateValue("tangentAngle", 0);
    }
    set tangentAngle(value: ParameterValue) {
        this.setProperty("tangentAngle", value, () => this._preview?.refresh());
    }

    @property("option.command.flip")
    get flip(): boolean {
        return this.getPrivateValue("flip", false);
    }
    set flip(value: boolean) {
        this.setProperty("flip", value, () => this._preview?.refresh());
    }

    private _refs: CollectedPlaneRefs | undefined;
    private _preview: PlanePreviewHandler | undefined;
    private _result: PlaneDefinition | undefined;
    /** The captured curve tangent is fixed for one pick; previews must not re-query the kernel. */
    private _tangentMemo: { curve: EdgeSourceRef; point: PointRef; value?: XYZLike } | undefined;
    /** The last preview error announced, so a failing preview toasts once, not per refresh. */
    private _lastPreviewError: string | undefined;

    /** The definition kind the picked refs must satisfy right now. */
    get kind(): PlaneDefinition["kind"] {
        return PLANE_TYPE_KINDS[this.planeType as PlaneTypeKey] ?? "offset";
    }

    protected override getSteps(): IStep[] {
        return [new PickPlaneGeometryStep(this)];
    }

    protected override onRestarting(): void {
        super.onRestarting();
        this._refs = undefined;
        this._result = undefined;
        this._tangentMemo = undefined;
    }

    /** Called by the step once every reference is in hand. */
    setRefs(refs: CollectedPlaneRefs): void {
        this._refs = refs;
        this._tangentMemo = undefined;
        this._lastPreviewError = undefined;
    }

    setPreview(preview: PlanePreviewHandler | undefined): void {
        this._preview = preview;
    }

    /** The definition from the current panel values and collected refs, or an error message. */
    buildDefinition(): Result<PlaneDefinition> {
        const refs = this._refs;
        if (refs === undefined) return Result.err("Pick the plane geometry first");
        const anchors = refs.anchors;
        switch (this.kind) {
            case "offset": {
                if (refs.source === undefined) return Result.err("Pick a plane");
                const rawDistance = this.distance;
                if (rawDistance === undefined) return Result.err("Plane distance is not set");
                const distance = this.resolveParameter(rawDistance, LENGTH_UNITS);
                if (!distance.isOk) return Result.err(distance.error);
                return Result.ok({
                    kind: "offset",
                    source: refs.source,
                    distance: distance.value,
                    reverse: this.reverse,
                    flip: this.flip,
                    anchor: refs.anchor,
                    anchors,
                });
            }
            case "planePoint": {
                if (refs.source === undefined || refs.point === undefined) {
                    return Result.err("Pick a plane and a point");
                }
                return Result.ok({
                    kind: "planePoint",
                    source: refs.source,
                    point: refs.point,
                    flip: this.flip,
                    anchor: refs.anchor,
                    anchors,
                });
            }
            case "lineAngle": {
                if (refs.edge === undefined || refs.reference === undefined) {
                    return Result.err("Pick a line and a reference plane");
                }
                const rawAngle = this.angle;
                if (rawAngle === undefined) return Result.err("Plane angle is not set");
                const angle = this.resolveParameter(rawAngle, ANGLE_UNITS);
                if (!angle.isOk) return Result.err(angle.error);
                return Result.ok({
                    kind: "lineAngle",
                    line: refs.edge,
                    reference: refs.reference,
                    angle: angle.value,
                    direction: lineDirection(refs.edge.edge),
                    flip: this.flip,
                    anchor: refs.anchor,
                    anchors,
                });
            }
            case "pointNormal": {
                if (refs.edge === undefined || refs.point === undefined) {
                    return Result.err("Pick an axis and a point");
                }
                return Result.ok({
                    kind: "pointNormal",
                    axis: refs.edge,
                    point: refs.point,
                    direction: axisDirection(refs.edge.edge),
                    flip: this.flip,
                    anchor: refs.anchor,
                    anchors,
                });
            }
            case "threePoint": {
                if (refs.points === undefined) return Result.err("Pick three points");
                return Result.ok({
                    kind: "threePoint",
                    points: refs.points,
                    flip: this.flip,
                    anchor: refs.anchor,
                    anchors,
                });
            }
            case "midPlane": {
                if (refs.source === undefined || refs.second === undefined) {
                    return Result.err("Pick two planes");
                }
                return Result.ok({
                    kind: "midPlane",
                    first: refs.source,
                    second: refs.second,
                    flip: this.flip,
                    anchor: refs.anchor,
                    anchors,
                });
            }
            case "curvePoint": {
                if (refs.curve === undefined || refs.point === undefined) {
                    return Result.err("Pick a curve and a point");
                }
                return Result.ok({
                    kind: "curvePoint",
                    curve: refs.curve,
                    point: refs.point,
                    tangent: this.capturedCurveTangent(refs.curve, refs.point, anchors),
                    flip: this.flip,
                    anchor: refs.anchor,
                    anchors,
                });
            }
            case "tangent": {
                if (refs.face === undefined || refs.at === undefined)
                    return Result.err("Pick a cylindrical face");
                const angle = this.resolveParameter(this.tangentAngle, ANGLE_UNITS);
                if (!angle.isOk) return Result.err(angle.error);
                return Result.ok({
                    kind: "tangent",
                    face: refs.face,
                    at: refs.at,
                    angle: angle.value,
                    flip: this.flip,
                    anchor: refs.anchor,
                    anchors,
                });
            }
        }
    }

    previewPlane() {
        const definition = this.buildDefinition();
        if (!definition.isOk) return this.reportPreviewError(definition.error);
        const plane = resolvePlaneDefinition(definition.value, this.document);
        if (!plane.isOk) return this.reportPreviewError(plane.error);
        this._lastPreviewError = undefined;
        return plane.value;
    }

    /** A preview that cannot resolve must say why; otherwise the OK button silently dies. */
    private reportPreviewError(error: string): undefined {
        if (this._lastPreviewError !== error) {
            this._lastPreviewError = error;
            PubSub.default.pub("showToast", "error.default:{0}", error);
        }
        return undefined;
    }

    /** The preview square's frame and where it is drawn (the anchor, like the committed node). */
    previewFrame(): { plane: Plane; center: XYZ } | undefined {
        const plane = this.previewPlane();
        if (plane === undefined) return undefined;
        const anchor = this._refs?.anchor;
        return {
            plane,
            center: anchor === undefined ? plane.origin : plane.project(new XYZ(anchor)),
        };
    }

    /** The tangent at creation time, for sign-stable rebuilds of a `curvePoint` plane. */
    private capturedCurveTangent(
        curve: EdgeSourceRef,
        point: PointRef,
        anchors: Record<string, number>,
    ): XYZLike | undefined {
        const memo = this._tangentMemo;
        if (memo?.curve === curve && memo.point === point) return memo.value;
        const plane = resolvePlaneDefinition({ kind: "curvePoint", curve, point, anchors }, this.document);
        const value = plane.isOk
            ? { x: plane.value.normal.x, y: plane.value.normal.y, z: plane.value.normal.z }
            : undefined;
        this._tangentMemo = { curve, point, value };
        return value;
    }

    protected override executeMainTask(): void {
        const definition = this.buildDefinition();
        if (!definition.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", definition.error);
            return;
        }
        const plane = resolvePlaneDefinition(definition.value, this.document);
        if (!plane.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", plane.error);
            return;
        }
        this._result = definition.value;
        Transaction.execute(this.document, "create plane", () => {
            const material = ensurePlaneMaterial(this.document);
            const node = new PlaneNode({
                document: this.document,
                definition: definition.value,
                plane: plane.value,
                materialId: material.id,
            });
            this.document.modelManager.addNode(node);
            this.document.selection.setSelectedNodes([node], false);
        });
    }

    /** The definition the command committed, for tests. */
    get result(): PlaneDefinition | undefined {
        return this._result;
    }
}

/** Collects the refs the current type needs, then shows the preview/confirm phase. */
class PickPlaneGeometryStep implements IStep {
    constructor(private readonly command: PlaneCommand) {}

    async execute(document: IDocument, controller: AsyncController): Promise<SnapResult | undefined> {
        // Every pick gets its OWN controller: the selection handler settles the controller
        // it was given, so reusing the step's would make every later pick return instantly
        // (and the preview unreachable). The step controller is settled only on confirm.
        const refs = await collectRefs(this.command.kind, document, controller);
        if (refs === undefined) return undefined;
        // A restart/panel cancel may have landed between the last pick and here.
        if (controller.result !== undefined) return undefined;
        this.command.setRefs(refs);

        const previewController = new AsyncController();
        // Bridge the command's cancel/restart to the pick round (there is no `off()`; the
        // round is settled right after, so a late replay is harmless).
        controller.onCancelled(() => previewController.cancel());
        const preview = new PlanePreviewHandler(document, previewController, () =>
            this.command.previewFrame(),
        );
        this.command.setPreview(preview);
        try {
            // `pickAsync` installs the preview as the view event handler, which is what
            // gives it Enter/Space/Escape; its own `start()` already published the bar.
            await document.picker.pickAsync(
                preview,
                "prompt.confirmPlane",
                previewController,
                "none",
                "select.default",
            );
            if (previewController.result?.status !== "success") return undefined;
            const plane = this.command.previewPlane();
            if (plane === undefined) return undefined;
            controller.success();
            return {
                view: document.application.activeView!,
                shapes: [],
                type: "input",
                plane,
            };
        } finally {
            this.command.setPreview(undefined);
            preview.dispose();
            previewController.dispose();
        }
    }
}

/** The translucent result quad, refreshed as the panel's distance/angle/flip change. */
class PlanePreviewHandler extends PreviewConfirmHandler {
    constructor(
        document: IDocument,
        controller: AsyncController,
        private readonly frame: () => { plane: Plane; center: XYZ } | undefined,
    ) {
        super(document, controller);
        this.start();
    }

    protected override buildPreview(): DragPreview {
        const frame = this.frame();
        return frame === undefined
            ? { meshes: [] }
            : { meshes: [datumQuadAt(frame.plane, frame.center, PREVIEW_QUAD_SIZE)] };
    }

    protected override canConfirm(): boolean {
        return this.frame() !== undefined;
    }

    protected override previewOpacity(): number {
        return 0.35;
    }

    protected override previewOnTop(): boolean {
        return true;
    }
}

async function collectRefs(
    kind: PlaneDefinition["kind"],
    document: IDocument,
    stepController: AsyncController,
): Promise<CollectedPlaneRefs | undefined> {
    const anchors: Record<string, number> = {};
    const refs: CollectedPlaneRefs = { anchors };
    switch (kind) {
        case "offset": {
            const source = await pickNeutralPlane(document, stepController);
            if (source === undefined) return undefined;
            refs.source = source.ref;
            refs.anchor = source.anchor;
            recordPlaneAnchor(document, source.ref, anchors);
            return refs;
        }
        case "planePoint": {
            const source = await pickNeutralPlane(document, stepController);
            if (source === undefined) return undefined;
            refs.source = source.ref;
            recordPlaneAnchor(document, source.ref, anchors);
            const point = await pickPoint(document, stepController);
            if (point === undefined) return undefined;
            refs.point = point.ref;
            refs.anchor = point.world;
            Object.assign(anchors, point.anchors);
            return refs;
        }
        case "lineAngle": {
            const line = await pickEdge(
                document,
                stepController,
                "prompt.select.lineEdge",
                new LineEdgeFilter(),
            );
            if (line === undefined) return undefined;
            refs.edge = line.ref;
            refs.anchor = line.anchor;
            Object.assign(anchors, line.anchors);
            const reference = await pickNeutralPlane(document, stepController);
            if (reference === undefined) return undefined;
            refs.reference = reference.ref;
            recordPlaneAnchor(document, reference.ref, anchors);
            return refs;
        }
        case "pointNormal": {
            const axis = await pickEdge(
                document,
                stepController,
                "prompt.select.axis",
                new LineOrCircleEdgeFilter(),
            );
            if (axis === undefined) return undefined;
            refs.edge = axis.ref;
            Object.assign(anchors, axis.anchors);
            const point = await pickPoint(document, stepController);
            if (point === undefined) return undefined;
            refs.point = point.ref;
            refs.anchor = point.world;
            Object.assign(anchors, point.anchors);
            return refs;
        }
        case "threePoint": {
            const picked = await pickPoints(document, 3, stepController);
            if (picked === undefined) return undefined;
            refs.points = [picked.points[0], picked.points[1], picked.points[2]];
            refs.anchor = centroid(picked.worlds);
            Object.assign(anchors, picked.anchors);
            return refs;
        }
        case "midPlane": {
            const first = await pickNeutralPlane(document, stepController);
            if (first === undefined) return undefined;
            refs.source = first.ref;
            recordPlaneAnchor(document, first.ref, anchors);
            const firstAnchor = first.anchor;
            const second = await pickNeutralPlane(document, stepController);
            if (second === undefined) return undefined;
            refs.second = second.ref;
            refs.anchor = midpoint(firstAnchor, second.anchor);
            recordPlaneAnchor(document, second.ref, anchors);
            return refs;
        }
        case "curvePoint": {
            const curve = await pickEdge(document, stepController, "prompt.select.curve");
            if (curve === undefined) return undefined;
            refs.curve = curve.ref;
            refs.anchor = curve.anchor;
            Object.assign(anchors, curve.anchors);
            const point = await pickPoint(document, stepController);
            if (point === undefined) return undefined;
            refs.point = point.ref;
            refs.anchor = point.world;
            Object.assign(anchors, point.anchors);
            return refs;
        }
        case "tangent": {
            const face = await pickFace(
                document,
                stepController,
                "prompt.select.revolutionFace",
                REVOLUTION_FACE_FILTER,
            );
            if (face === undefined) return undefined;
            refs.face = face.ref;
            refs.at = plainVec(face.local);
            refs.anchor = plainVec(face.world);
            Object.assign(anchors, face.anchors);
            return refs;
        }
    }
}

/** The axis a `pointNormal` plane captured: a straight edge's direction or a circle's axis. */
function axisDirection(edge: EdgeRef): XYZLike | undefined {
    if (edge.kind === "circle") return edge.axis;
    return lineDirection(edge);
}
