// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    Config,
    command,
    I18n,
    type IDocument,
    type IFace,
    LENGTH_UNITS,
    type ParameterValue,
    Plane,
    PubSub,
    property,
    Transaction,
} from "@chili3d/core";
import { type PlaneFrame, sectionProfiles } from "../scanTools/sectionSketch";
import { PlanePickHandler, type PlanePickResult } from "../sketch/commands/planePickHandler";
import { sketchPlaneOfFace } from "../sketch/planeRef";
import { SketchNode } from "../sketch/sketchNode";
import { sketchDataOf } from "../stlRebuild/build";
import { pickMeshSources, worldMesh } from "./scanCommon";

/** The picked plane in world coordinates: a face's (as a sketch on it), a datum's, a datum plane node's. */
export function planeOfPick(document: IDocument, result: PlanePickResult): Plane {
    if (result.kind !== "face") return result.plane;
    const face = result.data.shape.transformedMul(result.data.transform) as IFace;
    try {
        return sketchPlaneOfFace(face);
    } finally {
        face.dispose();
    }
}

/** `plane` moved `offset` along its normal, frame kept. */
export function offsetPlane(plane: Plane, offset: number): Plane {
    if (offset === 0) return plane;
    return new Plane({
        origin: plane.origin.add(plane.normal.multiply(offset)),
        normal: plane.normal,
        xvec: plane.xvec,
    });
}

export function frameOf(plane: Plane): PlaneFrame {
    const v = (p: { x: number; y: number; z: number }) => [p.x, p.y, p.z] as [number, number, number];
    return { origin: v(plane.origin), normal: v(plane.normal), xvec: v(plane.xvec) };
}

/**
 * «Сечение сетки → эскиз»: an imported mesh (or a body) cut by a plane the user picks — a face,
 * a construction plane or a principal one, moved by «Смещение» along its normal — and the
 * section written as an editable sketch on that plane: lines, arcs and circles fitted to the
 * cut (`sectionProfiles`; a scan's noise is read off the mesh and widens the tolerance), joined
 * end to end, straight walls horizontal or vertical, every round a radius dimension — ready to
 * extrude or revolve. The mesh is not touched.
 */
@command({
    key: "scan.sectionSketch",
    icon: "icon-section",
    isEnabled: () => Config.instance.scanSectionSketch,
})
export class ScanSectionSketchCommand extends CancelableCommand {
    @property("scan.section.offset", { unit: LENGTH_UNITS })
    get offset(): ParameterValue {
        return this.getPrivateValue("offset", 0);
    }
    set offset(value: ParameterValue) {
        this.setProperty("offset", value);
    }

    protected async executeAsync(): Promise<void> {
        const document = this.document;
        const sources = await pickMeshSources(document);
        if (sources === undefined || this.checkCanceled()) return;
        const source = sources[0];
        document.selection.clearSelection();
        this.controller = new AsyncController();
        const handler = new PlanePickHandler(document, this.controller);
        try {
            await document.picker.pickAsync(
                handler,
                "prompt.select.plane",
                this.controller,
                "none",
                "select.default",
            );
        } finally {
            handler.dispose();
        }
        const picked = handler.result;
        if (picked === undefined || this.checkCanceled()) return;
        const offset = this.resolveParameter(this.offset, LENGTH_UNITS);
        const plane = offsetPlane(planeOfPick(document, picked), offset.isOk ? offset.value : 0);
        const result = sectionProfiles(worldMesh(source), frameOf(plane));
        if (result.profiles.length === 0) {
            PubSub.default.pub(
                "showToast",
                result.loops === 0 ? "toast.scan.section.empty" : "toast.scan.section.unfitted",
            );
            return;
        }
        Transaction.execute(document, "scan.sectionSketch", () => {
            const sketch = new SketchNode({
                document,
                plane,
                data: sketchDataOf(plane, result.profiles, result.tol),
            });
            sketch.name = I18n.translate("scan.section.sketchName{0}", source.name);
            document.modelManager.addNode(sketch);
            document.selection.setSelectedNodes([sketch], false);
        });
        document.visual.update();
        PubSub.default.pub(
            "showToast",
            "toast.scan.section{0}{1}{2}",
            result.profiles.length,
            result.tol.toFixed(3),
            result.unfitted,
        );
    }
}
