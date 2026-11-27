// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Profile2D } from "../stlRebuild/fit2d";
import { cross, dot, normalize, type TriMesh, type Vec3, vertex } from "../stlRebuild/mesh";
import { type Loop2D, loopArea, type SliceFrame, sectionAt } from "../stlRebuild/slices";
import { estimateNoise, scanTolerance } from "./noise";
import { openSectionLoops } from "./openSection";
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
 * (`sectionAt`). On a mesh with holes (a scan) the open chains are bridged across short gaps
 * (`openSectionLoops`); what still does not close is dropped, as are slivers.
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
    // a mesh with holes (a scan): its open chains bridged across gaps up to 5% of its size
    const loops = isClosed(mesh)
        ? sectionAt(mesh, frame, h, span)
        : openSectionLoops(mesh, frame, clearHeight(mesh, axis, h, span), mesh.size * 0.05);
    return loops
        .map((loop) => loop.map(([u, v]) => [u - ox, v - oy] as [number, number]))
        .filter((loop) => Math.abs(loopArea(loop)) > min);
}

/** Whether every edge of the mesh has two triangles. */
function isClosed(mesh: TriMesh): boolean {
    const nv = mesh.positions.length / 3;
    const t = mesh.triangles;
    const seen = new Map<number, number>();
    for (let k = 0; k < t.length / 3; k++) {
        for (let e = 0; e < 3; e++) {
            const a = t[3 * k + e];
            const b = t[3 * k + ((e + 1) % 3)];
            const key = a < b ? a * nv + b : b * nv + a;
            seen.set(key, (seen.get(key) ?? 0) + 1);
        }
    }
    for (const n of seen.values()) if (n !== 2) return false;
    return true;
}

/** A height near `h` no vertex lies on (as `sectionAt` picks one). */
function clearHeight(mesh: TriMesh, axis: Vec3, h: number, span: number): number {
    const eps = Math.max(span * 1e-6, 1e-9);
    const n = mesh.positions.length / 3;
    for (const shift of [0, 0.0137, -0.0219, 0.0311, -0.0423, 0.0517]) {
        const height = h + shift * span;
        let clear = true;
        for (let i = 0; i < n && clear; i++) {
            if (Math.abs(dot(vertex(mesh, i), axis) - height) < eps) clear = false;
        }
        if (clear) return height;
    }
    return h + 0.0617 * span;
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
