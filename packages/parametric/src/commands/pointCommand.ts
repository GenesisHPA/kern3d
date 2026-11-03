// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    Combobox,
    CurveUtils,
    command,
    type I18nKeys,
    type IDocument,
    type IEdge,
    type IFace,
    type IShape,
    type IStep,
    isReferenceGeometryNode,
    MeshDataUtils,
    MultistepCommand,
    type ParameterValue,
    PubSub,
    property,
    Result,
    type ShapeMeshData,
    type ShapeType,
    ShapeTypes,
    type SnapResult,
    Transaction,
    UNITLESS,
    type XYZ,
    type XYZLike,
} from "@chili3d/core";
import { DATUM_POINT_COLOR, DatumPointNode } from "../datum/datumPointNode";
import { type PointDefinition, resolvePointDefinition } from "../datum/pointDefinition";
import { revolutionAxisOfFace } from "../datum/surfaceGeometry";
import { captureEdgeRef } from "../features/edgeRef";
import type { NeutralPlaneRef } from "../features/feature";
import { plainVec } from "../features/refGeometry";
import { ParametricBodyNode } from "../parametricBodyNode";
import type { EdgeSourceRef, PointRef } from "../plane/planeDefinition";
import { captureFaceSource, type FaceSourceRef } from "../plane/sourceRefs";
import { confirmPreview } from "./axisCommand";
import {
    type ConstructionPreviewHandler,
    PreviewErrorReporter,
    pickEdge,
    pickNeutralPlane,
    pickPoint,
    pickShapes,
    recordAnchor,
    recordPlaneAnchor,
} from "./constructionPicks";

const POINT_TYPES = [
    "feature.point.vertex",
    "feature.point.center",
    "feature.point.edgePlane",
    "feature.point.threePlanes",
    "feature.point.onEdge",
] as const satisfies readonly I18nKeys[];

type PointTypeKey = (typeof POINT_TYPES)[number];

const POINT_TYPE_KINDS: Record<PointTypeKey, PointDefinition["kind"]> = {
    "feature.point.vertex": "vertex",
    "feature.point.center": "center",
    "feature.point.edgePlane": "edgePlane",
    "feature.point.threePlanes": "threePlanes",
    "feature.point.onEdge": "onEdge",
};

const PREVIEW_POINT_SIZE = 10;

/** A circular/elliptical edge or a spherical/toroidal face — what a centre point is taken from. */
const CENTER_SOURCES = {
    allow: (shape: IShape) => {
        try {
            if (shape.shapeType === ShapeTypes.edge)
                return CurveUtils.isConic((shape as IEdge).curve.basisCurve);
            if (shape.shapeType !== ShapeTypes.face) return false;
            const axis = revolutionAxisOfFace(shape as IFace);
            return axis.isOk && (axis.value.kind === "sphere" || axis.value.kind === "torus");
        } catch {
            return false;
        }
    },
};

export interface CollectedPointRefs {
    point?: PointRef;
    edge?: EdgeSourceRef;
    face?: FaceSourceRef;
    planes?: NeutralPlaneRef[];
    /** The picked edge's start in its source's LOCAL frame (an on-edge ratio counts from it). */
    start?: XYZLike;
    anchors: Record<string, number>;
    anchor?: XYZLike;
}

/**
 * Creates a construction point (Fusion's CONSTRUCT ▸ Point): pick the geometry the type asks
 * for, check the preview dot, confirm. The point is a standalone `DatumPointNode`.
 */
@command({ key: "feature.point", icon: "icon-datumPoint" })
export class PointCommand extends MultistepCommand {
    @property("feature.point.type", { combobox: Combobox.from([...POINT_TYPES]) })
    get pointType(): I18nKeys {
        return this.getPrivateValue("pointType", POINT_TYPES[0]);
    }
    set pointType(value: I18nKeys) {
        if (!this.setProperty("pointType", value)) return;
        if (this.controller !== undefined) void this.restart();
    }

    @property("feature.point.ratio", {
        unit: UNITLESS,
        dependencies: [{ property: "pointType", value: "feature.point.onEdge" }],
    })
    get ratio(): ParameterValue {
        return this.getPrivateValue("ratio", 0.5);
    }
    set ratio(value: ParameterValue) {
        this.setProperty("ratio", value, () => this._preview?.refresh());
    }

    private _refs: CollectedPointRefs | undefined;
    private _preview: ConstructionPreviewHandler | undefined;
    private _result: PointDefinition | undefined;
    private readonly _errors = new PreviewErrorReporter();

    get kind(): PointDefinition["kind"] {
        return POINT_TYPE_KINDS[this.pointType as PointTypeKey] ?? "vertex";
    }

    protected override getSteps(): IStep[] {
        return [new PickPointGeometryStep(this)];
    }

    protected override onRestarting(): void {
        super.onRestarting();
        this._refs = undefined;
        this._result = undefined;
    }

    setRefs(refs: CollectedPointRefs): void {
        this._refs = refs;
        this._errors.clear();
    }

    setPreview(preview: ConstructionPreviewHandler | undefined): void {
        this._preview = preview;
    }

    buildDefinition(): Result<PointDefinition> {
        const refs = this._refs;
        if (refs === undefined) return Result.err("Pick the point geometry first");
        const base = { anchors: refs.anchors, anchor: refs.anchor };
        switch (this.kind) {
            case "vertex":
                return refs.point === undefined
                    ? Result.err("Pick a vertex")
                    : Result.ok({ kind: "vertex", point: refs.point, ...base });
            case "center":
                return refs.edge === undefined && refs.face === undefined
                    ? Result.err("Pick a circular edge or a spherical face")
                    : Result.ok({ kind: "center", edge: refs.edge, face: refs.face, ...base });
            case "edgePlane":
                return refs.edge === undefined || refs.planes?.[0] === undefined
                    ? Result.err("Pick an edge and a plane")
                    : Result.ok({ kind: "edgePlane", edge: refs.edge, plane: refs.planes[0], ...base });
            case "threePlanes": {
                const planes = refs.planes;
                if (planes === undefined || planes.length < 3) return Result.err("Pick three planes");
                return Result.ok({ kind: "threePlanes", planes: [planes[0], planes[1], planes[2]], ...base });
            }
            case "onEdge": {
                if (refs.edge === undefined) return Result.err("Pick an edge");
                const ratio = this.resolveParameter(this.ratio, UNITLESS);
                if (!ratio.isOk) return Result.err(ratio.error);
                return Result.ok({
                    kind: "onEdge",
                    edge: refs.edge,
                    ratio: ratio.value,
                    start: refs.start,
                    ...base,
                });
            }
        }
    }

    previewPoint(): XYZ | undefined {
        const definition = this.buildDefinition();
        if (!definition.isOk) return this._errors.report(definition.error);
        const point = resolvePointDefinition(definition.value, this.document);
        if (!point.isOk) return this._errors.report(point.error);
        return point.value;
    }

    previewMeshes(): ShapeMeshData[] | undefined {
        const point = this.previewPoint();
        if (point === undefined) return undefined;
        return [MeshDataUtils.createVertexMesh(point, PREVIEW_POINT_SIZE, DATUM_POINT_COLOR)];
    }

    protected override executeMainTask(): void {
        const definition = this.buildDefinition();
        if (!definition.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", definition.error);
            return;
        }
        const point = resolvePointDefinition(definition.value, this.document);
        if (!point.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", point.error);
            return;
        }
        this._result = definition.value;
        Transaction.execute(this.document, "create point", () => {
            const node = new DatumPointNode({ document: this.document, definition: definition.value });
            this.document.modelManager.addNode(node);
            this.document.selection.setSelectedNodes([node], false);
        });
    }

    /** The definition the command committed, for tests. */
    get result(): PointDefinition | undefined {
        return this._result;
    }
}

class PickPointGeometryStep implements IStep {
    constructor(private readonly command: PointCommand) {}

    async execute(document: IDocument, controller: AsyncController): Promise<SnapResult | undefined> {
        const refs = await collectPointRefs(this.command.kind, document, controller);
        if (refs === undefined || controller.result !== undefined) return undefined;
        this.command.setRefs(refs);
        return confirmPreview(document, controller, "prompt.confirmPoint", this.command);
    }
}

async function collectPointRefs(
    kind: PointDefinition["kind"],
    document: IDocument,
    controller: AsyncController,
): Promise<CollectedPointRefs | undefined> {
    const anchors: Record<string, number> = {};
    switch (kind) {
        case "vertex": {
            const point = await pickPoint(document, controller);
            if (point === undefined) return undefined;
            return { anchors: point.anchors, point: point.ref, anchor: point.world };
        }
        case "center":
            return pickCenterSource(document, controller);
        case "edgePlane": {
            const edge = await pickEdge(document, controller, "prompt.select.curve");
            if (edge === undefined) return undefined;
            Object.assign(anchors, edge.anchors);
            const plane = await pickNeutralPlane(document, controller);
            if (plane === undefined) return undefined;
            recordPlaneAnchor(document, plane.ref, anchors);
            return { anchors, edge: edge.ref, planes: [plane.ref], anchor: plane.anchor };
        }
        case "threePlanes": {
            const planes: NeutralPlaneRef[] = [];
            for (let i = 0; i < 3; i++) {
                const plane = await pickNeutralPlane(document, controller);
                if (plane === undefined) return undefined;
                recordPlaneAnchor(document, plane.ref, anchors);
                planes.push(plane.ref);
            }
            return { anchors, planes };
        }
        case "onEdge": {
            const edge = await pickEdge(document, controller, "prompt.select.curve");
            if (edge === undefined) return undefined;
            return { anchors: edge.anchors, edge: edge.ref, start: edge.localStart, anchor: edge.anchor };
        }
    }
}

/** One pick that takes either a conic edge or a sphere/torus face. */
async function pickCenterSource(
    document: IDocument,
    controller: AsyncController,
): Promise<CollectedPointRefs | undefined> {
    const picked = await pickShapes(document, controller, "prompt.select.centerSource", {
        shapeType: (ShapeTypes.edge | ShapeTypes.face) as ShapeType,
        shapeFilter: CENTER_SOURCES,
        nodeFilter: { allow: (node) => !isReferenceGeometryNode(node) },
    });
    const data = picked?.[0];
    if (data === undefined) return undefined;
    const node = data.owner.node;
    const anchors: Record<string, number> = {};
    recordAnchor(node, anchors);
    const anchor = data.point === undefined ? undefined : plainVec(data.point);
    if (data.shape.shapeType === ShapeTypes.face) {
        const faceId = node instanceof ParametricBodyNode ? node.faceIdAt(data.indexes[0]) : undefined;
        return {
            anchors,
            anchor,
            face: { nodeId: node.id, face: captureFaceSource(data.shape as IFace, faceId) },
        };
    }
    const edgeId = node instanceof ParametricBodyNode ? node.edgeIdAt(data.indexes[0]) : undefined;
    return { anchors, anchor, edge: { nodeId: node.id, edge: captureEdgeRef(data.shape as IEdge, edgeId) } };
}
