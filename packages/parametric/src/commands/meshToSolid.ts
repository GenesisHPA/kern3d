// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IShape, type IShell, type IVertex, Result, ShapeTypes } from "@chili3d/core";
import { isSliverShell } from "../features/offsetCavity";
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

interface SewnShell {
    shell: IShell;
    volume: number;
}

/**
 * The closed shells of a sewn mesh as solids — undefined when a shell is open (the mesh stays a
 * surface) or nothing encloses any volume.
 *
 * NOT all of them in one solid, which is what a bare `solid(shells)` makes: every shell after
 * the first becomes a "cavity" of it whatever it really is. Instead each shell is measured on
 * its own: a sliver (`isSliverShell`) is dropped; a shell oriented like the largest one is a
 * separate part and gets a solid of its own; one oriented against it encloses a real void (an
 * STL's triangles face out of the material, so a void's face into it) and stays a cavity of the
 * smallest part whose box holds it. Several parts come back as a compound of solids.
 *
 * Nothing here meshes the shells (`IShape.boundingBox` does, and meshing a 124 000-triangle
 * shell traps the kernel): areas are read only off the smaller shells, boxes off the vertices.
 */
export function solidsOfShells(shells: readonly IShell[]): IShape | undefined {
    const measured: SewnShell[] = [];
    for (const shell of shells) {
        if (!shell.isClosed()) return undefined;
        const alone = shapeFactory.solid([shell]);
        if (!alone.isOk) return undefined;
        measured.push({ shell, volume: alone.value.volume() });
        alone.value.dispose();
    }
    const largest = measured.reduce((a, b) => (Math.abs(b.volume) > Math.abs(a.volume) ? b : a));
    if (largest.volume === 0) return undefined;
    const kept = measured.filter((m) => m === largest || !isSliverShell(m.shell, m.volume));
    const sign = Math.sign(largest.volume);
    const parts = kept.filter((m) => Math.sign(m.volume) === sign);
    const voids = new Map<SewnShell, IShell[]>(parts.map((p) => [p, []]));
    const cavities = kept.filter((m) => Math.sign(m.volume) !== sign);
    const boxes = new Map(cavities.length === 0 ? [] : kept.map((m) => [m, vertexBox(m.shell)]));
    for (const cavity of cavities) {
        const holder = parts
            .filter((p) => boxHolds(boxes.get(p)!, boxes.get(cavity)!))
            .sort((a, b) => Math.abs(a.volume) - Math.abs(b.volume))[0];
        holder && voids.get(holder)!.push(cavity.shell);
    }
    const solids: IShape[] = [];
    for (const part of parts) {
        const solid = shapeFactory.solid([part.shell, ...voids.get(part)!]);
        if (solid.isOk && solid.value.volume() > 0) solids.push(solid.value);
    }
    if (solids.length <= 1) return solids[0];
    const compound = shapeFactory.combine(solids);
    return compound.isOk ? compound.value : undefined;
}

type Box = { min: [number, number, number]; max: [number, number, number] };

function vertexBox(shell: IShell): Box {
    const box: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const vertex of shell.findSubShapes(ShapeTypes.vertex) as IVertex[]) {
        const p = vertex.point();
        [p.x, p.y, p.z].forEach((v, k) => {
            box.min[k] = Math.min(box.min[k], v);
            box.max[k] = Math.max(box.max[k], v);
        });
    }
    return box;
}

function boxHolds(outer: Box, inner: Box): boolean {
    return [0, 1, 2].every((k) => outer.min[k] <= inner.min[k] && inner.max[k] <= outer.max[k]);
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
    // closed shells become solids (one per separate part, each with its real voids); an open
    // one stays a surface
    const shells = result.findSubShapes(ShapeTypes.shell) as IShell[];
    if (shells.length > 0) {
        const solid = solidsOfShells(shells);
        if (solid !== undefined) {
            result.dispose();
            result = solid;
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
