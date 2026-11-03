// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { INode, XYZ } from "@chili3d/core";

/**
 * A construction axis in world coordinates: a point on it and its unit direction, plus the
 * finite segment the node draws (and that an edge consumer reads it as).
 */
export interface DatumAxisValue {
    readonly point: XYZ;
    readonly direction: XYZ;
    readonly start: XYZ;
    readonly end: XYZ;
}

/**
 * What another layer may ask of a datum-axis node. Structural, like `IPlaneNode`: the ref
 * resolution in `plane/sourceRefs.ts` and the revolve/pattern features must recognise a datum
 * axis without importing the node class (which imports them).
 */
export interface IDatumAxisNode {
    readonly id: string;
    /**
     * The axis in world coordinates, or undefined when it has never resolved. `visited`
     * carries the datum nodes already being resolved so a reference cycle reports undefined.
     */
    worldAxis(visited?: ReadonlySet<string>): DatumAxisValue | undefined;
}

/** What another layer may ask of a datum-point node (see `IDatumAxisNode`). */
export interface IDatumPointNode {
    readonly id: string;
    worldPoint(visited?: ReadonlySet<string>): XYZ | undefined;
}

export function isDatumAxisNode(node: unknown): node is INode & IDatumAxisNode {
    if (node === undefined || node === null) return false;
    return typeof (node as Partial<IDatumAxisNode>).worldAxis === "function";
}

export function isDatumPointNode(node: unknown): node is INode & IDatumPointNode {
    if (node === undefined || node === null) return false;
    return typeof (node as Partial<IDatumPointNode>).worldPoint === "function";
}

/**
 * The properties a datum node emits when its resolved geometry (not its drawing) changes —
 * what a body or another datum built on it watches.
 */
export const DATUM_VALUE_PROPERTIES: readonly string[] = ["axisLine", "pointPosition"];
