// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Combobox,
    command,
    EMPTY_SCOPE,
    Id,
    type IFace,
    type INodeVisual,
    type IShape,
    type IStep,
    LENGTH_UNITS,
    MultistepCommand,
    type ParameterValue,
    PubSub,
    property,
    type Scope,
    ShapeTypes,
    Transaction,
    type VisualShapeData,
    VisualStates,
} from "@chili3d/core";
import type { ThreadFeatureData } from "../features/feature";
import { reportSilentIdLoss } from "../features/idDiagnostics";
import { captureProfileRef } from "../features/profileRef";
import { cutThread, resolveThreadSpec, type ThreadSpecFields, threadPlanOn } from "../features/thread";
import { buildThreadTool, cylinderOfFace } from "../features/threadGeometry";
import { suggestThreadSize, THREAD_STANDARDS, threadRow } from "../features/threadStandards";
import { ParametricBodyNode } from "../parametricBodyNode";
import { matchMovedFaces } from "./offsetFaceCommand";
import { SelectBodyFacesStep } from "./selectBodyFacesStep";

/** The cylindrical face to thread, picked on ONE parametric body. */
export class SelectThreadFaceStep extends SelectBodyFacesStep {
    constructor(onReady: () => void = () => {}) {
        super(onReady, "prompt.select.threadFace");
    }
}

const DEFAULT_SIZE = "M8";
const DEFAULT_ROW = threadRow(DEFAULT_SIZE) ?? THREAD_STANDARDS[0];

/**
 * Thread (Fusion's Thread): pick a cylindrical face of a parametric body — a shaft or a bore,
 * told apart automatically — and thread it to a standard size.
 *
 * Follows `offsetFaceCommand.ts`: one face pick that stays open until confirmed, the values in the
 * floating options tab, a live preview built by the same code the feature runs. Picking a face
 * suggests the size that fits its diameter (`suggestThreadSize`) — once per newly picked face, so
 * a size the user then chooses is not overwritten by the next preview.
 *
 * A modelled preview shows the threaded body over the ghosted original; a cosmetic one shows the
 * thread's groove as a translucent marker, since the body itself does not change. Only the first
 * cylindrical face of the pick is threaded: one feature, one face.
 */
@command({ key: "feature.thread", icon: "icon-helix" })
export class ThreadFeatureCommand extends MultistepCommand {
    @property("feature.thread.size", { combobox: Combobox.from(THREAD_STANDARDS.map((row) => row.size)) })
    get size(): string {
        return this.getPrivateValue("size", DEFAULT_SIZE);
    }
    set size(value: string) {
        this.setProperty("size", value, () => {
            this.applySize(value);
            this.updatePreview();
        });
    }

    @property("dimension.diameter", { unit: LENGTH_UNITS })
    get diameter(): ParameterValue {
        return this.getPrivateValue("diameter", DEFAULT_ROW.diameter);
    }
    set diameter(value: ParameterValue) {
        this.setProperty("diameter", value, () => this.updatePreview());
    }

    @property("helix.pitch", { unit: LENGTH_UNITS })
    get pitch(): ParameterValue {
        return this.getPrivateValue("pitch", DEFAULT_ROW.pitch);
    }
    set pitch(value: ParameterValue) {
        this.setProperty("pitch", value, () => this.updatePreview());
    }

    /** Real geometry (on) or only the record of the thread (off, cosmetic). */
    @property("feature.thread.modeled")
    get modeled(): boolean {
        return this.getPrivateValue("modeled", true);
    }
    set modeled(value: boolean) {
        this.setProperty("modeled", value, () => this.updatePreview());
    }

    /** Blank threads the whole face. */
    @property("feature.thread.length", { unit: LENGTH_UNITS })
    get length(): ParameterValue {
        return this.getPrivateValue("length", "");
    }
    set length(value: ParameterValue) {
        this.setProperty("length", value, () => this.updatePreview());
    }

    @property("feature.thread.offset", { unit: LENGTH_UNITS })
    get offset(): ParameterValue {
        return this.getPrivateValue("offset", 0);
    }
    set offset(value: ParameterValue) {
        this.setProperty("offset", value, () => this.updatePreview());
    }

    @property("feature.thread.flip")
    get flip(): boolean {
        return this.getPrivateValue("flip", false);
    }
    set flip(value: boolean) {
        this.setProperty("flip", value, () => this.updatePreview());
    }

    /** Radial play for a printed fit (0 = the basic profile). */
    @property("feature.thread.clearance", { unit: LENGTH_UNITS })
    get clearance(): ParameterValue {
        return this.getPrivateValue("clearance", 0);
    }
    set clearance(value: ParameterValue) {
        this.setProperty("clearance", value, () => this.updatePreview());
    }

    private previewId: number | undefined;
    private previewOwner: INodeVisual | undefined;
    /** The face the size was last suggested for, so a re-preview does not undo the user's choice. */
    private suggestedFor: string | undefined;

    protected override async executeAsync(): Promise<void> {
        this.document.selection.onShapeChanged.sub(this.updatePreview);
        try {
            await super.executeAsync();
        } finally {
            this.document.selection.onShapeChanged.remove(this.updatePreview);
            this.removePreview();
        }
    }

    /** Writes a picked size's numbers into the diameter and pitch, as the feature row does. */
    private applySize(size: string) {
        const row = threadRow(size);
        if (row === undefined) return;
        this.setProperty("diameter", row.diameter);
        this.setProperty("pitch", row.pitch);
    }

    /** The feature the current values describe, on `face` (a ref already captured). */
    private feature(face: ThreadFeatureData["face"]): ThreadFeatureData {
        return {
            id: Id.generate(),
            type: "thread",
            face,
            size: this.size,
            modeled: this.modeled,
            ...this.specFields(),
        };
    }

    /** The values the geometry is built from — what the preview resolves without a face ref. */
    private specFields(): ThreadSpecFields {
        return {
            form: threadRow(this.size)?.form ?? "iso",
            diameter: this.diameter,
            pitch: this.pitch,
            ...(this.length === "" ? {} : { length: this.length }),
            ...(this.offset === 0 || this.offset === "" ? {} : { offset: this.offset }),
            ...(this.flip ? { flip: true } : {}),
            ...(this.clearance === 0 || this.clearance === "" ? {} : { clearance: this.clearance }),
        };
    }

    protected readonly updatePreview = () => {
        this.removePreview();
        const picked = this.pickedFace();
        if (picked === undefined) return;
        const built = this.build(picked);
        if (built === undefined) return;

        this.previewOwner = picked.data.owner;
        if (this.modeled) {
            this.document.visual.highlighter.addState(
                this.previewOwner,
                VisualStates.faceTransparent,
                ShapeTypes.shape,
            );
        }
        const { faces, edges } = built.mesh;
        built.dispose();
        if (faces === undefined) return;
        this.previewId = this.document.visual.context.displayMesh(
            [faces, edges].filter((x) => x !== undefined),
            { meshOpacity: this.modeled ? 1 : 0.5 },
        );
        this.document.visual.update();
    };

    /**
     * The threaded body (modelled) or the groove alone (cosmetic) in world placement, built on the
     * body's current shape by the feature's own code; undefined when it cannot be built — a size
     * that does not fit the face simply shows nothing until it does.
     */
    private build(picked: {
        node: ParametricBodyNode;
        face: IFace;
        data: VisualShapeData;
    }): IShape | undefined {
        this.suggestSize(picked);
        const spec = resolveThreadSpec(this.specFields(), this.scope());
        if (!spec.isOk) return undefined;
        const plan = threadPlanOn(picked.face, spec.value);
        if (!plan.isOk) return undefined;
        let shape: IShape;
        if (this.modeled) {
            const cut = cutThread(picked.node.shape.value, plan.value, "preview");
            if (!cut.isOk) return undefined;
            shape = cut.value;
        } else {
            const tool = buildThreadTool(plan.value, "preview");
            if (!tool.isOk) return undefined;
            shape = tool.value.shape;
        }
        const world = shape.transformedMul(picked.data.transform);
        shape.dispose();
        return world;
    }

    /** The document's variables, for the expressions the fields may hold (none outside a run). */
    private scope(): Scope {
        try {
            return this.document.variables.evaluate().scope;
        } catch {
            return EMPTY_SCOPE;
        }
    }

    /** Once per newly picked face: the size that fits its diameter, on a shaft or in a bore. */
    private suggestSize(picked: { node: ParametricBodyNode; face: IFace; data: VisualShapeData }) {
        const key = `${picked.node.id}:${picked.data.indexes[0]}`;
        if (this.suggestedFor === key) return;
        this.suggestedFor = key;
        const frame = cylinderOfFace(picked.face);
        if (!frame.isOk) return;
        const row = suggestThreadSize(2 * frame.value.radius, frame.value.internal);
        if (row === undefined) return;
        this.setProperty("size", row.size);
        this.applySize(row.size);
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

    /** The first picked face that is a cylinder, matched onto its body's current shape. */
    private pickedFace(): { node: ParametricBodyNode; face: IFace; data: VisualShapeData } | undefined {
        const shapes = this.stepDatas[0]?.shapes ?? this.document.selection.getSelectedShapes();
        for (const data of shapes) {
            const node = data.owner.node;
            if (!(node instanceof ParametricBodyNode) || !node.shape.isOk) continue;
            if (data.shape.shapeType !== ShapeTypes.face) continue;
            if (!cylinderOfFace(data.shape as unknown as IFace).isOk) continue;
            const index = matchMovedFaces(node, [data])?.[0];
            if (index === undefined) continue;
            const face = (node.shape.value.findSubShapes(ShapeTypes.face) as IFace[])[index];
            return { node, face, data };
        }
        return undefined;
    }

    protected override getSteps(): IStep[] {
        return [new SelectThreadFaceStep(() => this.updatePreview())];
    }

    protected override executeMainTask(): void {
        const picked = this.pickedFace();
        if (picked === undefined) {
            PubSub.default.pub("showToast", "error.default:{0}", "Select a cylindrical face to thread");
            return;
        }
        const { node: body, data } = picked;
        const faceId = body.faceIdAt(data.indexes[0]);
        if (faceId === undefined) reportSilentIdLoss(body, "face", "a threaded face has no tracked id");
        const ref = captureProfileRef(data.shape as unknown as IFace, faceId, body.faceIdIsShared(faceId));
        const feature = this.feature(ref);
        // The feature keeps the expressions the user typed; one that does not resolve, or a size
        // that does not fit the face, is refused here rather than committed as a failing feature.
        const spec = resolveThreadSpec(feature, this.scope());
        const plan = spec.isOk ? threadPlanOn(picked.face, spec.value) : spec;
        if (!plan.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", plan.error);
            return;
        }
        Transaction.execute(this.document, "excute feature.thread", () => {
            body.setFeaturesEmitShapeChanged([...body.features, feature]);
            this.document.visual.update();
        });
    }
}
