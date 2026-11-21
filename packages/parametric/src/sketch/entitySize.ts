// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ParameterValue } from "@chili3d/core";
import { ConstraintKind, type SketchConstraintData, type SketchPointRef } from "./sketchModel";
import type { SketchSolver } from "./solver";
import { typedDimension } from "./typedDimension";

/** What the size of a selected entity is read as. */
export type EntitySizeKind = "diameter" | "radius" | "length";

/** A selected entity's one editable size: its reading now and the dimension holding it, if any. */
export interface EntitySize {
    readonly entityId: number;
    readonly kind: EntitySizeKind;
    /** In millimetres, as the geometry stands. */
    readonly value: number;
    /** The dimension constraint already on this size (driving or driven), if one is placed. */
    readonly constraintId?: number;
    readonly driven?: boolean;
}

const refKey = (refs: readonly SketchPointRef[]) =>
    refs
        .map((r) => `${r.entityId}:${r.pointIndex}`)
        .sort()
        .join("|");

/**
 * The size a lone selected circle (Ø), arc (R) or line (length) is edited by — the same reading
 * a typed number gives it while drawing (`typedDimension`), so the panel and the typed input
 * leave the same dimension behind. Undefined for any other entity.
 */
export function entitySize(solver: SketchSolver, entityId: number): EntitySize | undefined {
    const entity = solver.entity(entityId);
    const dimension = typedDimension(solver, entityId);
    if (entity === undefined || dimension === undefined) return undefined;
    const p = entity.params;
    let kind: EntitySizeKind;
    let value: number;
    if (entity.type === "circle") {
        kind = "diameter";
        value = 2 * p[2];
    } else if (entity.type === "arc") {
        kind = "radius";
        value = Math.hypot(p[2] - p[0], p[3] - p[1]);
    } else if (entity.type === "line") {
        kind = "length";
        value = Math.hypot(p[2] - p[0], p[3] - p[1]);
    } else {
        return undefined;
    }
    const existing = findDimension(solver, dimension);
    return {
        entityId,
        kind,
        value,
        ...(existing === undefined ? {} : { constraintId: existing.id, driven: existing.driven === true }),
    };
}

/** The placed constraint of the same kind on the same points, if there is one. */
function findDimension(
    solver: SketchSolver,
    wanted: Omit<SketchConstraintData, "id">,
): SketchConstraintData | undefined {
    const key = refKey(wanted.refs);
    return solver.toData().constraints.find((c) => c.kind === wanted.kind && refKey(c.refs) === key);
}

/**
 * The dimension a new size is written to: the one already placed, or a new driving one in the
 * reading the panel shows (a circle's reads Ø). Undefined for an entity that has no such size.
 */
export function dimensionForSize(
    solver: SketchSolver,
    size: EntitySize,
): { constraintId: number; added: boolean } | undefined {
    if (size.constraintId !== undefined) return { constraintId: size.constraintId, added: false };
    const dimension = typedDimension(solver, size.entityId);
    if (dimension === undefined) return undefined;
    const placed =
        size.kind === "diameter" && dimension.kind === ConstraintKind.Radius
            ? { ...dimension, display: "diameter" as const }
            : dimension;
    return { constraintId: solver.addConstraint(placed), added: true };
}

/** Whether a typed size is a positive length the geometry can take. */
export function isValidSize(value: ParameterValue): boolean {
    return typeof value !== "number" || (Number.isFinite(value) && value > 0);
}
