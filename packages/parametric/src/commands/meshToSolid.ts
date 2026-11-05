// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IShape, type IShell, Result, ShapeTypes } from "@chili3d/core";

/**
 * An STL's triangles as a part: sewn into a shell, closed into a solid when the shell is
 * watertight, and every run of triangles on one plane merged into one face (OCCT's
 * UnifySameDomain) — a box from an STL comes out as six faces again, not twelve triangles.
 * Curved surfaces stay faceted: the triangles only approximate them, there is no exact
 * cylinder in the file to recover. Returns the input untouched when sewing fails.
 */
export function meshToSolid(shape: IShape): Result<IShape> {
    const sewn = shapeFactory.sewing([shape]);
    if (!sewn.isOk) return Result.err(sewn.error);
    let result: IShape = sewn.value;
    // a closed shell (or several) becomes a solid; an open one stays a surface
    const shells = result.findSubShapes(ShapeTypes.shell) as IShell[];
    if (shells.length > 0) {
        const solid = shapeFactory.solid(shells);
        if (solid.isOk && solid.value.volume() > 0) {
            result.dispose();
            result = solid.value;
        }
    }
    // planar triangles merged; the angular tolerance lets near-flat STL noise merge too
    const merged = shapeFactory.simplifyShape(result, true, true, [], 1e-3, (0.5 * Math.PI) / 180);
    if (merged.isOk && !merged.value.isNull()) {
        result.dispose();
        result = merged.value;
    }
    return Result.ok(result);
}
