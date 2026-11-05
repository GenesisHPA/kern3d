// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    type AsyncController,
    BoundingBox,
    command,
    GetOrSelectNodeStep,
    type IDocument,
    type IStep,
    LENGTH_UNITS,
    Matrix4,
    MultistepCommand,
    type ParameterValue,
    PointStep,
    PubSub,
    property,
    type SnapResult,
    Transaction,
    type VisualNode,
    XYZ,
} from "@chili3d/core";
import { type DraggablePlacement, MoveGizmoHandler } from "./moveGizmo";
import {
    applyPlacement,
    confirmPlacement,
    isPlaceableNode,
    type PlacementPreviewHandler,
    type PlacementSource,
    placementBoundingBox,
} from "./placementPreview";

/** Offsets and angles of a Move/Copy, in millimetres and degrees. */
export interface MoveCopyValues {
    readonly dx: number;
    readonly dy: number;
    readonly dz: number;
    readonly rx: number;
    readonly ry: number;
    readonly rz: number;
}

/**
 * The world-space move of a Move/Copy: turn about the world X, then Y, then Z axis through
 * `pivot`, then translate. Matrices compose left to right (row vectors), so the product
 * reads in the order the steps happen.
 */
export function moveCopyMatrix(values: MoveCopyValues, pivot: XYZ): Matrix4 {
    const toRad = Math.PI / 180;
    let result = Matrix4.identity();
    const turns: [XYZ, number][] = [
        [XYZ.unitX, values.rx],
        [XYZ.unitY, values.ry],
        [XYZ.unitZ, values.rz],
    ];
    for (const [axis, degrees] of turns) {
        if (degrees !== 0) result = result.multiply(Matrix4.fromAxisRad(pivot, axis, degrees * toRad));
    }
    return result.multiply(Matrix4.fromTranslation(values.dx, values.dy, values.dz));
}

/**
 * Move/Copy (free move by values): select bodies, then type ΔX ΔY ΔZ and turns
 * about X/Y/Z while the moved bodies show where they will land; confirm commits. The turns
 * pivot on the selection's bounding-box centre, or on a picked point.
 */
@command({ key: "modify.moveCopy", icon: "icon-move" })
export class MoveCopyCommand extends MultistepCommand implements DraggablePlacement {
    @property("option.command.moveX", { unit: LENGTH_UNITS })
    get dx(): ParameterValue {
        return this.getPrivateValue("dx", 0);
    }
    set dx(value: ParameterValue) {
        this.setProperty("dx", value, () => this._preview?.refresh());
    }

    @property("option.command.moveY", { unit: LENGTH_UNITS })
    get dy(): ParameterValue {
        return this.getPrivateValue("dy", 0);
    }
    set dy(value: ParameterValue) {
        this.setProperty("dy", value, () => this._preview?.refresh());
    }

    @property("option.command.moveZ", { unit: LENGTH_UNITS })
    get dz(): ParameterValue {
        return this.getPrivateValue("dz", 0);
    }
    set dz(value: ParameterValue) {
        this.setProperty("dz", value, () => this._preview?.refresh());
    }

    @property("option.command.rotateX", { unit: ANGLE_UNITS })
    get rx(): ParameterValue {
        return this.getPrivateValue("rx", 0);
    }
    set rx(value: ParameterValue) {
        this.setProperty("rx", value, () => this._preview?.refresh());
    }

    @property("option.command.rotateY", { unit: ANGLE_UNITS })
    get ry(): ParameterValue {
        return this.getPrivateValue("ry", 0);
    }
    set ry(value: ParameterValue) {
        this.setProperty("ry", value, () => this._preview?.refresh());
    }

    @property("option.command.rotateZ", { unit: ANGLE_UNITS })
    get rz(): ParameterValue {
        return this.getPrivateValue("rz", 0);
    }
    set rz(value: ParameterValue) {
        this.setProperty("rz", value, () => this._preview?.refresh());
    }

    @property("option.command.pickPivot")
    get pickPivot(): boolean {
        return this.getPrivateValue("pickPivot", false);
    }
    set pickPivot(value: boolean) {
        if (!this.setProperty("pickPivot", value)) return;
        // The pivot pick is a step of its own; restart so the step list matches. Only while
        // a step runs: restoring the cached value before the run must not commit twice.
        if (this.controller !== undefined) void this.restart();
    }

    @property("common.clone")
    get isClone(): boolean {
        return this.getPrivateValue("isClone", false);
    }
    set isClone(value: boolean) {
        this.setProperty("isClone", value, () => this._preview?.refresh());
    }

    private _preview: PlacementPreviewHandler | undefined;
    private _pivot: XYZ | undefined;
    private _lastError: string | undefined;

    get models(): readonly VisualNode[] {
        return (this.stepDatas[0]?.nodes ?? []) as unknown as VisualNode[];
    }

    protected override getSteps(): IStep[] {
        const steps: IStep[] = [
            new GetOrSelectNodeStep("prompt.select.models", {
                multiple: true,
                filter: { allow: isPlaceableNode },
            }),
        ];
        if (this.pickPivot) steps.push(new PointStep("prompt.moveCopy.pivot", undefined, true));
        steps.push(new MoveCopyConfirmStep(this));
        return steps;
    }

    protected override onRestarting(): void {
        super.onRestarting();
        this._pivot = undefined;
    }

    setPreview(preview: PlacementPreviewHandler | undefined): void {
        this._preview = preview;
    }

    /** The picked point, or the centre of the selection's bounding box. */
    pivot(): XYZ {
        if (this.pickPivot && this.stepDatas[1]?.point !== undefined) return this.stepDatas[1].point;
        this._pivot ??= BoundingBox.center(placementBoundingBox(this.models));
        return this._pivot;
    }

    /** The values typed so far, resolved; undefined (with a toast) when one does not resolve. */
    values(): MoveCopyValues | undefined {
        const resolved: Record<keyof MoveCopyValues, number> = { dx: 0, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0 };
        for (const key of ["dx", "dy", "dz"] as const) {
            const value = this.resolveParameter(this[key], LENGTH_UNITS);
            if (!value.isOk) return this.report(value.error);
            resolved[key] = value.value;
        }
        for (const key of ["rx", "ry", "rz"] as const) {
            const value = this.resolveParameter(this[key], ANGLE_UNITS);
            if (!value.isOk) return this.report(value.error);
            resolved[key] = value.value;
        }
        this._lastError = undefined;
        return resolved;
    }

    /** The translation typed or dragged so far (zero while a value does not resolve). */
    offset(): XYZ {
        const v = this.values();
        return v === undefined ? XYZ.zero : new XYZ({ x: v.dx, y: v.dy, z: v.dz });
    }

    /** The gizmo's drag: the three offsets at once, redrawn once. */
    setOffset(offset: XYZ): void {
        const round = (x: number) => Math.round(x * 1000) / 1000;
        // each value tells the panel; the preview is rebuilt once, after all three
        this.setProperty("dx", round(offset.x));
        this.setProperty("dy", round(offset.y));
        this.setProperty("dz", round(offset.z));
        this._preview?.refresh();
    }

    transform(): Matrix4 | undefined {
        const values = this.values();
        return values === undefined ? undefined : moveCopyMatrix(values, this.pivot());
    }

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
        Transaction.execute(this.document, "move/copy", () => {
            applyPlacement(this.models, transform, this.isClone);
            this.document.visual.update();
        });
    }
}

class MoveCopyConfirmStep implements IStep {
    constructor(private readonly command: MoveCopyCommand) {}

    execute(document: IDocument, controller: AsyncController): Promise<SnapResult | undefined> {
        return confirmPlacement(
            document,
            controller,
            this.command,
            "prompt.moveCopy.confirm",
            (preview) => this.command.setPreview(preview),
            (d, c) => new MoveGizmoHandler(d, c, this.command),
        );
    }
}
