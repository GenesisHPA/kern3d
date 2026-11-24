// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IShape } from "@chili3d/core";
import { trianglesOf } from "./verify";

/**
 * Where the rebuild's bodies are triangulated for measuring. Meshing a body the rebuild made —
 * often an unsound one (mesh pieces sewn in), sometimes a valid B-rep OCCT still chokes on —
 * can abort the kernel outright (gidrik, apper, extruder-idler, Spool-holder: «Aborted()» in
 * the mesher, 2026-11-24), and an aborted kernel takes every open document with it.
 *
 * So the app hands the rebuild a triangulator that meshes in a kernel of its own (a copy of the
 * body sent as BREP text, the triangles sent back as numbers): a crash there costs that copy,
 * the body is judged unmeasurable, and the shared kernel never meshes it. Without one (a test
 * that sets none) the body is meshed in place, as before.
 */
export interface SafeTriangulator {
    /** The body's triangles (9 numbers each), or undefined when the kernel could not mesh it. */
    triangles(shape: IShape): Float64Array | undefined;
    /** Waits until it can mesh again (after a crash its kernel is made anew, asynchronously). */
    ready(): Promise<void>;
}

let current: SafeTriangulator | undefined;

export function setSafeTriangulator(value: SafeTriangulator | undefined) {
    current = value;
}

/** A body's triangles for measuring, never meshed in the shared kernel when a triangulator is set. */
export function safeTriangles(shape: IShape): Float64Array | undefined {
    return current === undefined ? trianglesOf(shape) : current.triangles(shape);
}

export function safeMeshReady(): Promise<void> {
    return current?.ready() ?? Promise.resolve();
}
