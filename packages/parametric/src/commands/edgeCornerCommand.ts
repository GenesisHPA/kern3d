// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    BoundingBox,
    Combobox,
    CurveUtils,
    command,
    type I18nKeys,
    Id,
    type IEdge,
    type INode,
    type INodeVisual,
    type IShape,
    type IStep,
    LENGTH_UNITS,
    MathUtils,
    MultistepCommand,
    type ParameterValue,
    PubSub,
    property,
    Result,
    type ShapeMeshData,
    ShapeTypes,
    Transaction,
    type ValueArrowData,
    type ValueArrowPickHandler,
    ValueArrowSelectStep,
    type VisualShapeData,
    VisualStates,
    XYZ,
} from "@chili3d/core";
import { referenceFaces } from "../features/edgeCorner";
import { matchEdgeIndexes } from "../features/edgeMatcher";
import { captureEdgeRef, type EdgeRef } from "../features/edgeRef";
import type { ChamferFeatureData, ChamferMode, FilletFeatureData } from "../features/feature";
import { reportSilentIdLoss } from "../features/idDiagnostics";
import { ParametricBodyNode } from "../parametricBodyNode";

/** Shared flow for fillet/chamfer: pick edges of a parametric body, enter the value. */
abstract class EdgeCornerFeatureCommand extends MultistepCommand {
    protected abstract readonly featureType: "fillet" | "chamfer";

    /** The fillet radius / chamfer distance, entered in the command's floating options tab. */
    protected abstract get value(): ParameterValue;
    protected abstract set value(value: ParameterValue);

    /**
     * The value as the preview, the arrow and the kernel need it. Undefined when the
     * expression will not resolve; the feature itself keeps what the user typed.
     */
    protected get valueNumber(): number | undefined {
        const resolved = this.resolveParameter(this.value, LENGTH_UNITS);
        return resolved.isOk ? resolved.value : undefined;
    }

    /**
     * The asymmetric chamfer's second offset and reference side, for the preview. Undefined is a
     * plain (equal) corner; null is an asymmetric one whose second value does not resolve yet.
     */
    protected chamferSides(): ChamferSides | undefined | null {
        return undefined;
    }

    /** Checks the command's other rows before commit; an error refuses the commit. */
    protected validateExtraParameters(): Result<void> {
        return Result.ok(undefined);
    }

    private get body(): ParametricBodyNode {
        return this.stepDatas[0].nodes![0] as unknown as ParametricBodyNode;
    }

    private previewId: number | undefined;
    private previewOwner: INodeVisual | undefined;
    private activeHandler: ValueArrowPickHandler | undefined;

    protected override async executeAsync(): Promise<void> {
        const selection = this.document.selection;
        selection.onShapeChanged.sub(this.updatePreview);
        try {
            await super.executeAsync();
        } finally {
            selection.onShapeChanged.remove(this.updatePreview);
            this.removePreview();
        }
    }

    /**
     * Previews the fillet/chamfer on the body's current shape: the picked edges are
     * re-matched with the same fingerprint logic the feature evaluation uses, so the
     * preview equals the committed result. The original body is ghosted (faceTransparent)
     * while the preview is up — the rounded/chamfered surfaces are recessed into the
     * solid and an opaque original would hide them. Failures (an oversized value, an
     * ambiguous match) simply show no preview.
     */
    protected readonly updatePreview = () => {
        this.removePreview();
        this.activeHandler?.refreshArrow();
        const value = this.valueNumber;
        if (value === undefined || value <= 0) return;

        const picked = this.pickedEdgesOnBody();
        if (picked === undefined) return;
        const { node, edges } = picked;

        const meshes = this.buildPreviewMeshes(node, edges);
        if (meshes === undefined) return;

        this.previewOwner = edges[0].owner;
        this.document.visual.highlighter.addState(
            this.previewOwner,
            VisualStates.faceTransparent,
            ShapeTypes.shape,
        );
        this.previewId = this.document.visual.context.displayMesh(meshes, { meshOpacity: 1 });
        this.document.visual.update();
    };

    /** The picked edges that all sit on one parametric body, plus that body. */
    private pickedEdgesOnBody(): { node: ParametricBodyNode; edges: VisualShapeData[] } | undefined {
        const selected = this.document.selection.getSelectedShapes();
        const node = selected.at(0)?.owner.node;
        if (!(node instanceof ParametricBodyNode) || !node.shape.isOk) return undefined;
        const edges = selected.filter((x) => x.owner.node === node && x.shape.shapeType === ShapeTypes.edge);
        if (edges.length === 0) return undefined;
        return { node, edges };
    }

    /** The corner result's mesh in the picked faces' world placement, or undefined on failure. */
    private buildPreviewMeshes(
        node: ParametricBodyNode,
        edges: VisualShapeData[],
    ): ShapeMeshData[] | undefined {
        const value = this.valueNumber;
        if (value === undefined) return undefined;
        const sides = this.chamferSides();
        if (sides === null) return undefined;
        const world = cornerPreview(node, edges, value, this.featureType, sides);
        if (world === undefined) return undefined;
        const { faces, edges: outlines } = world.mesh;
        world.dispose();
        if (faces === undefined) return undefined;
        return [faces, outlines].filter((x) => x !== undefined);
    }

    private removePreview() {
        if (this.previewOwner !== undefined) {
            this.document.visual.highlighter.removeState(
                this.previewOwner,
                VisualStates.faceTransparent,
                ShapeTypes.shape,
            );
            this.previewOwner = undefined;
        }
        if (this.previewId !== undefined) {
            this.document.visual.context.removeMesh(this.previewId);
            this.previewId = undefined;
        }
    }

    /**
     * Arrow placement for the drag handle: anchored at the first picked edge's midpoint,
     * pointing out of the body — radially for circular edges, otherwise along the
     * edge-midpoint-to-body-center direction projected perpendicular to the tangent.
     */
    private readonly arrowData = (): ValueArrowData | undefined => {
        const value = this.valueNumber;
        if (value === undefined) return undefined;
        const first = this.document.selection.getSelectedShapes().at(0);
        if (first === undefined || !(first.owner.node instanceof ParametricBodyNode)) return undefined;

        const world = (first.shape as unknown as IEdge).transformedMul(first.transform) as IEdge;
        try {
            const midParam = (world.firstParameter() + world.lastParameter()) / 2;
            const direction = this.arrowDirection(world, midParam, first);
            if (direction === undefined) return undefined;
            return { anchor: world.pointAt(midParam), direction, value: Math.max(value, 0) };
        } finally {
            world.dispose();
        }
    };

    private arrowDirection(edge: IEdge, midParam: number, data: VisualShapeData): XYZ | undefined {
        const basis = edge.curve.basisCurve;
        if (CurveUtils.isCircle(basis)) {
            return edge.pointAt(midParam).sub(basis.center).normalize();
        }

        const tangent = edge.curve.d1(midParam).vec.normalize();
        const node = data.owner.node as ParametricBodyNode;
        if (tangent === undefined || !node.shape.isOk) return undefined;

        const center = data.transform.ofPoint(BoundingBox.center(node.shape.value.boundingBox()));
        const outward = edge.pointAt(midParam).sub(center);
        const perpendicular = outward.sub(tangent.multiply(outward.dot(tangent))).normalize();
        if (perpendicular !== undefined) return perpendicular;

        // Degenerate (the midpoint-to-center line runs along the edge): any perpendicular.
        const side = Math.abs(tangent.dot(XYZ.unitZ)) < 0.9 ? XYZ.unitZ : XYZ.unitX;
        return tangent.cross(side).normalize();
    }

    private readonly setValueFromArrow = (value: number) => {
        this.value = value;
    };

    protected override getSteps(): IStep[] {
        return [
            new ValueArrowSelectStep(
                {
                    shapeType: ShapeTypes.edge,
                    nodeFilter: { allow: (node: INode) => this.allowNode(node) },
                    // The picked edges seed the gesture, but the default radius is not the
                    // user's answer: Onshape opens the fillet for preview and confirmation.
                    preselectionAnswers: false,
                },
                { arrowData: this.arrowData, setValue: this.setValueFromArrow },
                (handler) => (this.activeHandler = handler),
            ),
        ];
    }

    /** Only parametric bodies; once an edge is picked, the rest must come from the same body. */
    private allowNode(node: INode): boolean {
        if (!(node instanceof ParametricBodyNode)) return false;
        const first = this.document.selection.getSelectedShapes().at(0)?.owner.node;
        return first === undefined || node === first;
    }

    protected override executeMainTask(): void {
        // The same refusal the extrude commit makes: the feature keeps the expression the user
        // typed, and an expression that no longer resolves — the variable was deleted between
        // typing and confirming, and the parameters panel is not modal — fails the next rebuild
        // and takes every feature after it down the chain with it.
        const resolved = this.resolveParameter(this.value, LENGTH_UNITS);
        if (!resolved.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", resolved.error);
            return;
        }
        const extra = this.validateExtraParameters();
        if (!extra.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", extra.error);
            return;
        }
        const edges = this.stepDatas[0].shapes.map((data) => {
            const edgeId = this.body.edgeIdAt(data.indexes[0]);
            if (edgeId === undefined) {
                reportSilentIdLoss(this.body, "edge", "a picked fillet/chamfer edge has no tracked id");
            }
            return captureEdgeRef(data.shape as unknown as IEdge, edgeId, this.body.edgeIdIsShared(edgeId));
        });
        Transaction.execute(this.document, `excute ${this.featureType}`, () => {
            this.body.setFeaturesEmitShapeChanged([...this.body.features, this.feature(this.value, edges)]);
            this.document.visual.update();
        });
    }

    protected feature(value: ParameterValue, edges: EdgeRef[]): FilletFeatureData | ChamferFeatureData {
        if (this.featureType === "fillet") {
            return { id: Id.generate(), type: "fillet", radius: value, edges };
        }
        return { id: Id.generate(), type: "chamfer", distance: value, edges };
    }
}

@command({ key: "feature.fillet", icon: "icon-fillet" })
export class FilletFeatureCommand extends EdgeCornerFeatureCommand {
    protected readonly featureType = "fillet" as const;

    @property("circle.radius", { unit: LENGTH_UNITS })
    get value(): ParameterValue {
        return this.getPrivateValue("value", 2);
    }
    set value(value: ParameterValue) {
        this.setProperty("value", value, () => this.updatePreview());
    }
}

/** The chamfer modes as the command's dropdown shows them, keyed by the feature's own names. */
const CHAMFER_MODE_KEYS: Record<ChamferMode, I18nKeys> = {
    equal: "feature.chamfer.mode.equal",
    twoDistance: "feature.chamfer.mode.twoDistance",
    distanceAngle: "feature.chamfer.mode.distanceAngle",
};

function chamferModeOf(key: I18nKeys): ChamferMode {
    const entry = Object.entries(CHAMFER_MODE_KEYS).find(([, display]) => display === key);
    return (entry?.[0] as ChamferMode | undefined) ?? "equal";
}

@command({ key: "feature.chamfer", icon: "icon-chamfer" })
export class ChamferFeatureCommand extends EdgeCornerFeatureCommand {
    protected readonly featureType = "chamfer" as const;

    @property("common.length", { unit: LENGTH_UNITS })
    get value(): ParameterValue {
        return this.getPrivateValue("value", 1);
    }
    set value(value: ParameterValue) {
        this.setProperty("value", value, () => this.updatePreview());
    }

    /**
     * Classic-CAD-style chamfer type: one distance on both faces, a separate distance per face, or a
     * distance and an angle. The asymmetric two measure `value` on the reference face.
     */
    @property("feature.chamfer.mode", { combobox: Combobox.from(Object.values(CHAMFER_MODE_KEYS)) })
    get mode(): I18nKeys {
        return this.getPrivateValue("mode", CHAMFER_MODE_KEYS.equal);
    }
    set mode(value: I18nKeys) {
        const wasAsymmetric = this.asymmetric;
        this.setProperty("mode", value, () => {
            // the flip row hangs on `asymmetric`, so it has to hear the change too
            if (this.asymmetric !== wasAsymmetric) this.emitPropertyChanged("asymmetric", wasAsymmetric);
            this.updatePreview();
        });
    }

    /**
     * `mode !== equal`, exposed on its own because a row's visibility dependency compares
     * against one value: the flip row shows for both asymmetric modes. Derived, so a mode
     * restored from the option cache (which bypasses the setter) still reads right.
     */
    get asymmetric(): boolean {
        return this.mode !== CHAMFER_MODE_KEYS.equal;
    }

    @property("feature.chamfer.distance2", {
        unit: LENGTH_UNITS,
        dependencies: [{ property: "mode", value: CHAMFER_MODE_KEYS.twoDistance }],
    })
    get distance2(): ParameterValue {
        return this.getPrivateValue("distance2", 2);
    }
    set distance2(value: ParameterValue) {
        this.setProperty("distance2", value, () => this.updatePreview());
    }

    @property("feature.chamfer.angle", {
        unit: ANGLE_UNITS,
        dependencies: [{ property: "mode", value: CHAMFER_MODE_KEYS.distanceAngle }],
    })
    get angle(): ParameterValue {
        return this.getPrivateValue("angle", 45);
    }
    set angle(value: ParameterValue) {
        this.setProperty("angle", value, () => this.updatePreview());
    }

    /** Swaps which face of each edge `value` is measured on. */
    @property("feature.chamfer.flip", { dependencies: [{ property: "asymmetric", value: true }] })
    get flip(): boolean {
        return this.getPrivateValue("flip", false);
    }
    set flip(value: boolean) {
        this.setProperty("flip", value, () => this.updatePreview());
    }

    private get chamferMode(): ChamferMode {
        return chamferModeOf(this.mode);
    }

    /** The second offset in millimetres, as the feature will derive it. */
    private secondDistance(): Result<number> {
        if (this.chamferMode === "twoDistance") return this.resolveParameter(this.distance2, LENGTH_UNITS);
        const angle = this.resolveParameter(this.angle, ANGLE_UNITS);
        if (!angle.isOk) return angle;
        if (angle.value <= 0 || angle.value >= 90)
            return Result.err("The angle must lie between 0 and 90 degrees");
        const d1 = this.valueNumber;
        if (d1 === undefined) return Result.err("The length does not resolve");
        return Result.ok(d1 * Math.tan(MathUtils.degToRad(angle.value)));
    }

    protected override chamferSides(): ChamferSides | undefined | null {
        if (this.chamferMode === "equal") return undefined;
        const d2 = this.secondDistance();
        return d2.isOk && d2.value > 0 ? { distance2: d2.value, flip: this.flip } : null;
    }

    protected override validateExtraParameters(): Result<void> {
        if (this.chamferMode === "equal") return Result.ok(undefined);
        const d2 = this.secondDistance();
        if (!d2.isOk) return Result.err(d2.error);
        return d2.value > 0 ? Result.ok(undefined) : Result.err("The second distance must be positive");
    }

    protected override feature(value: ParameterValue, edges: EdgeRef[]): ChamferFeatureData {
        const base = super.feature(value, edges) as ChamferFeatureData;
        const mode = this.chamferMode;
        if (mode === "equal") return base;
        return {
            ...base,
            mode,
            distance2: mode === "twoDistance" ? this.distance2 : undefined,
            angle: mode === "distanceAngle" ? this.angle : undefined,
            flip: this.flip || undefined,
        };
    }
}

/** An asymmetric chamfer's second offset (mm) and whether the reference face is flipped. */
export interface ChamferSides {
    readonly distance2: number;
    readonly flip: boolean;
}

/**
 * The body the corner would leave, in the picked edges' world placement — the same kernel call the
 * feature makes, so a preview equals the committed result. Undefined when the edges cannot be
 * matched back or the kernel refuses the radius/length.
 *
 * Exported because Press Pull drags an edge and has to show what it is about to build WITHOUT
 * building it: this is the one place that knows how, and both commands go through it.
 */
export function cornerPreview(
    node: INode,
    picked: readonly VisualShapeData[],
    value: number,
    method: "fillet" | "chamfer",
    sides?: ChamferSides,
): IShape | undefined {
    if (picked.length === 0 || !(node instanceof ParametricBodyNode) || !node.shape.isOk) return undefined;
    const shape = node.shape.value;
    const indexes = matchEdgeIndexes(
        shape,
        picked.map((x) => captureEdgeRef(x.shape as unknown as IEdge)),
    );
    if (!indexes.isOk) return undefined;

    const result = cornerResult(shape, indexes.value, value, method, sides);
    if (!result.isOk) return undefined;
    const world = result.value.transformedMul(picked[0].transform);
    result.value.dispose();
    return world;
}

/** The kernel call the feature makes for these settings: two-distance when `sides` is given. */
function cornerResult(
    shape: IShape,
    indexes: number[],
    value: number,
    method: "fillet" | "chamfer",
    sides: ChamferSides | undefined,
): Result<IShape> {
    if (method === "fillet" || sides === undefined) return shapeFactory[method](shape, indexes, value);
    const twoDist = shapeFactory.chamferTwoDist;
    if (twoDist === undefined) return Result.err("The kernel does not support two-distance chamfers");
    const faces = referenceFaces(shape, indexes, sides.flip);
    if (!faces.isOk) return Result.err(faces.error);
    return twoDist.call(shapeFactory, shape, indexes, value, sides.distance2, faces.value);
}
