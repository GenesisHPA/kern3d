// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AssemblyComponentNode,
    AsyncController,
    BoundingBox,
    CancelableCommand,
    Combobox,
    command,
    type EdgeMeshData,
    I18n,
    type I18nKeys,
    type IDocument,
    type INode,
    type IStep,
    Matrix4,
    MultistepCommand,
    NodeUtils,
    owningComponent,
    PubSub,
    property,
    type ShapeMeshData,
    ShapeNode,
    type ShapeType,
    ShapeTypes,
    type SnapResult,
    Transaction,
    type VisualShapeData,
    XYZ,
} from "@chili3d/core";
import { PreviewConfirmHandler } from "../commands/previewConfirmHandler";
import { nodeWorldTransform, placeJointOrigin } from "./assemblyService";
import { ROOT_COMPONENT } from "./assemblySolver";
import {
    JOINT_TYPE_KEYS,
    JOINT_TYPES,
    type JointFrame,
    type JointType,
    jointDofs,
    jointTypeOfKey,
} from "./jointMath";
import { JointNode } from "./jointNode";
import { captureJointOrigin, fixedJointOrigin, type JointOriginRef } from "./jointOrigin";

const JOINT_SHAPE_TYPES = (ShapeTypes.face | ShapeTypes.edge | ShapeTypes.vertex) as ShapeType;
const X_COLOR = 0xe53935;
const Z_COLOR = 0x1e88e5;

/** Runs `action` with the history off: preview state that must never reach the undo stack. */
export function withoutHistory(document: IDocument, action: () => void): void {
    const history = document.history;
    const disabled = history.disabled;
    history.disabled = true;
    try {
        action();
    } finally {
        history.disabled = disabled;
    }
}

/** The component a node belongs to, as a joint side: its id, or the root's. */
export function componentIdOf(node: INode): string {
    return owningComponent(node)?.id ?? ROOT_COMPONENT;
}

/** World placement of a component's local space (identity for the root). */
export function componentWorld(document: IDocument, componentId: string): Matrix4 {
    if (componentId === ROOT_COMPONENT) return Matrix4.identity();
    const node = document.modelManager.findNode((n) => n.id === componentId);
    return node === undefined ? Matrix4.identity() : nodeWorldTransform(node);
}

/** A picked joint origin: the stored ref, the picked node and the component it moves with. */
export interface JointPick {
    readonly ref: JointOriginRef;
    readonly node: INode;
    readonly componentId: string;
}

/** The origin a pick snaps to, or undefined (with a toast) when it is not usable geometry. */
export function jointPickOf(data: VisualShapeData): JointPick | undefined {
    const node = data.owner.node;
    const inverse = data.transform.invert();
    const hit = data.point === undefined || inverse === undefined ? undefined : inverse.ofPoint(data.point);
    const ref = captureJointOrigin(node, data.shape, data.indexes[0], hit);
    if (ref === undefined) {
        PubSub.default.pub("showToast", "assembly.joint.badPick");
        return undefined;
    }
    return { ref, node, componentId: componentIdOf(node) };
}

function isJointGeometryNode(node: INode): boolean {
    return node instanceof ShapeNode && !node.isReferenceGeometry;
}

/**
 * One pick with its OWN controller (a selection handler settles the controller it is given),
 * bridged to the step's cancel; Escape is not mistaken for an answer.
 */
async function pickGeometry(
    document: IDocument,
    stepController: AsyncController,
    prompt: I18nKeys,
    allow: (node: INode) => boolean,
): Promise<VisualShapeData | undefined> {
    const controller = new AsyncController();
    stepController.onCancelled(() => controller.cancel());
    document.selection.clearSelection();
    try {
        const picked = await document.picker.pickShape(prompt, controller, {
            shapeType: JOINT_SHAPE_TYPES,
            nodeFilter: { allow: (node) => isJointGeometryNode(node) && allow(node) },
        });
        return controller.result?.status === "success" ? picked.at(0) : undefined;
    } finally {
        document.selection.clearSelection();
        controller.dispose();
    }
}

/** A frame as a matrix's image of the unit axes. */
export function frameOfMatrix(matrix: Matrix4): JointFrame {
    return {
        origin: matrix.ofPoint(XYZ.zero),
        x: matrix.ofVector(XYZ.unitX).normalize() ?? XYZ.unitX,
        z: matrix.ofVector(XYZ.unitZ).normalize() ?? XYZ.unitZ,
    };
}

/** The X (red) and Z (blue) axes of a joint origin, drawn in world space. */
export function originMarker(document: IDocument, ref: JointOriginRef, size: number): ShapeMeshData[] {
    const placed = placeJointOrigin(document, ref);
    if (placed === undefined) return [];
    const world = placed.frame.multiply(componentWorld(document, placed.componentId));
    const o = world.ofPoint(XYZ.zero);
    const axis = (direction: XYZ, length: number, color: number): EdgeMeshData => {
        const end = world.ofPoint(direction.multiply(length));
        return {
            position: new Float32Array([o.x, o.y, o.z, end.x, end.y, end.z]),
            lineType: "solid",
            color,
            range: [],
        };
    };
    return [axis(XYZ.unitX, size * 0.6, X_COLOR), axis(XYZ.unitZ, size, Z_COLOR)];
}

/** A marker length that reads at the model's scale. */
function markerSize(node: INode): number {
    const box = (node as { boundingBox?: () => BoundingBox | undefined }).boundingBox?.();
    if (box === undefined) return 10;
    return Math.max(5, BoundingBox.diagonal(box) * 0.15);
}

/**
 * The live joint of a joint command: added to the document with the history off, so the solver
 * moves the parts while the options are edited; removed again — every component put back — when
 * the command ends. The real joint is added by the command's own transaction on confirm.
 */
class JointSession {
    private readonly saved = new Map<AssemblyComponentNode, Matrix4>();
    readonly joint: JointNode;

    constructor(
        readonly document: IDocument,
        options: ConstructorParameters<typeof JointNode>[0],
    ) {
        for (const component of document.modelManager.findNodes((n) => n instanceof AssemblyComponentNode)) {
            this.saved.set(
                component as AssemblyComponentNode,
                (component as AssemblyComponentNode).transform,
            );
        }
        this.joint = new JointNode(options);
        withoutHistory(document, () => document.modelManager.rootNode.add(this.joint));
        document.visual.update();
    }

    update(edit: (joint: JointNode) => void) {
        withoutHistory(this.document, () => edit(this.joint));
        this.document.visual.update();
    }

    end() {
        withoutHistory(this.document, () => {
            this.joint.parent?.remove(this.joint);
            for (const [component, transform] of this.saved) component.transform = transform;
        });
        this.joint.dispose();
        this.document.visual.update();
    }
}

/** The confirm phase: the parts already sit where the joint puts them; this draws the origins. */
class JointConfirmHandler extends PreviewConfirmHandler {
    constructor(
        document: IDocument,
        controller: AsyncController,
        private readonly markers: () => ShapeMeshData[],
    ) {
        super(document, controller);
        this.start();
    }

    protected override buildPreview() {
        return { meshes: this.markers() };
    }

    protected override previewOnTop(): boolean {
        return true;
    }

    protected override previewUnlit(): boolean {
        return true;
    }
}

/** Fields shared by the two joint commands: the type, then what a step needs to report back. */
abstract class JointCommandBase extends MultistepCommand {
    @property("assembly.joint.type", { combobox: Combobox.from(JOINT_TYPES.map((t) => JOINT_TYPE_KEYS[t])) })
    get jointTypeKey(): I18nKeys {
        return this.getPrivateValue("jointTypeKey", JOINT_TYPE_KEYS.rigid);
    }
    set jointTypeKey(value: I18nKeys) {
        this.setProperty("jointTypeKey", value, () => {
            this.session?.update((j) => (j.jointType = this.jointType));
            this.refreshPreview();
        });
    }

    protected session: JointSession | undefined;
    private preview: JointConfirmHandler | undefined;

    get jointType(): JointType {
        return jointTypeOfKey(this.jointTypeKey) ?? "rigid";
    }

    /** The joint the picks define, with the command's options. */
    protected abstract jointOptions(): ConstructorParameters<typeof JointNode>[0] | undefined;

    protected override getSteps(): IStep[] {
        return [new JointStep(this)];
    }

    abstract pick(document: IDocument, controller: AsyncController): Promise<boolean>;

    /** Starts the live joint and waits for the confirm; true when confirmed. */
    async confirm(document: IDocument, stepController: AsyncController): Promise<boolean> {
        const options = this.jointOptions();
        if (options === undefined) return false;
        this.session = new JointSession(document, options);
        const controller = new AsyncController();
        stepController.onCancelled(() => controller.cancel());
        const markers = () =>
            [options.origin1, options.origin2].flatMap((ref) =>
                typeof ref === "object" ? originMarker(document, ref, this.markerSize) : [],
            );
        this.preview = new JointConfirmHandler(document, controller, markers);
        try {
            await document.picker.pickAsync(
                this.preview,
                "prompt.joint.confirm",
                controller,
                "none",
                "select.default",
            );
            return controller.result?.status === "success";
        } finally {
            this.preview.dispose();
            this.preview = undefined;
            controller.dispose();
        }
    }

    protected markerSize = 10;

    protected setMarkerSize(node: INode) {
        this.markerSize = markerSize(node);
    }

    /** Puts the preview's markers back after an option moved the parts. */
    protected refreshPreview() {
        this.preview?.refresh();
    }

    protected override executeMainTask(): void {
        const session = this.session;
        if (session === undefined) return;
        const joint = session.joint;
        session.end();
        this.session = undefined;
        Transaction.execute(this.document, "joint", () => {
            const created = joint.clone();
            created.name = NodeUtils.generateName(this.document, I18n.translate("assembly.joint"));
            this.document.modelManager.rootNode.add(created);
            this.document.selection.setSelectedNodes([created], false);
        });
        this.document.visual.update();
    }

    protected override afterExecute(): void {
        this.session?.end();
        this.session = undefined;
        super.afterExecute();
    }
}

class JointStep implements IStep {
    constructor(private readonly command: JointCommandBase) {}

    async execute(document: IDocument, controller: AsyncController): Promise<SnapResult | undefined> {
        if (!(await this.command.pick(document, controller))) return undefined;
        if (controller.result !== undefined) return undefined;
        if (!(await this.command.confirm(document, controller))) return undefined;
        controller.success();
        return { view: document.application.activeView!, shapes: [], type: "input" };
    }
}

/**
 * Fusion's Joint: pick the joint origin on component 1, then on component 2; component 2 moves so
 * its origin lands on component 1's (Z axes facing each other, as two mating faces do). The type,
 * Flip, an offset along Z and an angle about it are edited while the parts already sit in place;
 * the motion values and limits are the joint's own properties afterwards. Bodies at the document
 * root count as one grounded component.
 */
@command({ key: "assemble.joint", icon: "icon-cCoincident" })
export class JointCommand extends JointCommandBase {
    @property("option.command.flip")
    get flip(): boolean {
        return this.getPrivateValue("flip", false);
    }
    set flip(value: boolean) {
        this.setProperty("flip", value, () => this.edit((j) => (j.flip = value)));
    }

    @property("assembly.joint.offset")
    get offset(): number {
        return this.getPrivateValue("offset", 0);
    }
    set offset(value: number) {
        this.setProperty("offset", value, () => this.edit((j) => (j.offset = value)));
    }

    @property("assembly.joint.angle")
    get angle(): number {
        return this.getPrivateValue("angle", 0);
    }
    set angle(value: number) {
        this.setProperty("angle", value, () => this.edit((j) => (j.angle = value)));
    }

    private first: JointPick | undefined;
    private second: JointPick | undefined;

    private edit(change: (joint: JointNode) => void) {
        this.session?.update(change);
        this.refreshPreview();
    }

    protected override onRestarting(): void {
        super.onRestarting();
        this.first = undefined;
        this.second = undefined;
    }

    async pick(document: IDocument, controller: AsyncController): Promise<boolean> {
        const first = await pickGeometry(document, controller, "prompt.joint.origin1", () => true);
        this.first = first === undefined ? undefined : jointPickOf(first);
        if (this.first === undefined) return false;
        const one = this.first.componentId;
        const second = await pickGeometry(
            document,
            controller,
            "prompt.joint.origin2",
            (node) => componentIdOf(node) !== one,
        );
        this.second = second === undefined ? undefined : jointPickOf(second);
        if (this.second === undefined) return false;
        this.setMarkerSize(this.second.node);
        return true;
    }

    protected jointOptions() {
        if (this.first === undefined || this.second === undefined) return undefined;
        return {
            document: this.document,
            name: I18n.translate("assembly.joint"),
            jointType: this.jointType,
            origin1: this.first.ref,
            origin2: this.second.ref,
            flip: this.flip,
            offset: this.offset,
            angle: this.angle,
        };
    }
}

/**
 * Fusion's As-built Joint: the components stay where they are. Pick the joint origin on component
 * 1, then any geometry of component 2; component 2's origin is the same frame, fixed in its own
 * space, so the joint holds with every motion value at zero.
 */
@command({ key: "assemble.asBuiltJoint", icon: "icon-cFix" })
export class AsBuiltJointCommand extends JointCommandBase {
    private first: JointPick | undefined;
    private secondComponent: string | undefined;

    protected override onRestarting(): void {
        super.onRestarting();
        this.first = undefined;
        this.secondComponent = undefined;
    }

    async pick(document: IDocument, controller: AsyncController): Promise<boolean> {
        const first = await pickGeometry(document, controller, "prompt.joint.origin1", () => true);
        this.first = first === undefined ? undefined : jointPickOf(first);
        if (this.first === undefined) return false;
        const one = this.first.componentId;
        const second = await pickGeometry(
            document,
            controller,
            "prompt.joint.component2",
            (node) => componentIdOf(node) !== one,
        );
        if (second === undefined) return false;
        this.secondComponent = componentIdOf(second.owner.node);
        this.setMarkerSize(second.owner.node);
        return true;
    }

    protected jointOptions() {
        if (this.first === undefined || this.secondComponent === undefined) return undefined;
        const placed = placeJointOrigin(this.document, this.first.ref);
        if (placed === undefined) return undefined;
        const world = placed.frame.multiply(componentWorld(this.document, placed.componentId));
        const inverse = componentWorld(this.document, this.secondComponent).invert() ?? Matrix4.identity();
        return {
            document: this.document,
            name: I18n.translate("assembly.joint"),
            jointType: this.jointType,
            origin1: this.first.ref,
            origin2: fixedJointOrigin(this.secondComponent, frameOfMatrix(world.multiply(inverse))),
            // Same frame on both sides: no mate turn.
            flip: true,
        };
    }
}

/** The DOF a drive moves: the rotation where the joint has one, the main translation otherwise. */
export function primaryDof(joint: JointNode): "rotation" | "slide" | undefined {
    const dofs = jointDofs(joint.jointType);
    if (dofs.rotation) return "rotation";
    if (dofs.slide) return "slide";
    return undefined;
}

/** The range an animation sweeps: the limits, else a full turn / ±20 mm around the current value. */
export function sweepRange(joint: JointNode, dof: "rotation" | "slide", start: number): [number, number] {
    const limit = dof === "rotation" ? joint.rotationLimit() : joint.slideLimit();
    if (limit !== undefined) return [Math.min(limit.min, limit.max), Math.max(limit.min, limit.max)];
    return dof === "rotation" ? [start, start + 360] : [start - 20, start + 20];
}

/** The value `t` seconds into a back-and-forth sweep of `range` taking `period` seconds per cycle. */
export function sweepValue(range: [number, number], t: number, period = 4): number {
    const phase = (t / period) % 1;
    const s = phase < 0.5 ? phase * 2 : 2 - phase * 2;
    return range[0] + (range[1] - range[0]) * s;
}

/**
 * Drives the selected joint: its main degree of freedom follows the Value field live, and
 * Animate sweeps it back and forth between the limits (a full turn, or ±20 mm, without them).
 * Confirm keeps the value typed; Escape puts the joint back as it was.
 */
@command({ key: "assemble.driveJoint", icon: "icon-sync-alt" })
export class DriveJointCommand extends CancelableCommand {
    @property("assembly.joint.value")
    get value(): number {
        return this.getPrivateValue("value", 0);
    }
    set value(value: number) {
        this.setProperty("value", value, () => this.drive(value));
    }

    @property("assembly.joint.animate")
    get animate(): boolean {
        return this.getPrivateValue("animate", false);
    }
    set animate(value: boolean) {
        this.setProperty("animate", value, () => this.toggleAnimation(value));
    }

    private joint: JointNode | undefined;
    private dof: "rotation" | "slide" | undefined;
    private original: number | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;

    protected override async executeAsync(): Promise<void> {
        const joint = this.document.selection.getSelectedNodes().find((n) => n instanceof JointNode);
        const dof = joint === undefined ? undefined : primaryDof(joint);
        if (joint === undefined || dof === undefined) {
            PubSub.default.pub("showToast", "assembly.drive.selectJoint");
            return;
        }
        this.joint = joint;
        this.dof = dof;
        this.original = joint[dof] ?? 0;
        this.setPrivateValue("value", this.original);
        this.setPrivateValue("animate", false);
        this.emitPropertyChanged("value", this.original);
        this.controller = new AsyncController();
        const handler = new JointConfirmHandler(this.document, this.controller, () => []);
        try {
            await this.document.picker.pickAsync(
                handler,
                "prompt.joint.drive",
                this.controller,
                "none",
                "select.default",
            );
        } finally {
            handler.dispose();
        }
        this.finish(this.controller?.result?.status === "success");
    }

    private drive(value: number) {
        const joint = this.joint;
        const dof = this.dof;
        if (joint === undefined || dof === undefined) return;
        withoutHistory(this.document, () => {
            joint[dof] = value;
        });
        this.document.visual.update();
    }

    private toggleAnimation(on: boolean) {
        this.stopAnimation();
        const joint = this.joint;
        const dof = this.dof;
        if (!on || joint === undefined || dof === undefined) return;
        const range = sweepRange(joint, dof, this.value);
        const started = Date.now();
        this.timer = setInterval(() => this.drive(sweepValue(range, (Date.now() - started) / 1000)), 30);
    }

    private stopAnimation() {
        if (this.timer !== undefined) clearInterval(this.timer);
        this.timer = undefined;
    }

    /** Puts the joint back, then — when confirmed — writes the typed value as one undo step. */
    private finish(commit: boolean) {
        this.stopAnimation();
        const joint = this.joint;
        const dof = this.dof;
        if (joint === undefined || dof === undefined || this.original === undefined) return;
        const original = this.original;
        withoutHistory(this.document, () => {
            joint[dof] = original;
        });
        if (commit && this.value !== original) {
            Transaction.execute(this.document, "drive joint", () => {
                joint[dof] = this.value;
            });
        }
        this.joint = undefined;
        this.document.visual.update();
    }

    protected override afterExecute(): void {
        this.finish(false);
        super.afterExecute();
    }
}
