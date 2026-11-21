// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IFace,
    type IShape,
    type IShell,
    type IVertex,
    type OffsetFaceProblem,
    Result,
    type ShapeType,
    ShapeTypes,
    type TrackedShape,
} from "@chili3d/core";

/** The status a move of a cavity's OWN wall is refused with (the kernel's codes stop at 7). */
export const CAVITY_WALL_STATUS = 8;
/** The status a body of several separate solids is refused with. */
export const SEVERAL_SOLIDS_STATUS = 9;

/**
 * Offset Face on any solid, including one with a sealed cavity inside.
 *
 * The kernel's offset refuses a solid of more than one shell (status 4): `BRepOffset_MakeOffset`
 * answers not-done at every distance on one. A cavity, though, is untouched by moving the OUTER
 * skin's faces — so the outer shell is offset on its own (a solid of that shell alone, whose faces
 * are the input's own faces, which is what the kernel matches picks by), and the solid is made
 * again from the moved skin plus the cavities exactly as they were. That is only sound while
 * every cavity stays strictly inside the moved skin without touching it; one the move would run
 * into is refused with the kernel's own "sealed void" status, which then means just that.
 *
 * A pick on a cavity's wall is not handled (status 8), nor is a body of several separate solids
 * (status 9): the feature words both.
 *
 * The history is the kernel's, re-indexed: an input index of the outer solid maps to the face
 * (edge) of the whole input it is, and an output index of the moved skin to the face of the
 * rebuilt solid; every cavity face derives from itself.
 */
export function offsetFacesKeepingCavities(
    shape: IShape,
    faces: IFace[],
    distance: number,
    rounds: IFace[],
    requireRounds: boolean,
): Result<TrackedShape, OffsetFaceProblem> {
    const offset = shapeFactory.offsetFacesTracked!;
    const solids = shape.findSubShapes(ShapeTypes.solid);
    const shells = shape.findSubShapes(ShapeTypes.shell) as IShell[];
    if (solids.length > 1) {
        // slivers an older STL import left beside the part (as solids of their own once healed)
        // are no parts: the move goes on the one real solid, and they are left out
        const real = solids.filter(
            (solid) =>
                !solid
                    .findSubShapes(ShapeTypes.shell)
                    .every((shell) => isSliverShell(shell as IShell, solid.volume())),
        );
        if (real.length !== 1) return Result.err({ status: SEVERAL_SOLIDS_STATUS, maxDistance: 0 });
        const moved = offsetFacesKeepingCavities(real[0], faces, distance, rounds, requireRounds);
        if (!moved.isOk) return moved;
        // the history's inputs are indices of that solid; the caller's are of the whole input
        const toInput = (type: ShapeType, pairs: number[]) => {
            const map = matchIndices(real[0].findSubShapes(type), shape.findSubShapes(type));
            const out: number[] = [];
            for (let i = 0; i + 1 < pairs.length; i += 2) {
                const from = map[pairs[i + 1]] ?? -1;
                if (from >= 0) out.push(pairs[i], from);
            }
            return out;
        };
        return Result.ok({
            shape: moved.value.shape,
            faceAncestors: toInput(ShapeTypes.face, moved.value.faceAncestors),
            edgeAncestors: toInput(ShapeTypes.edge, moved.value.edgeAncestors),
        });
    }
    if (solids.length !== 1 || shells.length < 2)
        return offset(shape, faces, distance, rounds, requireRounds);

    const outerIndex = outerShellIndex(shells);
    if (outerIndex < 0) return Result.err({ status: 4, maxDistance: 0 });
    const outer = shells[outerIndex];
    const outerFaces = outer.findSubShapes(ShapeTypes.face);
    const onOuter = (face: IFace) => outerFaces.some((f) => f.isSame(face));
    if (!faces.every(onOuter)) return Result.err({ status: CAVITY_WALL_STATUS, maxDistance: 0 });

    const skin = shapeFactory.solid([outer]);
    if (!skin.isOk) return Result.err({ status: 4, maxDistance: 0 });
    const moved = offset(skin.value, faces, distance, rounds.filter(onOuter), requireRounds);
    if (!moved.isOk) return moved;
    // A sliver an older STL import kept as a "cavity" (see `isSliverShell`) is no cavity: it is
    // left out of the rebuilt solid rather than refusing the move for a void that is not there.
    const cavities = shells.filter(
        (shell, i) => i !== outerIndex && !isSliverShell(shell, shellVolume(shell)),
    );
    return rebuildWithCavities(shape, skin.value, moved.value, cavities);
}

/**
 * A shell whose volume over its area is below this (mm) encloses nothing: a sliver bubble an STL
 * import's sewing cut off where the mesh pinches — two parts of the surface touching along an
 * edge that four triangles share. Measured on a user's STL with 7 such edges: the sewing split
 * off two closed shells of 8 and 4 triangles, 1.2e-5 and 7e-9 mm³ for 0.02 and 0.04 mm² — 6e-4
 * and 2e-7 mm "thick" — and the import made one solid of them and the part, which Offset Face
 * then refused as a body with sealed cavities. A real void is far thicker: a 0.5 mm bubble is
 * 0.08 mm by this measure.
 */
export const SLIVER_THICKNESS = 0.01;

/** Whether a closed shell of this (signed) volume is a sliver that encloses nothing. */
export function isSliverShell(shell: IShell, volume: number): boolean {
    const area = (shell.findSubShapes(ShapeTypes.face) as IFace[]).reduce((sum, f) => sum + f.area(), 0);
    return Math.abs(volume) < SLIVER_THICKNESS * area;
}

/** The shell that encloses the others: the largest solid volume of a shell on its own. */
function outerShellIndex(shells: IShell[]): number {
    let best = -1;
    let bestVolume = 0;
    shells.forEach((shell, index) => {
        const solid = shapeFactory.solid([shell]);
        if (!solid.isOk) return;
        const volume = Math.abs(solid.value.volume());
        solid.value.dispose();
        if (volume > bestVolume) {
            bestVolume = volume;
            best = index;
        }
    });
    return best;
}

function rebuildWithCavities(
    input: IShape,
    skin: IShape,
    moved: TrackedShape,
    cavities: IShell[],
): Result<TrackedShape, OffsetFaceProblem> {
    const movedShells = moved.shape.findSubShapes(ShapeTypes.shell) as IShell[];
    if (movedShells.length !== 1) return Result.err({ status: 2, maxDistance: 0 });
    const movedSkin = movedShells[0];
    // a cavity the moved skin now reaches (or passes) cannot be kept as it was
    const stillInside = cavities.every((cavity) => {
        const corner = (cavity.findSubShapes(ShapeTypes.vertex)[0] as IVertex).point();
        return moved.shape.containsPoint(corner, false) && cavity.extremaDistance(movedSkin) > 1e-6;
    });
    if (!stillInside) return Result.err({ status: 4, maxDistance: 0 });

    const rebuilt = shapeFactory.solid([movedSkin, ...cavities]);
    if (!rebuilt.isOk || !rebuilt.value.checkShape()) return Result.err({ status: 2, maxDistance: 0 });
    const cavityVolume = cavities.reduce((sum, cavity) => sum + shellVolume(cavity), 0);
    const expected = moved.shape.volume() - cavityVolume;
    const volume = rebuilt.value.volume();
    if (!(volume > 0) || Math.abs(volume - expected) > 1e-6 * Math.max(1, Math.abs(expected))) {
        return Result.err({ status: 2, maxDistance: 0 });
    }
    return Result.ok({
        shape: rebuilt.value,
        faceAncestors: reindex(ShapeTypes.face, input, skin, moved.shape, rebuilt.value, moved.faceAncestors),
        edgeAncestors: reindex(ShapeTypes.edge, input, skin, moved.shape, rebuilt.value, moved.edgeAncestors),
    });
}

function shellVolume(shell: IShell): number {
    const solid = shapeFactory.solid([shell]);
    if (!solid.isOk) return 0;
    const volume = Math.abs(solid.value.volume());
    solid.value.dispose();
    return volume;
}

/**
 * The kernel's (moved, skin) pairs as (rebuilt, input) pairs, plus an identity pair for every
 * sub-shape of the rebuilt solid that IS a sub-shape of the input (the cavities', which nothing
 * moved). Indices are matched by identity (`isSame`), each list scanned once in step — both
 * sides enumerate one shell's sub-shapes in the same order — with a full search only where the
 * step misses.
 */
function reindex(
    type: ShapeType,
    input: IShape,
    skin: IShape,
    moved: IShape,
    rebuilt: IShape,
    pairs: readonly number[],
): number[] {
    const inputs = input.findSubShapes(type);
    const outputs = rebuilt.findSubShapes(type);
    const skinToInput = matchIndices(skin.findSubShapes(type), inputs);
    const movedToRebuilt = matchIndices(moved.findSubShapes(type), outputs);
    const result: number[] = [];
    const derived = new Set<number>();
    for (let i = 0; i + 1 < pairs.length; i += 2) {
        const out = movedToRebuilt[pairs[i]] ?? -1;
        const from = skinToInput[pairs[i + 1]] ?? -1;
        if (out < 0 || from < 0) continue;
        result.push(out, from);
        derived.add(out);
    }
    const kept = matchIndices(outputs, inputs);
    kept.forEach((from, out) => {
        if (from >= 0 && !derived.has(out)) result.push(out, from);
    });
    return result;
}

/** For each of `from`, the index of the same sub-shape in `to` (-1 when it is not there). */
function matchIndices(from: IShape[], to: IShape[]): number[] {
    let cursor = 0;
    return from.map((shape) => {
        for (let k = 0; k < to.length; k++) {
            const index = (cursor + k) % to.length;
            if (to[index].isSame(shape)) {
                cursor = index + 1;
                return index;
            }
        }
        return -1;
    });
}
