// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, Dimensions, formatMeasurement, type IStep, type XYZ } from "@chili3d/core";
import { ConstraintKind, type SketchConstraintData } from "../sketchModel";
import { SketchMultistepCommand } from "./sketchMultistepCommand";
import { type SketchPointSnapData, SketchPointStep } from "./sketchPointStep";

/** Circle params in sketch uv: `center` and the radius out to a rim point `rim`. */
function circleParams(center: [number, number], rim: [number, number]): [number, number, number] {
    return [center[0], center[1], Math.hypot(rim[0] - center[0], rim[1] - center[1])];
}

@command({ key: "sketch.circle", icon: "icon-circle" })
export class SketchCircleCommand extends SketchMultistepCommand {
    getSteps(): IStep[] {
        return [
            new SketchPointStep("prompt.pickCircleCenter"),
            new SketchPointStep("prompt.pickDiameter", this.getRadiusData),
        ];
    }

    /** A typed number was the diameter, so the dimension it leaves reads Ø too. */
    protected override typedDimensions(entityId: number): Omit<SketchConstraintData, "id">[] {
        return super
            .typedDimensions(entityId)
            .map((dimension) =>
                dimension.kind === ConstraintKind.Radius ? { ...dimension, display: "diameter" } : dimension,
            );
    }

    protected executeMainTask(): void {
        const [cx, cy, radius] = circleParams(this.uvOf(0), this.uvOf(1));
        this.commitNewEntity(this.editor.solver.addCircle(cx, cy, radius));
    }

    private readonly getRadiusData = (): SketchPointSnapData => ({
        refPoint: () => this.stepDatas[0].point!,
        dimension: Dimensions.D1,
        // the circle is sized by its diameter: a typed number is the diameter, the tip reads Ø
        inputScale: 0.5,
        prompt: (snaped) =>
            snaped.point === undefined
                ? ""
                : formatMeasurement(
                      "diameter",
                      this.editor.node.plane.projectDistance(this.stepDatas[0].point!, snaped.point) * 2,
                  ),
        preview: this.circlePreview,
        tentative: (probe) => ({ type: "circle", params: circleParams(this.uvOf(0), probe) }),
    });

    private readonly circlePreview = (point: XYZ | undefined) => {
        const center = this.stepDatas[0].point!;
        if (point === undefined) {
            return [this.meshPoint(center)];
        }
        const plane = this.editor.node.plane;
        return [
            this.meshPoint(center),
            this.meshLine(center, point),
            this.meshCreatedShape("circle", plane.normal, center, plane.projectDistance(center, point)),
        ];
    };
}
