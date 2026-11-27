// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Profile2D } from "../stlRebuild/fit2d";
import { cross, dot, normalize, type TriMesh, type Vec3 } from "../stlRebuild/mesh";
import { type Loop2D, loopArea, type SliceFrame, sectionAt } from "../stlRebuild/slices";
import { estimateNoise, scanTolerance } from "./noise";
import { fitSectionProfile } from "./robustFit2d";

/** A sketch plane in plain numbers: the origin and the frame the sketch is drawn in. */
export interface PlaneFrame {
    readonly origin: Vec3;
    readonly normal: Vec3;
    readonly xvec: Vec3;
}

/**
 * The mesh cut by the plane, as closed loops in the plane's own (x, y) — measured from its
 * origin, as a sketch on it is drawn. A cut through a vertex is nudged off it by a hair
 * (`sectionAt`); loops that do not close (a mesh with holes) are dropped, as are slivers.
 */
export function meshSectionLoops(mesh: TriMesh, plane: PlaneFrame): Loop2D[] {
    const axis = normalize(plane.normal);
    const xvec = normalize(plane.xvec);
    const frame: SliceFrame = { axis, xvec, yvec: cross(axis, xvec) };
    const h = dot(plane.origin, axis);
    const ox = dot(plane.origin, frame.xvec);
    const oy = dot(plane.origin, frame.yvec);
    const span = Math.max(mesh.size * 1e-3, 1e-6);
    const min = Math.max(mesh.size * 1e-5, 1e-6) ** 2;
    return sectionAt(mesh, frame, h, span)
        .map((loop) => loop.map(([u, v]) => [u - ox, v - oy] as [number, number]))
        .filter((loop) => Math.abs(loopArea(loop)) > min);
}

export interface SectionSketchResult {
    /** The fitted loops, outer boundaries counter-clockwise, holes clockwise. */
    readonly profiles: Profile2D[];
    /** Section loops found, and how many of them no fit could describe. */
    readonly loops: number;
    readonly unfitted: number;
    /** The fit tolerance used, mm, and the mesh's noise (σ, mm; 0 for a CAD export). */
    readonly tol: number;
    readonly noise: number;
}

/**
 * The section of the mesh on the plane, fitted to lines, arcs and circles: within the CAD
 * tolerance for an exported mesh, within three times its noise for a scan (`scanTolerance`),
 * where the noise-tolerant fitter takes over (`fitSectionProfile`).
 */
export function sectionProfiles(
    mesh: TriMesh,
    plane: PlaneFrame,
    options: { tol?: number; noise?: number } = {},
): SectionSketchResult {
    const noise = options.noise ?? estimateNoise(mesh);
    const tol = options.tol ?? scanTolerance(mesh, noise);
    const loops = meshSectionLoops(mesh, plane);
    const noisy = noise * 3 > Math.max(0.005, mesh.size * 5e-5);
    const profiles: Profile2D[] = [];
    let unfitted = 0;
    for (const loop of loops) {
        const profile = fitSectionProfile(loop, tol, noisy);
        if (profile === undefined) unfitted++;
        else profiles.push(profile);
    }
    return { profiles, loops: loops.length, unfitted, tol, noise };
}
