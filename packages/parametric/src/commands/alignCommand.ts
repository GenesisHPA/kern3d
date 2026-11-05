// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    AsyncController,
    command,
    type I18nKeys,
    type IDocument,
    type INodeFilter,
    type IStep,
    type Matrix4,
    MultistepCommand,
    type ParameterValue,
    PubSub,
    property,
    type ShapeType,
    ShapeTypes,
    type SnapResult,
    Transaction,
    type VisualNode,
    type VisualShapeData,
} from "@chili3d/core";
import { type AlignPick, alignFrameOf, alignmentMatrix } from "./alignGeometry";
import {
    applyPlacement,
    confirmPlacement,
    isPlaceableNode,
    type PlacementPreviewHandler,
    type PlacementSource,
} from "./placementPreview";

const ALIGN_SHAPE_TYPES = (ShapeTypes.face | ShapeTypes.edge | ShapeTypes.vertex) as ShapeType;

/**
 * Align: pick geometry on the part to move, then geometry to bring it onto. Two
 * planar faces end up flush (normals opposite, keypoints coincident), two straight edges or
 * cylinder axes collinear, two circles concentric and coplanar; any other pairing — a vertex
 * on either side — is a pure translation of keypoint onto keypoint. The moved part hangs in
 * its new place until confirmed; Flip, an extra angle about the aligned axis, face-centre
 * snapping and Copy are edited in the panel meanwhile.
 */
@command({ key: "modify.align", icon: "icon-alignWorkingPlane" })
export class AlignCommand extends MultistepCommand implements PlacementSource {
    @property("option.command.flip")
    get flip(): boolean {
        return this.getPrivateValue("flip", false);
    }
    set flip(value: boolean) {
        this.setProperty("flip", value, () => this._preview?.refresh());
    }

    @property("common.angle", { unit: ANGLE_UNITS })
    get angle(): ParameterValue {
        return this.getPrivateValue("angle", 0);
    }
    set angle(value: ParameterValue) {
        this.setProperty("angle", value, () => this._preview?.refresh());
    }

    @property("option.command.snapToCenter")
    get snapToCenter(): boolean {
        return this.getPrivateValue("snapToCenter", true);
    }
    set snapToCenter(value: boolean) {
        this.setProperty("snapToCenter", value, () => this._preview?.refresh());
    }

    @property("common.clone")
    get isClone(): boolean {
        return this.getPrivateValue("isClone", false);
    }
    set isClone(value: boolean) {
        this.setProperty("isClone", value, () => this._preview?.refresh());
    }

    private _source: AlignPick | undefined;
    private _target: AlignPick | undefined;
    private _models: VisualNode[] = [];
    private _preview: PlacementPreviewHandler | undefined;
    private _lastError: string | undefined;

    get models(): readonly VisualNode[] {
        return this._models;
    }

    protected override getSteps(): IStep[] {
        return [new AlignStep(this)];
    }

    protected override onRestarting(): void {
        super.onRestarting();
        this._source = undefined;
        this._target = undefined;
        this._models = [];
    }

    /** Called by the step once both picks are in hand. */
    setPicks(source: AlignPick, target: AlignPick, moved: VisualNode): void {
        this._source = source;
        this._target = target;
        this._models = [moved];
        this._lastError = undefined;
    }

    setPreview(preview: PlacementPreviewHandler | undefined): void {
        this._preview = preview;
    }

    /** The move for the current picks and panel values, or undefined (with a toast) when there is none. */
    transform(): Matrix4 | undefined {
        if (this._source === undefined || this._target === undefined) return undefined;
        const source = alignFrameOf(this._source, this.snapToCenter);
        if (!source.isOk) return this.report(source.error);
        const target = alignFrameOf(this._target, this.snapToCenter);
        if (!target.isOk) return this.report(target.error);
        const angle = this.resolveParameter(this.angle, ANGLE_UNITS);
        if (!angle.isOk) return this.report(angle.error);
        this._lastError = undefined;
        return alignmentMatrix(source.value, target.value, {
            flip: this.flip,
            angle: (angle.value * Math.PI) / 180,
        });
    }

    /** A failing preview says why once, not on every refresh. */
    private report(error: string): undefined {
        if (this._lastError !== error) {
            this._lastError = error;
            PubSub.default.pub("showToast", "error.default:{0}", error);
        }
        return undefined;
    }

    protected override executeMainTask(): void {
        const transform = this.transform();
        if (transform === undefined) return;
        Transaction.execute(this.document, "align", () => {
            applyPlacement(this._models, transform, this.isClone);
            this.document.visual.update();
        });
    }
}

/** The two picks, then the preview/confirm phase. */
class AlignStep implements IStep {
    constructor(private readonly command: AlignCommand) {}

    async execute(document: IDocument, controller: AsyncController): Promise<SnapResult | undefined> {
        const source = await pickOne(document, controller, "prompt.align.source", {
            allow: isPlaceableNode,
        });
        if (source === undefined) return undefined;
        const moved = source.owner.node as VisualNode;
        const target = await pickOne(document, controller, "prompt.align.target", {
            // The target must stay put while the source moves onto it.
            allow: (node) => node !== moved,
        });
        if (target === undefined || controller.result !== undefined) return undefined;
        this.command.setPicks(toPick(source), toPick(target), moved);
        return confirmPlacement(document, controller, this.command, "prompt.align.confirm", (preview) =>
            this.command.setPreview(preview),
        );
    }
}

function toPick(data: VisualShapeData): AlignPick {
    return { shape: data.shape, transform: data.transform, point: data.point };
}

/**
 * One pick with its OWN controller (a selection handler settles the controller it is given),
 * bridged to the step's cancel; Escape is not mistaken for an answer.
 */
async function pickOne(
    document: IDocument,
    stepController: AsyncController,
    prompt: I18nKeys,
    nodeFilter: INodeFilter,
): Promise<VisualShapeData | undefined> {
    const controller = new AsyncController();
    stepController.onCancelled(() => controller.cancel());
    document.selection.clearSelection();
    try {
        const picked = await document.picker.pickShape(prompt, controller, {
            shapeType: ALIGN_SHAPE_TYPES,
            nodeFilter,
        });
        return controller.result?.status === "success" ? picked.at(0) : undefined;
    } finally {
        document.selection.clearSelection();
        controller.dispose();
    }
}
