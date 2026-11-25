// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import ClipperLib from "clipper-lib";
import { fitProfile, type Profile2D } from "./fit2d";
import { dot, type TriMesh, type Vec3, vertex } from "./mesh";
import type { PlannedExtrude } from "./plan";
import { type Loop2D, loopArea, type SliceFrame } from "./slices";

/**
 * The part seen along an axis: its outline and see-through holes — the projection of its
 * triangles, joined. Many printed parts are what two or three such views have in common (a cable
 * clip: an arch along one axis, a plate with holes along another), which a stack of slabs along a
 * single axis can only approximate. Cutting away everything outside each view makes them exact.
 */

/** Clipper works in integers: 1 unit = 1/SCALE mm (0.1 µm). */
const SCALE = 10000;

type IntPath = { X: number; Y: number }[];

/** The extent of the mesh along an axis. */
export function extentAlong(mesh: TriMesh, axis: Vec3): [number, number] {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < mesh.positions.length / 3; i++) {
        const h = dot(vertex(mesh, i), axis);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
    }
    return [lo, hi];
}

/**
 * The silhouette's loops in the frame's (u, v): outer loops counter-clockwise, see-through holes
 * clockwise (the slices' material convention). Loops smaller than `minArea` mm² (slivers between
 * facets) are left out.
 */
export function silhouette(mesh: TriMesh, frame: SliceFrame, minArea = 1e-4): Loop2D[] {
    const paths: IntPath[] = [];
    const t = mesh.triangles;
    for (let k = 0; k < mesh.areas.length; k++) {
        // the triangles facing along the axis cover the shadow; those edge-on add nothing
        const nz =
            mesh.normals[3 * k] * frame.axis[0] +
            mesh.normals[3 * k + 1] * frame.axis[1] +
            mesh.normals[3 * k + 2] * frame.axis[2];
        if (nz <= 1e-9) continue;
        const path: IntPath = [];
        for (const i of [t[3 * k], t[3 * k + 1], t[3 * k + 2]]) {
            const p = vertex(mesh, i);
            path.push({
                X: Math.round(dot(p, frame.xvec) * SCALE),
                Y: Math.round(dot(p, frame.yvec) * SCALE),
            });
        }
        if (ClipperLib.Clipper.Area(path) === 0) continue;
        if (!ClipperLib.Clipper.Orientation(path)) path.reverse();
        paths.push(path);
    }
    if (paths.length === 0) return [];
    const c = new ClipperLib.Clipper();
    c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
    const out: IntPath[] = [];
    c.Execute(
        ClipperLib.ClipType.ctUnion,
        out,
        ClipperLib.PolyFillType.pftNonZero,
        ClipperLib.PolyFillType.pftNonZero,
    );
    const loops: Loop2D[] = [];
    for (const path of out) {
        const loop: Loop2D = path.map((p) => [p.X / SCALE, p.Y / SCALE]);
        if (Math.abs(loopArea(loop)) >= minArea) loops.push(loop);
    }
    return loops;
}

/**
 * A cut through the whole part along the frame's axis that takes away everything outside its
 * silhouette (and through its see-through holes): a rectangle a margin round the silhouette with
 * the silhouette's loops inside it, read even-odd. Undefined when the outline cannot be fitted or
 * nothing is outside it (the view is the part's whole shadow box).
 */
export function silhouetteTrim(mesh: TriMesh, frame: SliceFrame, tol: number): PlannedExtrude | undefined {
    const loops = silhouette(mesh, frame, Math.max(1e-4, tol * tol * 100));
    if (loops.length === 0) return undefined;
    let minU = Number.POSITIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (const loop of loops)
        for (const [u, v] of loop) {
            minU = Math.min(minU, u);
            maxU = Math.max(maxU, u);
            minV = Math.min(minV, v);
            maxV = Math.max(maxV, v);
        }
    const size = Math.max(maxU - minU, maxV - minV);
    // a silhouette that fills its own box leaves nothing to cut
    const boxArea = (maxU - minU) * (maxV - minV);
    const solid = loops.reduce((a, l) => a + loopArea(l), 0);
    if (solid >= boxArea * 0.999) return undefined;
    const m = size * 0.05 + 1;
    const rect: Profile2D = {
        kind: "chain",
        curves: [
            { kind: "line", a: [minU - m, minV - m], b: [maxU + m, minV - m] },
            { kind: "line", a: [maxU + m, minV - m], b: [maxU + m, maxV + m] },
            { kind: "line", a: [maxU + m, maxV + m], b: [minU - m, maxV + m] },
            { kind: "line", a: [minU - m, maxV + m], b: [minU - m, minV - m] },
        ],
    };
    const profiles: Profile2D[] = [rect];
    for (const loop of loops) {
        const p = fitProfile(loop, tol);
        if (p === undefined) return undefined;
        profiles.push(p);
    }
    const [lo, hi] = extentAlong(mesh, frame.axis);
    const pad = (hi - lo) * 0.05 + 1;
    return {
        frame,
        base: lo - pad,
        depth: hi - lo + 2 * pad,
        profiles,
        operation: "cut",
        role: "remove",
    };
}

/** The part as the common part of its views: the first view extruded, the others cut to. */
export function silhouetteHull(mesh: TriMesh, frames: readonly SliceFrame[], tol: number): PlannedExtrude[] {
    const [first, ...rest] = frames;
    if (first === undefined) return [];
    const loops = silhouette(mesh, first, Math.max(1e-4, tol * tol * 100));
    const profiles: Profile2D[] = [];
    for (const loop of loops) {
        const p = fitProfile(loop, tol);
        if (p === undefined) return [];
        profiles.push(p);
    }
    if (profiles.length === 0) return [];
    const [lo, hi] = extentAlong(mesh, first.axis);
    const plans: PlannedExtrude[] = [{ frame: first, base: lo, depth: hi - lo, profiles, role: "body" }];
    for (const frame of rest) {
        const trim = silhouetteTrim(mesh, frame, tol);
        if (trim !== undefined) plans.push(trim);
    }
    return plans;
}
