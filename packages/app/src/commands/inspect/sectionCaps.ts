// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { BoundingBox, type IShape, Plane } from "@chili3d/core";

/**
 * The faces a section plane cuts out of a solid — the caps that make a clipped view read as
 * solid rather than as a hollow skin. A rectangle on the plane, larger than the shape, is
 * intersected with it (boolean common of a solid and a face keeps the part of the face inside
 * the solid). Undefined when the plane misses the shape or the kernel finds nothing.
 */
export function sectionCap(shape: IShape, plane: Plane): IShape | undefined {
    const box = shape.boundingBox();
    if (!BoundingBox.isValid(box)) return undefined;
    const size = BoundingBox.diagonal(box) * 2 + 1;
    const center = plane.project(BoundingBox.center(box));
    const corner = center.sub(plane.xvec.multiply(size / 2)).sub(plane.yvec.multiply(size / 2));
    const rect = shapeFactory.rect(
        new Plane({ origin: corner, normal: plane.normal, xvec: plane.xvec }),
        size,
        size,
    );
    if (!rect.isOk) return undefined;
    const common = shapeFactory.booleanCommon([shape], [rect.value]);
    rect.value.dispose();
    if (!common.isOk) return undefined;
    if (!common.value.mesh.faces?.index.length) {
        common.value.dispose();
        return undefined;
    }
    return common.value;
}
