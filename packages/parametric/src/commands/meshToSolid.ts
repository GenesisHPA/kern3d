// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IShape, type IShell, Result, ShapeTypes } from "@chili3d/core";
import { recoverCylinders } from "./recoverCylinders";

/** A compound holding one solid and nothing else, as that solid. */
function singleSolid(shape: IShape): IShape {
    if (shape.shapeType !== ShapeTypes.compound) return shape;
    const solids = shape.findSubShapes(ShapeTypes.solid);
    const shells = shape.findSubShapes(ShapeTypes.shell);
    const solidShells = solids.reduce((n, s) => n + s.findSubShapes(ShapeTypes.shell).length, 0);
    return solids.length === 1 && shells.length === solidShells ? solids[0] : shape;
}

function volumeOf(shape: IShape): number {
    return shape.findSubShapes(ShapeTypes.solid).reduce((v, s) => v + s.volume(), 0);
}

/**
 * Coplanar triangles merged into faces (OCCT's UnifySameDomain), then healed (ShapeFix): the
 * merge can leave a face whose boundary touches itself at a vertex, which the checker calls
 * unorientable and the booleans trip on. A merge that will not heal into a valid solid is
 * dropped — the triangles stay, valid.
 */
function unify(shape: IShape): IShape {
    const merged = shapeFactory.simplifyShape(shape, true, true, [], 1e-4, (0.1 * Math.PI) / 180);
    if (!merged.isOk || merged.value.isNull()) return shape;
    let result = merged.value;
    if (!result.checkShape()) {
        const healed = result.fixShape(1e-6);
        if (!healed.isNull() && healed !== result) {
            result.dispose();
            result = healed;
        }
    }
    if (!result.checkShape()) {
        result.dispose();
        return shape;
    }
    shape.dispose();
    return result;
}

/** Up to this many faces (after planar merging) cylinders are recovered on import, in a second or two. */
export const RECOVER_ON_IMPORT_FACES = 4000;

/**
 * An STL's triangles as a part: sewn into a shell, closed into a solid when the shell is
 * watertight, and every run of triangles on one plane merged into one face (OCCT's
 * UnifySameDomain) — a box from an STL comes out as six faces again, not twelve triangles.
 * Cylindrical runs of facets — holes, bosses, shafts, rounds — are then fitted and replaced
 * by exact cylinders (`recoverCylinders`); other curved surfaces stay faceted.
 */
export function meshToSolid(shape: IShape, recover: "auto" | "never" = "auto"): Result<IShape> {
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
    result = unify(result);
    // runs of facets on a cylinder (holes, bosses, rounds) replaced by the exact surface,
    // then whatever the booleans split merged again
    const small = result.findSubShapes(ShapeTypes.face).length <= RECOVER_ON_IMPORT_FACES;
    if (recover === "auto" && small && result.findSubShapes(ShapeTypes.solid).length > 0) {
        const recovered = recoverCylindersChecked(result);
        if (recovered !== result) result = unify(recovered);
    }
    return Result.ok(singleSolid(result));
}

/**
 * Cylinders recovered on a solid (see `recoverCylinders`), kept only when the result is a valid
 * solid whose volume moved by less than 3 % — the slivers between facets and the true surface,
 * never a lost or added feature. Otherwise the solid comes back as it was.
 */
export function recoverCylindersChecked(solid: IShape, budgetMs?: number): IShape {
    const recovered = recoverCylinders(solid, budgetMs);
    const before = volumeOf(solid);
    const after = volumeOf(recovered.shape);
    const sane = before > 0 && Math.abs(after - before) <= before * 0.03;
    if (recovered.count > 0 && sane && recovered.shape.checkShape()) return singleSolid(recovered.shape);
    if (recovered.shape !== solid) recovered.shape.dispose();
    return solid;
}

/** A solid's planar runs merged into faces again (after a recovery split them). */
export function mergePlanarFaces(shape: IShape): IShape {
    return unify(shape);
}
