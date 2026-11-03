// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Combobox,
    type I18nKeys,
    type IDocument,
    Id,
    type INode,
    Node,
    PubSub,
    property,
    serializable,
    serialize,
} from "@chili3d/core";
import type { JointStatus } from "./assemblySolver";
import {
    clampToLimit,
    JOINT_TYPE_KEYS,
    JOINT_TYPES,
    type JointLimit,
    type JointMotion,
    type JointType,
    jointDofs,
    jointTypeOfKey,
} from "./jointMath";
import type { JointOriginRef } from "./jointOrigin";

export interface JointNodeOptions {
    document: IDocument;
    name: string;
    id?: string;
    jointType?: JointType;
    origin1?: JointOriginRef | string;
    origin2?: JointOriginRef | string;
    flip?: boolean;
    offset?: number;
    angle?: number;
}

/**
 * Called with the document of every joint constructed — how the assembly solver starts for a
 * document (`assemblyService.ts` registers itself; importing it here would close a cycle).
 */
export const jointCreatedHooks = new Set<(document: IDocument) => void>();

function originJson(origin: JointOriginRef | string): string {
    return typeof origin === "string" ? origin : JSON.stringify(origin);
}

const STATUS_KEYS: Record<Exclude<JointStatus, "ok">, I18nKeys> = {
    conflict: "assembly.joint.status.conflict",
    invalid: "assembly.joint.status.invalid",
    cycle: "assembly.joint.status.cycle",
};

/** Properties whose change shows or hides other rows of the property panel. */
const LAYOUT_PROPERTIES = new Set(["jointType", "rotationLimited", "slideLimited"]);

/**
 * A joint between two assembly components: two joint origins, the joint type and its options,
 * and the current value of each degree of freedom. It has no geometry of its own — the assembly
 * solver (`assemblyService.ts`) reads it and places component 2 (or 1, whichever is not fixed)
 * so that origin 2 lands on origin 1 moved by the joint's motion.
 *
 * Persisted as a plain node: `{ __cla$$__: "JointNode", id, name, visible, userData, jointType,
 * origin1, origin2 (both JSON), flip, offset, angle, the DOF values and the limits }`. A DOF the
 * type does not have reads undefined (the property panel then hides its row) and is not stored.
 */
@serializable()
export class JointNode extends Node {
    /** Set by the solver; not persisted. */
    private _status: JointStatus = "ok";
    private _originLost = false;

    constructor(options: JointNodeOptions) {
        super(options.document, options.name, options.id ?? Id.generate());
        this.setPrivateValue("jointType", options.jointType ?? "rigid");
        // A document hands the stored JSON straight back; a command hands the ref.
        if (options.origin1 !== undefined) this.setPrivateValue("origin1", originJson(options.origin1));
        if (options.origin2 !== undefined) this.setPrivateValue("origin2", originJson(options.origin2));
        if (options.flip !== undefined) this.setPrivateValue("flip", options.flip);
        if (options.offset !== undefined) this.setPrivateValue("offset", options.offset);
        if (options.angle !== undefined) this.setPrivateValue("angle", options.angle);
        for (const hook of jointCreatedHooks) hook(options.document);
    }

    get icon(): string {
        return "icon-cCoincident";
    }

    // ------------------------------------------------------------------ Definition

    @serialize()
    get jointType(): JointType {
        return this.getPrivateValue("jointType", "rigid");
    }
    set jointType(value: JointType) {
        if (!JOINT_TYPES.includes(value)) return;
        this.setProperty("jointType", value);
    }

    /** The type as the panel's dropdown shows it. */
    @property("assembly.joint.type", { combobox: Combobox.from(JOINT_TYPES.map((t) => JOINT_TYPE_KEYS[t])) })
    get typeKey(): I18nKeys {
        return JOINT_TYPE_KEYS[this.jointType];
    }
    set typeKey(value: I18nKeys) {
        const type = jointTypeOfKey(value);
        if (type !== undefined) this.jointType = type;
    }

    @serialize()
    get origin1(): string {
        return this.getPrivateValue("origin1", "");
    }
    set origin1(value: string) {
        this.setProperty("origin1", value);
    }

    @serialize()
    get origin2(): string {
        return this.getPrivateValue("origin2", "");
    }
    set origin2(value: string) {
        this.setProperty("origin2", value);
    }

    originRef(side: 1 | 2): JointOriginRef | undefined {
        const json = side === 1 ? this.origin1 : this.origin2;
        if (json === "") return undefined;
        try {
            return JSON.parse(json) as JointOriginRef;
        } catch {
            return undefined;
        }
    }

    @serialize()
    @property("option.command.flip")
    get flip(): boolean {
        return this.getPrivateValue("flip", false);
    }
    set flip(value: boolean) {
        this.setProperty("flip", value);
    }

    @serialize()
    @property("assembly.joint.offset")
    get offset(): number {
        return this.getPrivateValue("offset", 0);
    }
    set offset(value: number) {
        this.setNumber("offset", value);
    }

    @serialize()
    @property("assembly.joint.angle")
    get angle(): number {
        return this.getPrivateValue("angle", 0);
    }
    set angle(value: number) {
        this.setNumber("angle", value);
    }

    // ------------------------------------------------------------------ Degrees of freedom

    @serialize()
    @property("assembly.joint.rotation")
    get rotation(): number | undefined {
        if (!jointDofs(this.jointType).rotation) return undefined;
        return this.getPrivateValue("rotation", 0);
    }
    set rotation(value: number | undefined) {
        this.setNumber("rotation", clampToLimit(value ?? 0, this.rotationLimit()));
    }

    @serialize()
    @property("assembly.joint.slide")
    get slide(): number | undefined {
        if (!jointDofs(this.jointType).slide) return undefined;
        return this.getPrivateValue("slide", 0);
    }
    set slide(value: number | undefined) {
        this.setNumber("slide", clampToLimit(value ?? 0, this.slideLimit()));
    }

    @serialize()
    @property("assembly.joint.slide2")
    get slide2(): number | undefined {
        if (!jointDofs(this.jointType).slide2) return undefined;
        return this.getPrivateValue("slide2", 0);
    }
    set slide2(value: number | undefined) {
        this.setNumber("slide2", value ?? 0);
    }

    @serialize()
    @property("assembly.joint.pitch")
    get pitch(): number | undefined {
        if (!jointDofs(this.jointType).ball) return undefined;
        return this.getPrivateValue("pitch", 0);
    }
    set pitch(value: number | undefined) {
        this.setNumber("pitch", value ?? 0);
    }

    @serialize()
    @property("assembly.joint.yaw")
    get yaw(): number | undefined {
        if (!jointDofs(this.jointType).ball) return undefined;
        return this.getPrivateValue("yaw", 0);
    }
    set yaw(value: number | undefined) {
        this.setNumber("yaw", value ?? 0);
    }

    // ------------------------------------------------------------------ Limits

    /** Whether the type's rotation can be limited — Fusion limits revolute-like rotations only. */
    private get rotationLimitable(): boolean {
        return jointDofs(this.jointType).rotation && this.jointType !== "ball";
    }

    @serialize()
    @property("assembly.joint.rotationLimited")
    get rotationLimited(): boolean | undefined {
        return this.rotationLimitable ? this.getPrivateValue("rotationLimited", false) : undefined;
    }
    set rotationLimited(value: boolean | undefined) {
        this.setProperty("rotationLimited", value === true);
    }

    @serialize()
    @property("assembly.joint.rotationMin")
    get rotationMin(): number | undefined {
        return this.rotationLimited ? this.getPrivateValue("rotationMin", 0) : undefined;
    }
    set rotationMin(value: number | undefined) {
        this.setNumber("rotationMin", value ?? 0);
    }

    @serialize()
    @property("assembly.joint.rotationMax")
    get rotationMax(): number | undefined {
        return this.rotationLimited ? this.getPrivateValue("rotationMax", 90) : undefined;
    }
    set rotationMax(value: number | undefined) {
        this.setNumber("rotationMax", value ?? 90);
    }

    @serialize()
    @property("assembly.joint.slideLimited")
    get slideLimited(): boolean | undefined {
        return jointDofs(this.jointType).slide ? this.getPrivateValue("slideLimited", false) : undefined;
    }
    set slideLimited(value: boolean | undefined) {
        this.setProperty("slideLimited", value === true);
    }

    @serialize()
    @property("assembly.joint.slideMin")
    get slideMin(): number | undefined {
        return this.slideLimited ? this.getPrivateValue("slideMin", 0) : undefined;
    }
    set slideMin(value: number | undefined) {
        this.setNumber("slideMin", value ?? 0);
    }

    @serialize()
    @property("assembly.joint.slideMax")
    get slideMax(): number | undefined {
        return this.slideLimited ? this.getPrivateValue("slideMax", 10) : undefined;
    }
    set slideMax(value: number | undefined) {
        this.setNumber("slideMax", value ?? 10);
    }

    rotationLimit(): JointLimit | undefined {
        if (!this.rotationLimited) return undefined;
        return { enabled: true, min: this.rotationMin ?? 0, max: this.rotationMax ?? 0 };
    }

    slideLimit(): JointLimit | undefined {
        if (!this.slideLimited) return undefined;
        return { enabled: true, min: this.slideMin ?? 0, max: this.slideMax ?? 0 };
    }

    /** Everything the motion matrix needs, read off the node. */
    motion(): JointMotion {
        return {
            type: this.jointType,
            flip: this.flip,
            offset: this.offset,
            angle: this.angle,
            rotation: this.rotation ?? 0,
            slide: this.slide ?? 0,
            slide2: this.slide2 ?? 0,
            pitch: this.pitch ?? 0,
            yaw: this.yaw ?? 0,
            rotationLimit: this.rotationLimit(),
            slideLimit: this.slideLimit(),
        };
    }

    // ------------------------------------------------------------------ Solver state

    get status(): JointStatus {
        return this._status;
    }

    /** True while an origin's geometry cannot be found and its last frame stands in. */
    get originLost(): boolean {
        return this._originLost;
    }

    /** The solver reports the outcome; the row's warning badge follows it. */
    setSolveState(status: JointStatus, originLost: boolean): void {
        if (this._status === status && this._originLost === originLost) return;
        const old = this.warningCount;
        this._status = status;
        this._originLost = originLost;
        this.emitPropertyChanged("warningCount" as keyof this, old as never);
    }

    /** `INodeWarning`. */
    get warningCount(): number {
        return this._status !== "ok" || this._originLost ? 1 : 0;
    }

    get warningTooltip(): I18nKeys {
        if (this._status !== "ok") return STATUS_KEYS[this._status];
        return "assembly.joint.status.originLost";
    }

    // ------------------------------------------------------------------ Plumbing

    private setNumber(key: keyof this, value: number) {
        if (!Number.isFinite(value)) return;
        this.setProperty(key, value as never);
    }

    protected override emitPropertyChanged<K extends keyof this>(property: K, oldValue: this[K]): void {
        super.emitPropertyChanged(property, oldValue);
        if (LAYOUT_PROPERTIES.has(property as string)) this.refreshPanel();
    }

    /** Rows appear and disappear with the type and the limit toggles: redraw the panel. */
    private refreshPanel() {
        const selection = this.document?.selection as { getSelectedNodes?: () => INode[] } | undefined;
        const selected = selection?.getSelectedNodes?.();
        if (selected?.includes(this)) PubSub.default.pub("showProperties", this.document, selected);
    }

    protected onVisibleChanged(): void {}

    protected onParentVisibleChanged(): void {}
}
