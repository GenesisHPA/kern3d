// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, type IShape, ShapeTypes } from "@chili3d/core";
import { appendExtrude, appendTreatment, type BuiltModel, buildModel } from "./build";
import { meshVolume, type TriMesh, weldTriangles } from "./mesh";
import { type EdgeTreatment, type PlannedExtrude, planExtrusions } from "./plan";
import { meshDifference } from "./raycast";
import { sliceFrames } from "./slices";
import { deviation, solidVolume, surfaceFit, trianglesOf } from "./verify";

export interface RebuildReport {
    readonly model?: BuiltModel;
    /** Two-way difference / reference volume, after the corrections. */
    readonly ratio: number;
    /** Before the corrective pieces. */
    readonly firstRatio: number;
    readonly features: number;
    readonly corrections: number;
    /** Rounds and chamfers put on edges. */
    readonly rounded?: number;
    readonly error?: string;
    /** Milliseconds: planning, building, the first comparison, the corrections. */
    readonly timings?: { plan: number; build: number; compare: number; correct: number };
    /** Share of the STL surface (sampled by area) the rebuilt surface misses by more than 0.05 mm. */
    readonly surfaceOff?: number;
}

export interface RebuildOptions {
    /** Fit tolerance, mm (default from the part's size). */
    readonly tol?: number;
    /** Rounds of corrective pieces along their own axes (default 2). */
    readonly passes?: number;
    /** Stop when the difference is below this share of the volume (default 0.2 %). */
    readonly goal?: number;
    /** Time the corrective pieces may take, ms (default 60 s): each costs two booleans with the part. */
    readonly budgetMs?: number;
}

/** What a corrective feature must take off the difference, as a share of the volume. */
const MIN_GAIN = 5e-4;

/** Tolerance for a part of this size: 0.005 mm, more for a big part (5e-5 of its size). */
export function defaultTolerance(mesh: TriMesh): number {
    return Math.max(0.005, mesh.size * 5e-5);
}

function bodyShape(model: BuiltModel): IShape | undefined {
    const shape = model.body.shape;
    return shape.isOk ? shape.value : undefined;
}

/**
 * The rebuild's difference from the reference, as a share of its volume, by ray columns through
 * both meshes (`meshDifference`) — the booleans give up on near-coincident solids, so they only
 * find the pieces to correct; whether a correction helped is measured here.
 */
function measure(reference: TriMesh, shape: IShape | undefined): number {
    return shape === undefined ? 1 : difference(reference, shape).ratio;
}

function difference(reference: TriMesh, shape: IShape): { ratio: number; missing: number; extra: number } {
    const d = meshDifference(reference, weldTriangles(trianglesOf(shape)));
    return { ratio: d.aVolume > 0 ? (d.aOnly + d.bOnly) / d.aVolume : 1, missing: d.aOnly, extra: d.bOnly };
}

function failedFeature(model: BuiltModel): string | undefined {
    return model.body.featureItems().find((x) => x.error !== undefined)?.error;
}

/**
 * Rebuilds a part from its triangles as a parametric body in `document`: slabs along the best
 * axis extruded from fitted sketches, round holes cut on their own; then, against `reference`
 * (the part as a solid), every piece the rebuild still misses or has too much of is rebuilt along
 * its own best axis and added or cut — a side hole, a pocket, a boss on another face, a chamfer.
 * A piece whose correction does not bring the difference down is left out again.
 */
export function rebuildPart(
    document: IDocument,
    soup: ArrayLike<number>,
    reference: IShape,
    name: string,
    options: RebuildOptions = {},
): RebuildReport {
    const mesh = weldTriangles(soup);
    if (mesh.areas.length === 0 || Math.abs(meshVolume(mesh)) <= 0) {
        return { ratio: 1, firstRatio: 1, features: 0, corrections: 0, error: "empty mesh" };
    }
    const tol = options.tol ?? defaultTolerance(mesh);
    const t0 = Date.now();
    const frames = sliceFrames(mesh);
    // measured against the triangles the part was read from: the kernel's display mesh of the
    // reference solid can lose faces, and a lost face reads as a missing slab of material
    const referenceMesh = mesh;
    const goal = options.goal ?? 0.002;
    /** One axis tried whole: planned, built, its edges rounded, measured. */
    const attempt = (frame: (typeof frames)[number]) => {
        const treatments: EdgeTreatment[] = [];
        const plans = planExtrusions(mesh, frame, tol, { treatments });
        if (plans.length === 0) return undefined;
        const model = buildModel(document, plans, name, tol);
        const shape = bodyShape(model);
        const failed = failedFeature(model);
        if (failed !== undefined || shape === undefined)
            return { model, ratio: 1, rounded: 0, plans, error: failed ?? "no shape" };
        // the rounds and chamfers the sharp slabs left out, each kept only if it brings the part closer
        let ratio = measure(referenceMesh, shape);
        let rounded = 0;
        for (const treatment of treatments) {
            const before = model.body.features;
            if (!appendTreatment(model, treatment, tol)) continue;
            const next = measure(referenceMesh, bodyShape(model));
            if (next <= ratio + 1e-5) {
                ratio = next;
                rounded++;
            } else {
                model.body.setFeaturesEmitShapeChanged(before);
            }
        }
        return { model, ratio, rounded, plans, error: undefined as string | undefined };
    };
    const discard = (model: BuiltModel) => {
        for (const n of [model.body, ...model.sketches]) n.parent?.remove(n);
    };
    // the best-scoring axis first; the next ones only when it leaves the part off — the score
    // counts flat faces, and a leaning arm or a side boss can make another axis the right one
    let best = attempt(frames[0]);
    for (const frame of frames.slice(1, 3)) {
        if (best !== undefined && best.error === undefined && best.ratio <= goal) break;
        const next = attempt(frame);
        if (next === undefined) continue;
        if (
            best === undefined ||
            (next.error === undefined && (best.error !== undefined || next.ratio < best.ratio))
        ) {
            if (best !== undefined) discard(best.model);
            best = next;
        } else {
            discard(next.model);
        }
    }
    const t1 = Date.now();
    const t2 = t1;
    if (best === undefined)
        return { ratio: 1, firstRatio: 1, features: 0, corrections: 0, error: "no sections" };
    const { model, rounded } = best;
    if (best.error !== undefined) {
        return {
            model,
            ratio: 1,
            firstRatio: 1,
            features: best.plans.length,
            corrections: 0,
            error: best.error,
        };
    }
    const firstRatio = best.ratio;
    const t3 = Date.now();
    const deadline = t3 + (options.budgetMs ?? 60_000);
    let ratio = firstRatio;
    let corrections = 0;
    const refVolume = solidVolume(reference);
    for (let pass = 0; pass < (options.passes ?? 2) && ratio > goal && Date.now() < deadline; pass++) {
        const current = bodyShape(model);
        if (current === undefined) break;
        const expected = difference(referenceMesh, current);
        const diff = deviation(reference, current, true, expected);
        const pieces: { shape: IShape; operation: "fuse" | "cut" }[] = [];
        for (const [whole, operation] of [
            [diff.missingShape, "fuse"],
            [diff.extraShape, "cut"],
        ] as const) {
            if (whole === undefined) continue;
            for (const solid of whole.findSubShapes(ShapeTypes.solid)) {
                // slivers between a facet and the true surface are not features
                if (Math.abs(solid.volume()) > refVolume * 5e-4) pieces.push({ shape: solid, operation });
            }
        }
        pieces.sort((a, b) => Math.abs(b.shape.volume()) - Math.abs(a.shape.volume()));
        let improved = false;
        for (const piece of pieces.slice(0, 8)) {
            if (Date.now() >= deadline) break;
            const pieceMesh = weldTriangles(trianglesOf(piece.shape));
            if (pieceMesh.areas.length === 0) continue;
            const frame = sliceFrames(pieceMesh)[0];
            const role = piece.operation === "fuse" ? "add" : "remove";
            const extra: PlannedExtrude[] = planExtrusions(pieceMesh, frame, tol, {
                holes: false,
                operation: piece.operation,
                role,
            });
            if (extra.length === 0) continue;
            const before = model.body.features;
            const sketchesBefore = model.sketches.length;
            for (const plan of extra) appendExtrude(model, document, plan, tol);
            const after = bodyShape(model);
            const next =
                after === undefined || failedFeature(model) !== undefined ? 1 : measure(referenceMesh, after);
            // every feature it adds must earn its place: 0.05 % of the part's volume each
            if (ratio - next >= MIN_GAIN * extra.length) {
                ratio = next;
                corrections += extra.length;
                improved = true;
            } else {
                // not an improvement: the pieces' features and sketches go again
                model.body.setFeaturesEmitShapeChanged(before);
                for (const sketch of model.sketches.splice(sketchesBefore)) sketch.parent?.remove(sketch);
            }
            if (ratio <= goal || Date.now() >= deadline) break;
        }
        diff.missingShape?.dispose();
        diff.extraShape?.dispose();
        if (!improved) break;
    }
    const timings = { plan: t1 - t0, build: t2 - t1, compare: t3 - t2, correct: Date.now() - t3 };
    const finalShape = bodyShape(model);
    const surfaceOff =
        finalShape === undefined ? 1 : surfaceFit(mesh, finalShape, Math.max(tol * 4, 0.05)).off;
    return {
        model,
        ratio,
        firstRatio,
        features: model.body.features.length,
        corrections,
        rounded,
        timings,
        surfaceOff,
    };
}
