// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IShape, Matrix4, ShapeTypes } from "@chili3d/core";
import { type TriMesh, type Vec3, vertex } from "./mesh";

export function solidVolume(shape: IShape): number {
    return shape.findSubShapes(ShapeTypes.solid).reduce((v, s) => v + Math.abs(s.volume()), 0);
}

/** What the rebuilt part differs from the reference by. */
export interface Deviation {
    /** Material the reference has and the rebuild lacks, mm³. */
    readonly missing: number;
    /** Material the rebuild has and the reference does not, mm³. */
    readonly extra: number;
    /** (missing + extra) / reference volume. */
    readonly ratio: number;
    /** The difference pieces, when asked for (the caller owns them). */
    readonly missingShape?: IShape;
    readonly extraShape?: IShape;
}

/**
 * The two-way difference between the rebuilt part and the reference solid, by boolean cuts.
 * A cut the kernel refuses counts as the whole volume on that side, so a failed comparison
 * never reads as a perfect match.
 */
export function deviation(
    reference: IShape,
    rebuilt: IShape,
    keepShapes = false,
    expected?: { missing: number; extra: number },
): Deviation {
    const ref = solidVolume(reference);
    const built = solidVolume(rebuilt);
    const missingCut = robustCut(reference, rebuilt, expected?.missing);
    const extraCut = robustCut(rebuilt, reference, expected?.extra);
    const missing = missingCut.isOk ? solidVolume(missingCut.value) : ref;
    const extra = extraCut.isOk ? solidVolume(extraCut.value) : built;
    const result: Deviation = {
        missing,
        extra,
        ratio: ref > 0 ? (missing + extra) / ref : 1,
        ...(keepShapes && missingCut.isOk ? { missingShape: missingCut.value } : {}),
        ...(keepShapes && extraCut.isOk ? { extraShape: extraCut.value } : {}),
    };
    if (!keepShapes) {
        if (missingCut.isOk) missingCut.value.dispose();
        if (extraCut.isOk) extraCut.value.dispose();
    }
    return result;
}

/** Skewed nudges, mm: off every face of both parts, far below any feature. */
const NUDGES: [number, number, number][] = [
    [1.3e-3, 0.7e-3, 1.1e-3],
    [-0.9e-3, 1.7e-3, -1.3e-3],
];

/**
 * `a − b`, retried with `b` nudged by a few microns when the kernel refuses it: the rebuilt part
 * lies face on face with the reference (that is the point of it), and coplanar faces are the
 * case OCCT's booleans fail on. The nudge leaves slivers microns thick, which the callers'
 * volume thresholds ignore.
 */
export function robustCut(
    a: IShape,
    b: IShape,
    expected?: number,
): ReturnType<typeof shapeFactory.booleanCut> {
    const volumeA = solidVolume(a);
    const overlap = boxesOverlap(a, b);
    // a cut of two overlapping parts that took nothing away is a cut the kernel gave up on, and
    // so is one far from the volume measured independently (`meshDifference`)
    const sound = (cut: IShape) => {
        if (!cut.checkShape()) return false;
        const v = solidVolume(cut);
        if (overlap && Math.abs(v - volumeA) <= volumeA * 1e-9) return false;
        return expected === undefined || Math.abs(v - expected) <= expected * 0.5 + volumeA * 0.003;
    };
    const first = shapeFactory.booleanCut([a], [b]);
    if (first.isOk && sound(first.value)) return first;
    if (first.isOk) first.value.dispose();
    for (const [x, y, z] of NUDGES) {
        const moved = b.transformed(Matrix4.fromTranslation(x, y, z));
        try {
            const cut = shapeFactory.booleanCut([a], [moved]);
            if (cut.isOk && sound(cut.value)) return cut;
            if (cut.isOk) cut.value.dispose();
        } finally {
            moved.dispose();
        }
    }
    return first.isOk ? shapeFactory.booleanCut([a], [b]) : first;
}

/** Whether the two parts' bounding boxes overlap by more than a sliver. */
function boxesOverlap(a: IShape, b: IShape): boolean {
    const p = a.boundingBox();
    const q = b.boundingBox();
    const gap = 1e-3;
    return (
        p.min.x < q.max.x - gap &&
        q.min.x < p.max.x - gap &&
        p.min.y < q.max.y - gap &&
        q.min.y < p.max.y - gap &&
        p.min.z < q.max.z - gap &&
        q.min.z < p.max.z - gap
    );
}

/** A shape's triangles as a soup (9 numbers each), from its display mesh. */
export function trianglesOf(shape: IShape): Float64Array {
    const faces = shape.mesh.faces;
    if (faces === undefined) return new Float64Array(0);
    const out = new Float64Array(faces.index.length * 3);
    for (let k = 0; k < faces.index.length; k++) {
        const v = faces.index[k] * 3;
        out[k * 3] = faces.position[v];
        out[k * 3 + 1] = faces.position[v + 1];
        out[k * 3 + 2] = faces.position[v + 2];
    }
    return out;
}

/** How closely the rebuilt surface passes the STL's vertices (which lie on the part's true surface). */
export interface SurfaceFit {
    /** Share of the sampled vertices the rebuilt surface misses by more than `eps`. */
    readonly off: number;
    readonly sampled: number;
    /** Where it misses (up to 20), for diagnosis. */
    readonly misses: Vec3[];
}

/**
 * The rebuilt surface against the STL's vertices: an STL's vertices sit on the true surface
 * (the facets are chords between them), so a faithful rebuild has every vertex on its boundary —
 * a probe `eps` out along the vertex normal outside the solid, one `eps` in inside it. Unlike a
 * volume difference this reads zero for a rebuild with true arcs where the STL had facets.
 */
export function surfaceFit(mesh: TriMesh, shape: IShape, eps: number, samples = 3000): SurfaceFit {
    // triangle centres, by area: a centre lies on a flat face of the part exactly, and on a
    // curved one within the facet's sagitta — far less than `eps` for any sensible STL
    const total = mesh.areas.reduce((a, b) => a + b, 0);
    const step = total / samples;
    let carry = 0;
    let off = 0;
    let sampled = 0;
    const misses: Vec3[] = [];
    const t = mesh.triangles;
    for (let k = 0; k < mesh.areas.length; k++) {
        carry += mesh.areas[k];
        if (carry < step) continue;
        carry -= step;
        const a = vertex(mesh, t[3 * k]);
        const b = vertex(mesh, t[3 * k + 1]);
        const c = vertex(mesh, t[3 * k + 2]);
        const p: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
        const n: Vec3 = [mesh.normals[3 * k], mesh.normals[3 * k + 1], mesh.normals[3 * k + 2]];
        sampled++;
        const out = { x: p[0] + n[0] * eps, y: p[1] + n[1] * eps, z: p[2] + n[2] * eps };
        const inn = { x: p[0] - n[0] * eps, y: p[1] - n[1] * eps, z: p[2] - n[2] * eps };
        if (shape.containsPoint(out, false) || !shape.containsPoint(inn, false)) {
            off++;
            if (misses.length < 20) misses.push(p);
        }
    }
    return { off: sampled > 0 ? off / sampled : 1, sampled, misses };
}
