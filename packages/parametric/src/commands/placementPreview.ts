// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Annotation,
    AsyncController,
    BoundingBox,
    cloneForCopyNode,
    type EdgeMeshData,
    type FaceMeshData,
    GeometryNode,
    type I18nKeys,
    type IDocument,
    type INode,
    isConsumedTool,
    isReferenceGeometryNode,
    type Matrix4,
    PubSub,
    type ShapeMeshData,
    type SnapResult,
    VisualConfig,
    type VisualNode,
} from "@chili3d/core";
import { type DragPreview, PreviewConfirmHandler } from "./previewConfirmHandler";

/**
 * Whether a node can be repositioned by a placement command — the same gate as Move: reference
 * geometry and inputs (datum planes, sketches) are defined in world space, and a consumed
 * boolean tool is placed by the body that owns it.
 */
export function isPlaceableNode(node: INode): boolean {
    const visual = node as Partial<VisualNode>;
    return (
        !isReferenceGeometryNode(node) &&
        visual.transformMode !== undefined &&
        visual.transformMode !== "none" &&
        !isConsumedTool(node)
    );
}

/**
 * Moves (or copies) `models` by the world-space `transform`, the way Move commits: a copy
 * goes in right after its original; a move goes through the node's `applyTransform` hook,
 * which a parametric body records as a `transform` feature. Call inside a transaction.
 */
export function applyPlacement(models: readonly VisualNode[], transform: Matrix4, isClone: boolean): void {
    for (const node of models) {
        if (isClone) {
            node.parent?.insertAfter(node, cloneForCopyNode(node, transform));
            continue;
        }
        // An explicit move wins over a derived measurement (see TransformedCommand).
        if (node instanceof Annotation) node.detachAssociation();
        const apply = (node as { applyTransform?: (matrix: Matrix4) => boolean }).applyTransform;
        if (apply === undefined) {
            node.transform = node.transform.multiply(transform);
        } else if (apply.call(node, transform) === false) {
            PubSub.default.pub("showToast", "toast.node.transformRefused");
        }
    }
}

/** The bounding box of `models` in the frame their transforms place them in. */
export function placementBoundingBox(models: readonly VisualNode[]): BoundingBox | undefined {
    let box: BoundingBox | undefined;
    for (const model of models) {
        const next = model.boundingBox();
        if (next === undefined) continue;
        box = box === undefined ? next : BoundingBox.combine(box, next);
    }
    return box;
}

/** The faces and edges of `models` carried by `transform`, as preview meshes. */
export function placementMeshes(models: readonly VisualNode[], transform: Matrix4): ShapeMeshData[] {
    const meshes: ShapeMeshData[] = [];
    for (const model of models) {
        if (!(model instanceof GeometryNode)) {
            const box = model.boundingBox();
            if (box !== undefined) meshes.push(edgeMesh(BoundingBox.wireframe(box).position, transform));
            continue;
        }
        const placement = model.transform.multiply(transform);
        const { faces, edges } = model.mesh;
        if (faces !== undefined && faces.position.length > 0) meshes.push(faceMesh(faces, placement));
        if (edges !== undefined && edges.position.length > 0)
            meshes.push(edgeMesh(edges.position, placement));
    }
    return meshes;
}

function faceMesh(faces: FaceMeshData, transform: Matrix4): FaceMeshData {
    return {
        position: new Float32Array(transform.ofPoints(faces.position)),
        normal: new Float32Array(transform.ofVectors(faces.normal)),
        index: faces.index,
        uv: faces.uv,
        groups: [],
        range: [],
        color: VisualConfig.highlightFaceColor,
    };
}

function edgeMesh(position: ArrayLike<number>, transform: Matrix4): EdgeMeshData {
    return {
        position: new Float32Array(transform.ofPoints(position)),
        lineType: "solid",
        color: VisualConfig.temporaryEdgeColor,
        range: [],
    };
}

/** Where a placement command's preview comes from: the move so far, or undefined while it cannot be built. */
export interface PlacementSource {
    readonly models: readonly VisualNode[];
    transform(): Matrix4 | undefined;
    readonly isClone: boolean;
}

/**
 * The moved part drawn where it will land, until confirmed. A move hides the original (the
 * preview stands in for it); a copy keeps it, since both will exist.
 */
export class PlacementPreviewHandler extends PreviewConfirmHandler {
    constructor(
        document: IDocument,
        controller: AsyncController,
        private readonly source: PlacementSource,
    ) {
        super(document, controller);
        this.start();
    }

    protected override buildPreview(): DragPreview {
        const transform = this.source.transform();
        if (transform === undefined) return { meshes: [] };
        return {
            meshes: placementMeshes(this.source.models, transform),
            hide: this.source.isClone ? [] : [...this.source.models],
        };
    }

    protected override canConfirm(): boolean {
        return this.source.transform() !== undefined;
    }

    protected override previewOpacity(): number {
        return 0.6;
    }
}

/**
 * Runs the preview/confirm phase of a placement command on `stepController`: the preview
 * gets its own controller (a selection handler settles the one it is given), bridged to
 * the step's cancel. Resolves to the step result on confirm, undefined otherwise.
 */
export async function confirmPlacement(
    document: IDocument,
    stepController: AsyncController,
    source: PlacementSource,
    prompt: I18nKeys,
    onPreview: (preview: PlacementPreviewHandler | undefined) => void,
): Promise<SnapResult | undefined> {
    const controller = new AsyncController();
    stepController.onCancelled(() => controller.cancel());
    const preview = new PlacementPreviewHandler(document, controller, source);
    onPreview(preview);
    try {
        await document.picker.pickAsync(preview, prompt, controller, "none", "select.default");
        if (controller.result?.status !== "success" || source.transform() === undefined) return undefined;
        stepController.success();
        return { view: document.application.activeView!, shapes: [], type: "input" };
    } finally {
        onPreview(undefined);
        preview.dispose();
        controller.dispose();
    }
}
