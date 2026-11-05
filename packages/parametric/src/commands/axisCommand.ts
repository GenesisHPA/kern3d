// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    Combobox,
    command,
    type I18nKeys,
    type IDocument,
    type IShape,
    type IStep,
    LineOrCircleEdgeFilter,
    MeshDataUtils,
    MultistepCommand,
    PubSub,
    property,
    Result,
    type ShapeMeshData,
    type SnapResult,
    Transaction,
    type XYZLike,
} from "@chili3d/core";
import { type AxisDefinition, resolveAxisDefinition } from "../datum/axisDefinition";
import { AxisNode, DATUM_AXIS_COLOR } from "../datum/axisNode";
import type { DatumAxisValue } from "../datum/datumContract";
import { isRevolutionFace } from "../datum/surfaceGeometry";
import type { NeutralPlaneRef } from "../features/feature";
import { plainVec } from "../features/refGeometry";
import type { EdgeSourceRef, PointRef } from "../plane/planeDefinition";
import type { FaceSourceRef } from "../plane/sourceRefs";
import {
    ConstructionPreviewHandler,
    lineDirection,
    midpoint,
    PreviewErrorReporter,
    pickEdge,
    pickFace,
    pickNeutralPlane,
    pickPoint,
    pickPoints,
    recordPlaneAnchor,
} from "./constructionPicks";

const AXIS_TYPES = [
    "feature.axis.faceAxis",
    "feature.axis.edge",
    "feature.axis.twoPoints",
    "feature.axis.twoPlanes",
    "feature.axis.faceNormal",
    "feature.axis.pointPlane",
] as const satisfies readonly I18nKeys[];

type AxisTypeKey = (typeof AXIS_TYPES)[number];

const AXIS_TYPE_KINDS: Record<AxisTypeKey, AxisDefinition["kind"]> = {
    "feature.axis.faceAxis": "faceAxis",
    "feature.axis.edge": "edge",
    "feature.axis.twoPoints": "twoPoints",
    "feature.axis.twoPlanes": "twoPlanes",
    "feature.axis.faceNormal": "faceNormal",
    "feature.axis.pointPlane": "pointPlane",
};

const REVOLUTION_FACES = { allow: (shape: IShape) => isRevolutionFace(shape) };

/** Everything the picks collected; `buildDefinition` turns it into the stored definition. */
export interface CollectedAxisRefs {
    face?: FaceSourceRef;
    edge?: EdgeSourceRef;
    points?: [PointRef, PointRef];
    point?: PointRef;
    first?: NeutralPlaneRef;
    second?: NeutralPlaneRef;
    anchors: Record<string, number>;
    anchor?: XYZLike;
}

/**
 * Creates a construction axis (CONSTRUCT ▸ Axis): pick the geometry the type asks
 * for, check the dashed preview, confirm. The axis is a standalone `AxisNode` — see there.
 * Changing the type restarts the picks, as the plane command does.
 */
@command({ key: "feature.axis", icon: "icon-datumAxis" })
export class AxisCommand extends MultistepCommand {
    @property("feature.axis.type", { combobox: Combobox.from([...AXIS_TYPES]) })
    get axisType(): I18nKeys {
        return this.getPrivateValue("axisType", AXIS_TYPES[0]);
    }
    set axisType(value: I18nKeys) {
        if (!this.setProperty("axisType", value)) return;
        // See `PlaneCommand.planeType`: only a running step restarts.
        if (this.controller !== undefined) void this.restart();
    }

    @property("option.command.flip")
    get flip(): boolean {
        return this.getPrivateValue("flip", false);
    }
    set flip(value: boolean) {
        this.setProperty("flip", value, () => this._preview?.refresh());
    }

    private _refs: CollectedAxisRefs | undefined;
    private _preview: ConstructionPreviewHandler | undefined;
    private _result: AxisDefinition | undefined;
    private readonly _errors = new PreviewErrorReporter();

    get kind(): AxisDefinition["kind"] {
        return AXIS_TYPE_KINDS[this.axisType as AxisTypeKey] ?? "faceAxis";
    }

    protected override getSteps(): IStep[] {
        return [new PickAxisGeometryStep(this)];
    }

    protected override onRestarting(): void {
        super.onRestarting();
        this._refs = undefined;
        this._result = undefined;
    }

    setRefs(refs: CollectedAxisRefs): void {
        this._refs = refs;
        this._errors.clear();
    }

    setPreview(preview: ConstructionPreviewHandler | undefined): void {
        this._preview = preview;
    }

    buildDefinition(): Result<AxisDefinition> {
        const refs = this._refs;
        if (refs === undefined) return Result.err("Pick the axis geometry first");
        const base = { anchors: refs.anchors, anchor: refs.anchor, flip: this.flip };
        switch (this.kind) {
            case "faceAxis":
                return refs.face === undefined
                    ? Result.err("Pick a cylindrical face")
                    : Result.ok({ kind: "faceAxis", face: refs.face, ...base });
            case "edge":
                return refs.edge === undefined
                    ? Result.err("Pick an edge")
                    : Result.ok({
                          kind: "edge",
                          edge: refs.edge,
                          direction: lineDirection(refs.edge.edge),
                          ...base,
                      });
            case "twoPoints":
                return refs.points === undefined
                    ? Result.err("Pick two points")
                    : Result.ok({ kind: "twoPoints", points: refs.points, ...base });
            case "twoPlanes":
                return refs.first === undefined || refs.second === undefined
                    ? Result.err("Pick two planes")
                    : Result.ok({ kind: "twoPlanes", first: refs.first, second: refs.second, ...base });
            case "faceNormal":
                return refs.face === undefined || refs.point === undefined
                    ? Result.err("Pick a face and a point")
                    : Result.ok({ kind: "faceNormal", face: refs.face, point: refs.point, ...base });
            case "pointPlane":
                return refs.point === undefined || refs.first === undefined
                    ? Result.err("Pick a point and a plane")
                    : Result.ok({ kind: "pointPlane", point: refs.point, plane: refs.first, ...base });
        }
    }

    previewAxis(): DatumAxisValue | undefined {
        const definition = this.buildDefinition();
        if (!definition.isOk) return this._errors.report(definition.error);
        const axis = resolveAxisDefinition(definition.value, this.document);
        if (!axis.isOk) return this._errors.report(axis.error);
        return axis.value;
    }

    previewMeshes(): ShapeMeshData[] | undefined {
        const axis = this.previewAxis();
        if (axis === undefined) return undefined;
        return [MeshDataUtils.createEdgeMesh(axis.start, axis.end, DATUM_AXIS_COLOR, "dash")];
    }

    protected override executeMainTask(): void {
        const definition = this.buildDefinition();
        if (!definition.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", definition.error);
            return;
        }
        const axis = resolveAxisDefinition(definition.value, this.document);
        if (!axis.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", axis.error);
            return;
        }
        this._result = definition.value;
        Transaction.execute(this.document, "create axis", () => {
            const node = new AxisNode({ document: this.document, definition: definition.value });
            this.document.modelManager.addNode(node);
            this.document.selection.setSelectedNodes([node], false);
        });
    }

    /** The definition the command committed, for tests. */
    get result(): AxisDefinition | undefined {
        return this._result;
    }
}

class PickAxisGeometryStep implements IStep {
    constructor(private readonly command: AxisCommand) {}

    async execute(document: IDocument, controller: AsyncController): Promise<SnapResult | undefined> {
        const refs = await collectAxisRefs(this.command.kind, document, controller);
        if (refs === undefined || controller.result !== undefined) return undefined;
        this.command.setRefs(refs);
        return confirmPreview(document, controller, "prompt.confirmAxis", this.command);
    }
}

/**
 * The preview/confirm phase shared by the axis and point commands: the preview handler owns
 * the view until Enter/confirm (success) or Escape, and the step settles on success only.
 */
export async function confirmPreview(
    document: IDocument,
    controller: AsyncController,
    prompt: I18nKeys,
    owner: {
        previewMeshes(): ShapeMeshData[] | undefined;
        setPreview(preview: ConstructionPreviewHandler | undefined): void;
    },
): Promise<SnapResult | undefined> {
    const previewController = new AsyncController();
    controller.onCancelled(() => previewController.cancel());
    const preview = new ConstructionPreviewHandler(document, previewController, () => owner.previewMeshes());
    owner.setPreview(preview);
    try {
        await document.picker.pickAsync(preview, prompt, previewController, "none", "select.default");
        if (previewController.result?.status !== "success") return undefined;
        if (owner.previewMeshes() === undefined) return undefined;
        controller.success();
        return { view: document.application.activeView!, shapes: [], type: "input" };
    } finally {
        owner.setPreview(undefined);
        preview.dispose();
        previewController.dispose();
    }
}

async function collectAxisRefs(
    kind: AxisDefinition["kind"],
    document: IDocument,
    controller: AsyncController,
): Promise<CollectedAxisRefs | undefined> {
    const anchors: Record<string, number> = {};
    const refs: CollectedAxisRefs = { anchors };
    switch (kind) {
        case "faceAxis": {
            const face = await pickFace(
                document,
                controller,
                "prompt.select.revolutionFace",
                REVOLUTION_FACES,
            );
            if (face === undefined) return undefined;
            Object.assign(anchors, face.anchors);
            return { ...refs, face: face.ref, anchor: plainVec(face.world) };
        }
        case "edge": {
            const edge = await pickEdge(
                document,
                controller,
                "prompt.select.axis",
                new LineOrCircleEdgeFilter(),
            );
            if (edge === undefined) return undefined;
            Object.assign(anchors, edge.anchors);
            return { ...refs, edge: edge.ref, anchor: edge.anchor };
        }
        case "twoPoints": {
            const picked = await pickPoints(document, 2, controller);
            if (picked === undefined) return undefined;
            Object.assign(anchors, picked.anchors);
            return { ...refs, points: [picked.points[0], picked.points[1]], anchor: picked.worlds[0] };
        }
        case "twoPlanes": {
            const first = await pickNeutralPlane(document, controller);
            if (first === undefined) return undefined;
            recordPlaneAnchor(document, first.ref, anchors);
            const second = await pickNeutralPlane(document, controller);
            if (second === undefined) return undefined;
            recordPlaneAnchor(document, second.ref, anchors);
            return {
                ...refs,
                first: first.ref,
                second: second.ref,
                anchor: midpoint(first.anchor, second.anchor),
            };
        }
        case "faceNormal": {
            const face = await pickFace(document, controller, "prompt.select.face");
            if (face === undefined) return undefined;
            Object.assign(anchors, face.anchors);
            const point = await pickPoint(document, controller);
            if (point === undefined) return undefined;
            Object.assign(anchors, point.anchors);
            return { ...refs, face: face.ref, point: point.ref, anchor: point.world };
        }
        case "pointPlane": {
            const point = await pickPoint(document, controller);
            if (point === undefined) return undefined;
            Object.assign(anchors, point.anchors);
            const plane = await pickNeutralPlane(document, controller);
            if (plane === undefined) return undefined;
            recordPlaneAnchor(document, plane.ref, anchors);
            return { ...refs, point: point.ref, first: plane.ref, anchor: point.world };
        }
    }
}
