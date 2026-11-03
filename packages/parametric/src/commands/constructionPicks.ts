// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CurveUtils,
    type I18nKeys,
    type IDocument,
    type IEdge,
    type IFace,
    type INode,
    type IShape,
    type IShapeFilter,
    type IVertex,
    isReferenceGeometryNode,
    type PickShapeOptions,
    PubSub,
    type ShapeMeshData,
    ShapeNode,
    ShapeTypes,
    type VisualShapeData,
    XYZ,
    type XYZLike,
} from "@chili3d/core";
import { isDatumAxisNode, isDatumPointNode } from "../datum/datumContract";
import { captureEdgeRef, type EdgeRef, edgeMidPoint } from "../features/edgeRef";
import { type NeutralPlaneRef, planeRefNodeId } from "../features/feature";
import { plainVec } from "../features/refGeometry";
import { captureVertexRef } from "../features/vertexRef";
import { ParametricBodyNode } from "../parametricBodyNode";
import {
    captureVertexAnchors,
    type EdgeSourceRef,
    type PointRef,
    type VertexAnchor,
} from "../plane/planeDefinition";
import { captureFaceSource, type FaceSourceRef } from "../plane/sourceRefs";
import {
    captureNeutralPlane,
    type PickedNeutralPlane,
    PlanePickHandler,
} from "../sketch/commands/planePickHandler";
import { worldShape } from "./booleanPreview";
import { type DragPreview, PreviewConfirmHandler } from "./previewConfirmHandler";

/**
 * The picks the construction commands (plane, axis, point) share. Every reference is captured
 * in the source node's LOCAL frame, with the parametric source's timeline position recorded in
 * `anchors`, so the datum follows the source on rebuild without dragging along features added
 * after it. A datum point is offered wherever a vertex is, a datum axis wherever an edge is.
 */

export async function pickNeutralPlane(
    document: IDocument,
    stepController: AsyncController,
): Promise<PickedNeutralPlane | undefined> {
    const controller = new AsyncController();
    stepController.onCancelled(() => controller.cancel());
    document.selection.clearSelection();
    const handler = new PlanePickHandler(document, controller);
    try {
        await document.picker.pickAsync(handler, "prompt.select.plane", controller, "none", "select.default");
        return handler.result === undefined ? undefined : captureNeutralPlane(document, handler.result);
    } finally {
        handler.dispose();
        document.selection.clearSelection();
        controller.dispose();
    }
}

export interface PickedPoint {
    readonly ref: PointRef;
    readonly anchors: Record<string, number>;
    /** The clicked point in world coordinates (the ref itself is node-local). */
    readonly world: XYZ;
}

/** Body vertices and datum points; other reference geometry (a plane's corners) is not a point. */
const POINT_NODES = { allow: (node: INode) => !isReferenceGeometryNode(node) || isDatumPointNode(node) };
/** Body edges and datum axes. */
const EDGE_NODES = { allow: (node: INode) => !isReferenceGeometryNode(node) || isDatumAxisNode(node) };
/** Body faces only — a datum plane is picked through the plane picker, never as a face. */
const FACE_NODES = { allow: (node: INode) => !isReferenceGeometryNode(node) };

export async function pickPoint(
    document: IDocument,
    stepController: AsyncController,
): Promise<PickedPoint | undefined> {
    const picked = await pickShapes(document, stepController, "prompt.select.vertexes", {
        shapeType: ShapeTypes.vertex,
        nodeFilter: POINT_NODES,
    });
    const vertex = picked?.find((candidate) => candidate.shape.shapeType === ShapeTypes.vertex);
    if (vertex === undefined) return undefined;
    const anchors: Record<string, number> = {};
    const captured = capturePoints([vertex], anchors);
    const ref = captured.refs[0];
    return ref === undefined ? undefined : { ref, anchors, world: captured.worlds[0] };
}

export interface PickedPoints {
    readonly points: PointRef[];
    readonly anchors: Record<string, number>;
    readonly worlds: XYZ[];
}

export async function pickPoints(
    document: IDocument,
    count: number,
    stepController: AsyncController,
): Promise<PickedPoints | undefined> {
    const picked = await pickShapes(document, stepController, "prompt.select.vertexes", {
        shapeType: ShapeTypes.vertex,
        nodeFilter: POINT_NODES,
        multi: true,
        canFinish: (selected) => selected.length >= count,
    });
    const vertices = picked?.filter((candidate) => candidate.shape.shapeType === ShapeTypes.vertex) ?? [];
    if (vertices.length < count) return undefined;
    const anchors: Record<string, number> = {};
    const captured = capturePoints(vertices.slice(0, count), anchors);
    return captured.refs.length === count
        ? { points: captured.refs, anchors, worlds: captured.worlds }
        : undefined;
}

/**
 * One pick with its OWN controller: a selection handler settles the controller it was
 * given, so reusing a controller across picks makes every later pick return instantly.
 * The selection is cleared first (a stale selection would otherwise be captured) and the
 * success status is checked so Escape is not mistaken for an answer.
 */
export async function pickShapes(
    document: IDocument,
    stepController: AsyncController,
    prompt: I18nKeys,
    options: Omit<PickShapeOptions, "nodeFilter"> & {
        nodeFilter?: PickShapeOptions["nodeFilter"];
    },
): Promise<VisualShapeData[] | undefined> {
    const controller = new AsyncController();
    stepController.onCancelled(() => controller.cancel());
    document.selection.clearSelection();
    try {
        const picked = await document.picker.pickShape(prompt, controller, options);
        return controller.result?.status === "success" ? picked : undefined;
    } finally {
        document.selection.clearSelection();
        controller.dispose();
    }
}

/**
 * Vertex refs in the source node's LOCAL frame (moving the source's transform must not
 * break them), plus the same points in world coordinates for the display anchor.
 */
function capturePoints(
    shapes: VisualShapeData[],
    anchors: Record<string, number>,
): { refs: PointRef[]; worlds: XYZ[] } {
    const refs: PointRef[] = [];
    const worlds: XYZ[] = [];
    for (const picked of shapes) {
        const node = picked.owner.node;
        recordAnchor(node, anchors);
        const vertex = picked.shape as IVertex;
        const incident = captureVertexIncidence(node, vertex);
        refs.push({
            nodeId: node.id,
            vertex: captureVertexRef(vertex),
            ...(incident === undefined ? {} : { incident }),
        });
        worlds.push(picked.transform.ofPoint(vertex.point()));
    }
    return { refs, worlds };
}

export interface PickedEdge {
    readonly ref: EdgeSourceRef;
    readonly anchors: Record<string, number>;
    /** The edge's source-geometry point in WORLD coordinates, for the display anchor. */
    readonly anchor: XYZLike;
    /** The edge's start in the source's LOCAL frame (an on-edge point measures from it). */
    readonly localStart: XYZLike;
}

export async function pickEdge(
    document: IDocument,
    stepController: AsyncController,
    prompt: I18nKeys,
    filter?: IShapeFilter,
): Promise<PickedEdge | undefined> {
    const picked = await pickShapes(document, stepController, prompt, {
        shapeType: ShapeTypes.edge,
        shapeFilter: filter,
        nodeFilter: EDGE_NODES,
    });
    const data = picked?.find((candidate) => candidate.shape.shapeType === ShapeTypes.edge);
    if (data === undefined) return undefined;
    const node = data.owner.node;
    const anchors: Record<string, number> = {};
    recordAnchor(node, anchors);
    const owned: IShape[] = [];
    try {
        const localEdge = data.shape as IEdge;
        const worldEdge = worldShape(localEdge, data.transform, owned);
        const edgeId = node instanceof ParametricBodyNode ? node.edgeIdAt(data.indexes[0]) : undefined;
        const splitPiece =
            node instanceof ParametricBodyNode && edgeId !== undefined ? node.edgeIdIsShared(edgeId) : false;
        return {
            // Captured in the source's LOCAL frame: a moved source still re-matches, and
            // only the resolved geometry is carried into world coordinates.
            ref: { nodeId: node.id, edge: captureEdgeRef(localEdge, edgeId, splitPiece) },
            anchors,
            anchor: worldEdgeAnchor(worldEdge),
            localStart: plainVec(localEdge.startPoint()),
        };
    } finally {
        disposeAll(owned);
    }
}

export interface PickedFace {
    readonly ref: FaceSourceRef;
    readonly anchors: Record<string, number>;
    /** Where the click landed, in WORLD coordinates. */
    readonly world: XYZ;
    /** The same point in the face source's LOCAL frame. */
    readonly local: XYZ;
}

/** A face of a body (or any shape node), captured with its tracked id when it has one. */
export async function pickFace(
    document: IDocument,
    stepController: AsyncController,
    prompt: I18nKeys,
    filter?: IShapeFilter,
): Promise<PickedFace | undefined> {
    const picked = await pickShapes(document, stepController, prompt, {
        shapeType: ShapeTypes.face,
        shapeFilter: filter,
        nodeFilter: FACE_NODES,
    });
    const data = picked?.find((candidate) => candidate.shape.shapeType === ShapeTypes.face);
    if (data === undefined) return undefined;
    const node = data.owner.node;
    const anchors: Record<string, number> = {};
    recordAnchor(node, anchors);
    const face = data.shape as IFace;
    const faceId = node instanceof ParametricBodyNode ? node.faceIdAt(data.indexes[0]) : undefined;
    const splitPiece =
        node instanceof ParametricBodyNode && faceId !== undefined
            ? node.faceIndexesOfId(faceId).length > 1
            : false;
    const inverse = data.transform.invert();
    const world = data.point ?? data.transform.ofPoint(face.normal(0, 0)[0]);
    const local = inverse === undefined ? world : inverse.ofPoint(world);
    return {
        ref: { nodeId: node.id, face: captureFaceSource(face, faceId, splitPiece) },
        anchors,
        world,
        local,
    };
}

export function recordPlaneAnchor(
    document: IDocument,
    ref: NeutralPlaneRef,
    anchors: Record<string, number>,
): void {
    const nodeId = planeRefNodeId(ref);
    if (nodeId === undefined) return;
    const node = document.modelManager.findNode((candidate) => candidate.id === nodeId);
    if (node !== undefined) recordAnchor(node, anchors);
}

export function recordAnchor(node: INode, anchors: Record<string, number>): void {
    if (!(node instanceof ParametricBodyNode)) return;
    anchors[node.id] = node.evaluationStopIndex();
}

function disposeAll(shapes: IShape[]): void {
    for (const shape of shapes) shape.dispose();
}

/** The picked vertex's incident edges, captured as topology (see `captureVertexAnchors`). */
function captureVertexIncidence(node: INode, vertex: IVertex): VertexAnchor[] | undefined {
    if (!(node instanceof ShapeNode) || !node.shape.isOk) return undefined;
    const edgeIdAt = node instanceof ParametricBodyNode ? (index: number) => node.edgeIdAt(index) : undefined;
    return captureVertexAnchors(node.shape.value, vertex, edgeIdAt);
}

/** A world point of the edge's plane, used as the display anchor. */
function worldEdgeAnchor(edge: IEdge): XYZLike {
    const basis = edge.curve.basisCurve;
    if (CurveUtils.isCircle(basis)) return plainVec(basis.center);
    if (CurveUtils.isLine(basis)) return plainVec(edge.startPoint());
    return plainVec(edgeMidPoint(edge));
}

export function centroid(points: readonly XYZLike[]): XYZLike {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const point of points) {
        x += point.x;
        y += point.y;
        z += point.z;
    }
    return { x: x / points.length, y: y / points.length, z: z / points.length };
}

export function midpoint(first: XYZLike, second: XYZLike): XYZLike {
    return {
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
        z: (first.z + second.z) / 2,
    };
}

export function lineDirection(edge: EdgeRef): XYZLike | undefined {
    if (edge.kind !== "line") return undefined;
    const direction = new XYZ(edge.end).sub(new XYZ(edge.start)).normalize();
    return direction === undefined ? undefined : { x: direction.x, y: direction.y, z: direction.z };
}

/**
 * The run-time preview of a datum being made: whatever `build` draws, refreshed when the
 * panel's values change, with Enter/Space to confirm (see `PreviewConfirmHandler`).
 */
export class ConstructionPreviewHandler extends PreviewConfirmHandler {
    constructor(
        document: IDocument,
        controller: AsyncController,
        private readonly build: () => ShapeMeshData[] | undefined,
    ) {
        super(document, controller);
        this.start();
    }

    protected override buildPreview(): DragPreview {
        return { meshes: this.build() ?? [] };
    }

    protected override canConfirm(): boolean {
        return this.build() !== undefined;
    }

    protected override previewOpacity(): number {
        return 0.35;
    }

    protected override previewOnTop(): boolean {
        return true;
    }
}

/** Toasts a preview error once per distinct message (a failing preview refreshes often). */
export class PreviewErrorReporter {
    private _last: string | undefined;

    report(error: string): undefined {
        if (this._last !== error) {
            this._last = error;
            PubSub.default.pub("showToast", "error.default:{0}", error);
        }
        return undefined;
    }

    clear(): void {
        this._last = undefined;
    }
}
