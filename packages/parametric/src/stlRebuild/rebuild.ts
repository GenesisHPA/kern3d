// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    type IProgress,
    type IShape,
    NoProgress,
    ShapeTypes,
    subProgress,
} from "@chili3d/core";
import { appendExtrude, appendTreatment, type BuiltModel, buildModel } from "./build";
import { profileArea } from "./fit2d";
import { meshVolume, soupMesh, type TriMesh, weldTriangles } from "./mesh";
import { type EdgeTreatment, type PlannedExtrude, planExtrusions } from "./plan";
import { meshDifference } from "./raycast";
import { safeMeshReady, safeTriangles } from "./safeMesh";
import { sliceFrames } from "./slices";
import { deviation, setVerifyDebug, solidVolume, surfaceFit, trianglesOf } from "./verify";

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
    /**
     * Time the whole rebuild may take, ms (default 4 min): the steps that only improve a body
     * already built (other axes, corrections, pieces, rounds) are not started past it.
     */
    readonly totalBudgetMs?: number;
    /** Progress window and «Отмена» (the command's); none in the tests. */
    readonly progress?: IProgress;
}

/**
 * A trap that means the kernel's heap is damaged, as opposed to OCCT's own «Aborted()» (an
 * uncaught exception in an operation, which the kernel survives — the rebuild just drops that
 * axis). Seen on huge STL imports: «memory access out of bounds», «null function or function
 * signature mismatch».
 */
const KERNEL_CORRUPTED = /memory access out of bounds|null function|signature mismatch|unreachable/i;

/** The rebuild stopped because the kernel's memory was damaged: save the work and restart. */
export class KernelCorrupted extends Error {
    constructor(cause: string) {
        // the cause first: the main window words such a message as «save and restart» (isKernelCrash)
        super(cause.replace(/^.*?(RuntimeError: )/, "$1"));
        this.name = "KernelCorrupted";
    }
}

/** Diagnostics for the corpus test (unset in the app). */
let debugHook: ((line: string) => void) | undefined;
/** The kernel's heap, MB, for the diagnostics (0 when it cannot be read). */
function heapMb(): number {
    // the process's resident memory (the kernel's heap is most of it); 0 in a browser
    const usage = (
        globalThis as { process?: { memoryUsage?: () => { rss: number } } }
    ).process?.memoryUsage?.();
    return usage ? Math.round(usage.rss / 1048576) : 0;
}
/**
 * The kernel's own heap (the wasm memory), MB: Node counts an ArrayBuffer's backing store — the
 * wasm memory is one — under `arrayBuffers`; 0 in a browser.
 */
export function kernelHeapMb(): number {
    const usage = (
        globalThis as { process?: { memoryUsage?: () => { arrayBuffers?: number } } }
    ).process?.memoryUsage?.();
    return usage?.arrayBuffers ? Math.round(usage.arrayBuffers / 1048576) : 0;
}
export let REBUILD_DEBUG: ((line: string) => void) | undefined;
export function setRebuildDebug(hook: ((line: string) => void) | undefined) {
    debugHook = hook;
    setVerifyDebug(hook === undefined ? undefined : (line) => hook(`  ${line}`));
    REBUILD_DEBUG =
        hook === undefined
            ? undefined
            : (line) => debugHook?.(`${line} [rss ${heapMb()} MB, kernel ${kernelHeapMb()} MB]`);
}

/** Longest feature tree an axis may plan, and most pieces of the part it may keep. */
const MAX_FEATURES = 60;
const MAX_PIECES = 12;

/** What a corrective feature must take off the difference, as a share of the volume. */
const MIN_GAIN = 5e-4;

/**
 * Most features one corrective piece may plan: a difference piece that needs more is a tangle
 * of slivers, not a pocket or a boss — and building it costs as much as the part did.
 */
const MAX_PIECE_FEATURES = 8;

/**
 * Most faces the reference may have for the corrections' difference booleans: a solid sewn from
 * an STL keeps a face per facet where it is curved, and the two cuts of such a part against its
 * rebuild ran past ten minutes (a boolean cannot be stopped once started). Above it the pieces
 * still come from the part itself, clipped by a box — a far cheaper boolean.
 */
const MAX_DIFFERENCE_FACES = 1000;

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
function measure(reference: TriMesh, shape: IShape | undefined, sound = true): number {
    return shape === undefined ? 1 : (difference(reference, shape, sound)?.ratio ?? 1);
}

/**
 * The rebuild's difference from the reference by ray columns, or undefined when the body could
 * not be meshed. A sound body is meshed in place (fast, as it always was); an unsound one — the
 * kind that aborted the mesher (gidrik) — in a kernel of its own (see `safeMesh.ts`), and it is
 * otherwise left as it is: no rounds, no corrections.
 */
function difference(
    reference: TriMesh,
    shape: IShape,
    sound = true,
): { ratio: number; missing: number; extra: number } | undefined {
    const tri = sound ? trianglesOf(shape) : safeTriangles(shape);
    if (tri === undefined) {
        REBUILD_DEBUG?.("body could not be meshed: judged off");
        return undefined;
    }
    const d = meshDifference(reference, soupMesh(tri));
    return { ratio: d.aVolume > 0 ? (d.aOnly + d.bOnly) / d.aVolume : 1, missing: d.aOnly, extra: d.bOnly };
}

function failedFeature(model: BuiltModel): string | undefined {
    return model.body.featureItems().find((x) => x.error !== undefined)?.error;
}

/**
 * Whether a body is one the kernel can go on working with: a valid B-rep, in no more pieces
 * than the part itself. The ray measure reads a body that fell apart (a cut that split it, a
 * boss fused beside it) as closer to the part — and the next boolean on it aborts the kernel.
 */
function soundBody(shape: IShape | undefined, solids: number): boolean {
    if (shape === undefined || !shape.checkShape()) return false;
    return shape.findSubShapes(ShapeTypes.solid).length <= solids;
}

/**
 * Rebuilds a part from its triangles as a parametric body in `document`: slabs along the best
 * axis extruded from fitted sketches, round holes cut on their own; then, against `reference`
 * (the part as a solid), every piece the rebuild still misses or has too much of is rebuilt along
 * its own best axis and added or cut — a side hole, a pocket, a boss on another face, a chamfer.
 * A piece whose correction does not bring the difference down is left out again.
 */
export async function rebuildPart(
    document: IDocument,
    soup: ArrayLike<number>,
    reference: IShape,
    name: string,
    options: RebuildOptions = {},
): Promise<RebuildReport> {
    const progress = options.progress ?? NoProgress;
    // progress ranges: mesh 0-4 %, axes 4-55 %, corrections 55-75 %, surface and pieces 75-100 %
    await progress.report(0, "stl.stage.analyse");
    const mesh = weldTriangles(soup);
    if (mesh.areas.length === 0 || Math.abs(meshVolume(mesh)) <= 0) {
        return { ratio: 1, firstRatio: 1, features: 0, corrections: 0, error: "empty mesh" };
    }
    const tol = options.tol ?? defaultTolerance(mesh);
    const t0 = Date.now();
    const finishBy = t0 + (options.totalBudgetMs ?? 240_000);
    const inTime = () => Date.now() < finishBy;
    const frames = sliceFrames(mesh);
    // measured against the triangles the part was read from: the kernel's display mesh of the
    // reference solid can lose faces, and a lost face reads as a missing slab of material
    const referenceMesh = mesh;
    const goal = options.goal ?? 0.002;
    const partSolids = Math.max(1, reference.findSubShapes(ShapeTypes.solid).length);
    const referenceFaces = reference.findSubShapes(ShapeTypes.face).length;
    /** Created nodes not kept yet: discarded if the user stops (the transaction would too). */
    const live = new Set<BuiltModel>();
    /** One axis tried whole: planned, built, its edges rounded, measured. */
    const attempt = async (frame: (typeof frames)[number], meshPieces: boolean, step: IProgress) => {
        const ta = Date.now();
        await step.report(0);
        const axisName = frame.axis.map((x) => x.toFixed(2)).join(",");
        const treatments: EdgeTreatment[] = [];
        const plans = planExtrusions(mesh, frame, tol, { treatments, meshPieces });
        REBUILD_DEBUG?.(
            `axis ${axisName}${meshPieces ? " +pieces" : ""}: ${plans.length} plans (${plans.filter((p) => p.fromMesh).length} pieces), ${treatments.length} treatments, plan ${Date.now() - ta} ms`,
        );
        if (plans.length === 0) return undefined;
        // a tree this long, or this much of the part as pieces, is no rebuild worth having — and
        // every piece is re-read on each rebuild of the chain, which is what runs the heap out
        if (plans.length > MAX_FEATURES || plans.filter((p) => p.fromMesh).length > MAX_PIECES)
            return undefined;
        // pieces are the stretches between features; a part that is mostly pieces is not rebuilt
        const volumeOf = (list: typeof plans) =>
            list
                .filter((p) => p.operation !== "cut")
                .reduce(
                    (v, p) => v + p.profiles.reduce((a, q) => a + Math.max(0, profileArea(q)), 0) * p.depth,
                    0,
                );
        if (meshPieces && volumeOf(plans.filter((p) => p.fromMesh)) > volumeOf(plans) * 0.75)
            return undefined;
        const tb = Date.now();
        const model = await buildModel(
            document,
            plans,
            name,
            tol,
            reference,
            (body) => measure(referenceMesh, body.shape.isOk ? body.shape.value : undefined),
            async (done, total) => {
                step.throwIfCancelled();
                await step.report(0.05 + (0.65 * done) / total, "stl.stage.build{0}{1}", done + 1, total);
            },
        );
        live.add(model);
        const shape = bodyShape(model);
        const failed = failedFeature(model);
        // the kernel's memory itself damaged (not OCCT's own «Aborted()», which it survives):
        // nothing it computes from here on can be trusted — stop, keep nothing
        if (failed !== undefined && KERNEL_CORRUPTED.test(failed)) throw new KernelCorrupted(failed);
        // an unsound body is still a result (the mesh pieces' sewn faces often fail the strict
        // check); it only takes no more booleans — corrections and rounds are for sound ones
        const sound = soundBody(shape, partSolids);
        REBUILD_DEBUG?.(
            `axis ${axisName}: build ${Date.now() - tb} ms${failed ? ` failed: ${failed}` : ""}${sound ? "" : " (unsound)"}`,
        );
        if (failed !== undefined || shape === undefined)
            return { model, ratio: 1, rounded: 0, plans, frame, sound, error: failed ?? "no shape" };
        // the rounds and chamfers the sharp slabs left out, each kept only if it brings the part closer
        await step.report(0.7, "stl.stage.measure");
        const tm = Date.now();
        if (!sound) await safeMeshReady();
        let ratio = measure(referenceMesh, shape, sound);
        REBUILD_DEBUG?.(`axis ${axisName}: measure ${Date.now() - tm} ms → ${(ratio * 100).toFixed(3)}%`);
        let rounded = 0;
        const tt = Date.now();
        for (const [index, treatment] of treatments.entries()) {
            if (!inTime() || !sound) break;
            step.throwIfCancelled();
            await step.report(
                0.75 + (0.25 * index) / treatments.length,
                "stl.stage.rounds{0}{1}",
                index + 1,
                treatments.length,
            );
            REBUILD_DEBUG?.(`treatment ${treatment.kind} ${treatment.size.toFixed(3)}`);
            const before = model.body.features;
            if (!appendTreatment(model, treatment, tol)) continue;
            const treated = bodyShape(model);
            const next = soundBody(treated, partSolids) ? measure(referenceMesh, treated) : 1;
            if (next <= ratio + 1e-5) {
                ratio = next;
                rounded++;
            } else {
                model.body.setFeaturesEmitShapeChanged(before);
            }
        }
        if (treatments.length > 0)
            REBUILD_DEBUG?.(
                `axis ${axisName}: ${rounded}/${treatments.length} treatments kept, ${Date.now() - tt} ms`,
            );
        return { model, ratio, rounded, plans, frame, sound, error: undefined as string | undefined };
    };
    const discard = (model: BuiltModel) => {
        live.delete(model);
        for (const n of [model.body, ...model.sketches]) n.parent?.remove(n);
    };
    const axes = Math.min(3, frames.length);
    const axisStep = (i: number) => {
        const from = 0.04 + (0.51 * i) / axes;
        return subProgress(progress, from, from + 0.51 / axes);
    };
    try {
        return await rebuildSteps();
    } catch (error) {
        for (const model of [...live]) discard(model);
        throw error;
    }
    async function rebuildSteps(): Promise<RebuildReport> {
        // the best-scoring axis first; the next ones only when it leaves the part off — the score
        // counts flat faces, and a leaning arm or a side boss can make another axis the right one
        await progress.report(0.04, "stl.stage.axis{0}{1}", 1, axes);
        let best = await attempt(frames[0], false, axisStep(0));
        for (const [i, frame] of frames.slice(1, 3).entries()) {
            if (best !== undefined && best.error === undefined && best.ratio <= goal) break;
            if (best !== undefined && best.error === undefined && !inTime()) break;
            progress.throwIfCancelled();
            await progress.report(0.04 + (0.51 * (i + 1)) / axes, "stl.stage.axis{0}{1}", i + 2, axes);
            const next = await attempt(frame, false, axisStep(i + 1));
            if (next === undefined) continue;
            // a sound body before an unsound one, then the closer
            const rank = (x: NonNullable<typeof best>) => (x.error !== undefined ? 2 : x.sound ? 0 : 1);
            if (
                best === undefined ||
                rank(next) < rank(best) ||
                (rank(next) === rank(best) && next.error === undefined && next.ratio < best.ratio)
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
        let { model, rounded } = best;
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
        const deadline = Math.min(t3 + (options.budgetMs ?? 60_000), finishBy);
        let ratio = firstRatio;
        let corrections = 0;
        const refVolume = solidVolume(reference);
        const corrective = referenceFaces <= MAX_DIFFERENCE_FACES && best.sound;
        if (!corrective)
            REBUILD_DEBUG?.(
                `corrections skipped: ${best.sound ? `${referenceFaces} faces` : "unsound body"}`,
            );
        for (
            let pass = 0;
            corrective && pass < (options.passes ?? 2) && ratio > goal && Date.now() < deadline;
            pass++
        ) {
            progress.throwIfCancelled();
            await progress.report(0.55 + 0.1 * pass, "stl.stage.corrections{0}", pass + 1);
            const current = bodyShape(model);
            if (current === undefined) break;
            const td = Date.now();
            const expected = difference(referenceMesh, current);
            if (expected === undefined) break;
            const diff = deviation(reference, current, true, expected);
            REBUILD_DEBUG?.(`correction pass ${pass}: deviation ${Date.now() - td} ms`);
            if (!diff.trusted) {
                // the kernel could not compare the bodies: no piece from it would mean anything
                REBUILD_DEBUG?.(`correction pass ${pass}: comparison failed, corrections stopped`);
                diff.missingShape?.dispose();
                diff.extraShape?.dispose();
                break;
            }
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
                progress.throwIfCancelled();
                await progress.report(0.55 + 0.1 * pass);
                REBUILD_DEBUG?.(`piece ${piece.operation} ${Math.abs(piece.shape.volume()).toFixed(1)} mm³`);
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
                if (extra.length > MAX_PIECE_FEATURES) {
                    REBUILD_DEBUG?.(`piece ${piece.operation} skipped: ${extra.length} features`);
                    continue;
                }
                REBUILD_DEBUG?.(`piece planned: ${extra.length} features`);
                const before = model.body.features;
                const sketchesBefore = model.sketches.length;
                for (const plan of extra) appendExtrude(model, document, plan, tol);
                REBUILD_DEBUG?.(`piece built`);
                const after = bodyShape(model);
                const next =
                    failedFeature(model) !== undefined || !soundBody(after, partSolids)
                        ? 1
                        : measure(referenceMesh, after);
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
                REBUILD_DEBUG?.(
                    `correction ${piece.operation} ${extra.length} features → ${(next * 100).toFixed(3)}% ${ratio === next ? "kept" : "dropped"}`,
                );
                if (ratio <= goal || Date.now() >= deadline) break;
            }
            diff.missingShape?.dispose();
            diff.extraShape?.dispose();
            if (!improved) break;
        }
        // still off: the stretches no feature describes taken as the part's own pieces — last, and
        // judged by the surface, not the volume: true arcs where the STL had facets cost volume
        // (a perfect rebuild of a round reads ~0.5 %) but no surface point
        const fitEps = Math.max(tol * 4, 0.05);
        const surfaceOf = (m: BuiltModel) => {
            const shape = bodyShape(m);
            return shape === undefined ? 1 : surfaceFit(mesh, shape, fitEps).off;
        };
        progress.throwIfCancelled();
        await progress.report(0.75, "stl.stage.surface");
        const ts = Date.now();
        let surface = surfaceOf(model);
        REBUILD_DEBUG?.(`surface ${(surface * 100).toFixed(1)}%, ${Date.now() - ts} ms`);
        if (surface > 0.02) {
            // on every axis tried: the axis features liked best need not be the one the pieces fit
            for (const [i, frame] of frames.slice(0, 3).entries()) {
                if (surface <= 0.02 || !inTime()) break;
                progress.throwIfCancelled();
                const from = 0.78 + (0.22 * i) / axes;
                await progress.report(from, "stl.stage.pieces{0}{1}", i + 1, axes);
                const alt = await attempt(frame, true, subProgress(progress, from, from + 0.22 / axes));
                const altSurface = alt === undefined || alt.error !== undefined ? 1 : surfaceOf(alt.model);
                REBUILD_DEBUG?.(
                    `pieces on axis ${frame.axis.map((x) => x.toFixed(2))}: ${alt === undefined ? "none" : `${(alt.ratio * 100).toFixed(3)}% surface ${(altSurface * 100).toFixed(1)}% ${alt.error ?? ""}`}`,
                );
                // closer on the surface, and not further off in volume
                if (
                    alt !== undefined &&
                    alt.error === undefined &&
                    altSurface < surface - 0.01 &&
                    alt.ratio <= ratio * 1.2 + 0.001
                ) {
                    discard(model);
                    model = alt.model;
                    rounded = alt.rounded;
                    ratio = alt.ratio;
                    surface = altSurface;
                    corrections = 0;
                } else if (alt !== undefined) {
                    discard(alt.model);
                }
            }
        }
        const timings = { plan: t1 - t0, build: t2 - t1, compare: t3 - t2, correct: Date.now() - t3 };
        const surfaceOff = surface;
        await progress.report(1);
        live.clear();
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
}
