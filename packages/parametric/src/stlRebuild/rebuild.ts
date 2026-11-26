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
import {
    appendExtrude,
    appendRound,
    appendTreatment,
    type BuiltModel,
    buildModel,
    edgeSamples,
} from "./build";
import { profileArea } from "./fit2d";
import { primitiveHoles } from "./holes";
import { dot, meshVolume, soupMesh, type TriMesh, type Vec3, weldTriangles } from "./mesh";
import { type EdgeTreatment, type PlannedExtrude, planExtrusions } from "./plan";
import { meshDifference } from "./raycast";
import { safeMeshReady, safeTriangles } from "./safeMesh";
import { type Segment, segmentMesh } from "./segment";
import { bandOfEdge, type Sharpened, sharpenMesh } from "./sharpen";
import { silhouetteHull, silhouetteTrim } from "./silhouette";
import { frameFor, type SliceFrame, sliceFrames } from "./slices";
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
    /** Steps off for a comparison (the corpus runs): the holes read off the faces. */
    readonly off?: readonly "holes"[];
    /**
     * Also try the part planned with sharp edges, its rounds and chamfers put back as features
     * (`sharpen.ts`). Off by default: on the corpus (2026-11-26) it was never the closer body
     * once it had to beat the plain plan by 5 % — it only cost a build.
     */
    readonly sharpRounds?: boolean;
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

/** Most faces the reference may have for mesh pieces along an axis whose build cost is unknown. */
const MAX_PIECES_FACES = 6000;

/** Most holes read off the faces that are tried (each is a cut and a measure). */
const MAX_HOLES = 24;

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
    const tri = sound ? inPlaceTriangles(shape) : safeTriangles(shape);
    if (tri === undefined) {
        REBUILD_DEBUG?.("body could not be meshed: judged off");
        return undefined;
    }
    const d = meshDifference(reference, soupMesh(tri));
    return { ratio: d.aVolume > 0 ? (d.aOnly + d.bOnly) / d.aVolume : 1, missing: d.aOnly, extra: d.bOnly };
}

/**
 * A sound body's triangles, meshed in the shared kernel (fast). A valid B-rep can still make
 * OCCT's mesher raise (Voron idler_front, 2026-11-25): that «Aborted()» the kernel survives, so
 * the body is meshed again in a kernel of its own; a damaged heap stops the rebuild.
 */
function inPlaceTriangles(shape: IShape): Float64Array | undefined {
    try {
        return trianglesOf(shape);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (KERNEL_CORRUPTED.test(message)) throw new KernelCorrupted(message);
        REBUILD_DEBUG?.(`mesher raised (${message.slice(0, 60)}): meshed in a kernel of its own`);
        return safeTriangles(shape);
    }
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
    // the mesh's faces fitted as planes, cylinders, cones…: the holes and the rounds are read off them
    const segments: Segment[] | undefined =
        options.sharpRounds !== true && options.off?.includes("holes") ? undefined : segmentMesh(mesh, tol);
    /** The frames already built without pieces. */
    const tried = new Set<(typeof frames)[number]>();
    /** How long each frame's plain build took, ms: what its pieces build is judged against. */
    const buildMs = new Map<(typeof frames)[number], number>();
    /** One axis tried whole: planned, built, its edges rounded, measured. */
    const attempt = async (
        frame: (typeof frames)[number],
        meshPieces: boolean,
        step: IProgress,
        sharp?: Sharpened,
        /** Time the build may take, ms (the features after it are not built: the attempt fails). */
        buildBudget?: number,
        /** Longest plan worth building (a sharpened part planned in many more slabs is not simpler). */
        maxPlans = MAX_FEATURES,
    ) => {
        const ta = Date.now();
        await step.report(0);
        const axisName = frame.axis.map((x) => x.toFixed(2)).join(",");
        const treatments: EdgeTreatment[] = [];
        const plans = planExtrusions(sharp?.mesh ?? mesh, frame, tol, {
            treatments,
            meshPieces,
        });
        REBUILD_DEBUG?.(
            `axis ${axisName}${meshPieces ? " +pieces" : ""}${sharp ? " sharp" : ""}: ${plans.length} plans (${plans.filter((p) => p.fromMesh).length} pieces), ${treatments.length} treatments, plan ${Date.now() - ta} ms`,
        );
        if (plans.length === 0) return undefined;
        // with no mesh piece in it the plan is the one this axis already built: nothing new to try
        if (meshPieces && sharp === undefined && tried.has(frame) && !plans.some((p) => p.fromMesh)) {
            REBUILD_DEBUG?.(`axis ${axisName} +pieces: same plan as before, skipped`);
            return undefined;
        }
        if (!meshPieces && sharp === undefined) tried.add(frame);
        // a tree this long, or this much of the part as pieces, is no rebuild worth having — and
        // every piece is re-read on each rebuild of the chain, which is what runs the heap out
        if (
            plans.length > Math.min(maxPlans, MAX_FEATURES) ||
            plans.filter((p) => p.fromMesh).length > MAX_PIECES
        )
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
            buildBudget === undefined ? undefined : () => Date.now() - tb > buildBudget,
        );
        live.add(model);
        const shape = bodyShape(model);
        const failed = model.stopped ? "build over its time" : failedFeature(model);
        // the kernel's memory itself damaged (not OCCT's own «Aborted()», which it survives):
        // nothing it computes from here on can be trusted — stop, keep nothing
        if (failed !== undefined && KERNEL_CORRUPTED.test(failed)) throw new KernelCorrupted(failed);
        // an unsound body is still a result (the mesh pieces' sewn faces often fail the strict
        // check); it only takes no more booleans — corrections and rounds are for sound ones
        const sound = soundBody(shape, partSolids);
        if (!meshPieces) buildMs.set(frame, Date.now() - tb);
        REBUILD_DEBUG?.(
            `axis ${axisName}: build ${Date.now() - tb} ms${failed ? ` failed: ${failed}` : ""}${sound ? "" : " (unsound)"}`,
        );
        if (failed !== undefined || shape === undefined)
            return {
                model,
                ratio: 1,
                rounded: 0,
                plans,
                frame,
                sound,
                buildMs: Date.now() - tb,
                roundsKept: 0,
                error: failed ?? "no shape",
            };
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
        let roundsKept = 0;
        if (sharp !== undefined && sound) {
            const tr = Date.now();
            const r = roundBands(model, sharp, ratio);
            ratio = r.ratio;
            rounded += r.kept;
            roundsKept = r.kept;
            REBUILD_DEBUG?.(
                `axis ${axisName}: ${r.kept}/${r.tried} rounds kept → ${(ratio * 100).toFixed(3)}%, ${Date.now() - tr} ms`,
            );
        }
        return {
            model,
            ratio,
            rounded,
            plans,
            frame,
            sound,
            buildMs: Date.now() - tb,
            roundsKept,
            error: undefined as string | undefined,
        };
    };
    /**
     * The rounds and chamfers a sharpened plan left out, put back on its sharp edges: one feature
     * per size, each kept only if it brings the part closer (a feature the kernel refuses whole is
     * tried band by band).
     */
    const roundBands = (model: BuiltModel, sharp: Sharpened, start: number) => {
        let ratio = start;
        let kept = 0;
        let tried = 0;
        const groups = new Map<string, number[]>();
        sharp.bands.forEach((band, i) => {
            const key = `${band.kind}:${band.size.toFixed(3)}`;
            groups.set(key, [...(groups.get(key) ?? []), i]);
        });
        const order = [...groups.values()].sort((a, b) => b.length - a.length);
        const tryRound = (members: readonly number[]): boolean => {
            const samples = edgeSamples(model);
            const indexes: number[] = [];
            samples.forEach((pts, i) => {
                if (pts !== undefined && members.includes(bandOfEdge(sharp.bands, pts, tol))) indexes.push(i);
            });
            if (indexes.length === 0) return true;
            tried++;
            const band = sharp.bands[members[0]];
            const before = model.body.features;
            if (!appendRound(model, band.kind, band.size, indexes)) return false;
            const after = bodyShape(model);
            const next = soundBody(after, partSolids) ? measure(referenceMesh, after) : 1;
            if (next <= ratio + 1e-5) {
                ratio = next;
                kept++;
            } else model.body.setFeaturesEmitShapeChanged(before);
            return true;
        };
        for (const members of order) {
            if (!inTime() || kept + tried > 40) break;
            if (!tryRound(members) && members.length > 1)
                for (const m of members) {
                    if (!inTime()) break;
                    tryRound([m]);
                }
        }
        return { ratio, kept, tried };
    };
    /** The other views to cut to: the world axes and the best-scoring frames, not along `main`. */
    const viewFrames = (main: SliceFrame): SliceFrame[] => {
        const out: SliceFrame[] = [];
        const world: Vec3[] = [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
        ];
        for (const f of [...world.map((a) => frameFor(mesh, a)), ...frames.slice(0, 4)]) {
            if (Math.abs(dot(f.axis, main.axis)) > 0.99) continue;
            if (out.some((o) => Math.abs(dot(o.axis, f.axis)) > 0.99)) continue;
            out.push(f);
        }
        return out.slice(0, 3);
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
            // the closer, a failed build last, and an unsound body (no corrections, no rounds can
            // follow it) counted twice as far off: a sound 10 % loses to an unsound 1.8 %
            // (extruder-motor-plate), a sound 1 % beats an unsound 0.8 % — whatever order the
            // axes were built in, and whether time was left for all of them
            const score = (x: NonNullable<typeof best>) =>
                x.error !== undefined ? Number.POSITIVE_INFINITY : x.sound ? x.ratio : x.ratio * 2 + 0.005;
            if (best === undefined || score(next) < score(best)) {
                if (best !== undefined) discard(best.model);
                best = next;
            } else {
                discard(next.model);
            }
        }
        // ---- the part planned with sharp edges, its rounds and chamfers put back as features ----
        let sharpChosen: Sharpened | undefined;
        if (
            best !== undefined &&
            best.error === undefined &&
            best.sound &&
            inTime() &&
            options.sharpRounds === true
        ) {
            const ts = Date.now();
            const sharp = segments === undefined ? undefined : sharpenMesh(mesh, segments, tol);
            REBUILD_DEBUG?.(
                `segments ${segments?.length}, bands ${sharp === undefined ? 0 : `${sharp.bands.filter((b) => b.kind === "fillet").length} fillets, ${sharp.bands.filter((b) => b.kind === "chamfer").length} chamfers`}, ${Date.now() - ts} ms`,
            );
            if (sharp !== undefined) {
                progress.throwIfCancelled();
                const alt = await attempt(
                    best.frame,
                    false,
                    subProgress(progress, 0.5, 0.55),
                    sharp,
                    Math.max(30_000, best.buildMs * 2),
                    Math.ceil(best.plans.length * 1.5) + 2,
                );
                if (
                    alt !== undefined &&
                    alt.error === undefined &&
                    alt.sound &&
                    // its rounds put back, and clearly closer: a sharpened plan a hair closer
                    // before the views and holes was further off after them (idler, adxl mount)
                    alt.roundsKept > 0 &&
                    alt.ratio < best.ratio * 0.95 - 1e-4
                ) {
                    discard(best.model);
                    best = alt;
                    sharpChosen = sharp;
                } else if (alt !== undefined) discard(alt.model);
                REBUILD_DEBUG?.(`sharp plan ${sharpChosen ? "kept" : "dropped"}`);
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
        // ---- the part as what its views have in common -----------------------------------------
        // a clip (an arch one way, a plate with holes the other) is the common part of two or three
        // extruded views; slabs along one axis only approximate it. Cut away what lies outside each
        // other view (kept only when it brings the part closer), then try the views' hull itself.
        const views = viewFrames(best.frame);
        let viewRatio = best.ratio;
        /** A cut along an oblique view was kept: the difference booleans on such a body have
         * damaged the kernel's heap (UHP_350_Mount), so no corrections follow it. */
        let obliqueTrim = false;
        if (best.sound && viewRatio > goal) {
            for (const frame of views) {
                if (!inTime() || viewRatio <= goal) break;
                progress.throwIfCancelled();
                const trim = silhouetteTrim(mesh, frame, tol);
                if (trim === undefined) continue;
                const before = model.body.features;
                const sketchesBefore = model.sketches.length;
                appendExtrude(model, document, trim, tol);
                const after = bodyShape(model);
                const next =
                    failedFeature(model) !== undefined || !soundBody(after, partSolids)
                        ? 1
                        : measure(referenceMesh, after);
                const kept = viewRatio - next >= MIN_GAIN;
                REBUILD_DEBUG?.(
                    `view trim ${frame.axis.map((x) => x.toFixed(2))}: ${(next * 100).toFixed(3)}% ${kept ? "kept" : "dropped"}`,
                );
                if (kept) {
                    viewRatio = next;
                    if (!frame.axis.some((x) => Math.abs(Math.abs(x) - 1) < 1e-9)) obliqueTrim = true;
                } else {
                    model.body.setFeaturesEmitShapeChanged(before);
                    for (const sketch of model.sketches.splice(sketchesBefore)) sketch.parent?.remove(sketch);
                }
            }
        }
        if (viewRatio > goal && inTime() && views.length > 0) {
            // the hull of the views, with the holes the best axis found cut into it
            const hull = silhouetteHull(mesh, [best.frame, ...views], tol);
            const holes = best.plans.filter((p) => p.operation === "cut" && p.role === "hole" && !p.fromMesh);
            if (hull.length >= 2) {
                const th = Date.now();
                const alt = await buildModel(document, [...hull, ...holes], name, tol, reference);
                live.add(alt);
                const altShape = bodyShape(alt);
                const altRatio =
                    failedFeature(alt) !== undefined || !soundBody(altShape, partSolids)
                        ? 1
                        : measure(referenceMesh, altShape);
                REBUILD_DEBUG?.(
                    `view hull ${hull.length} views + ${holes.length} holes: ${(altRatio * 100).toFixed(3)}%, ${Date.now() - th} ms`,
                );
                if (altRatio < viewRatio - MIN_GAIN) {
                    discard(model);
                    model = alt;
                    rounded = 0;
                    viewRatio = altRatio;
                } else discard(alt);
            }
        }
        // ---- holes read off the mesh's faces, in any direction ----------------------------------
        // a concave cylinder or cone going round its axis is a hole's wall (a side hole, a
        // countersink the slices along the best axis cannot see): cut with its exact circle,
        // kept when it brings the part closer
        if (
            best.sound &&
            inTime() &&
            !options.off?.includes("holes") &&
            soundBody(bodyShape(model), partSolids)
        ) {
            const th = Date.now();
            const holes =
                segments === undefined
                    ? []
                    : primitiveHoles(mesh, soup, segments, tol, (axis) => frameFor(mesh, axis));
            REBUILD_DEBUG?.(`segments ${segments?.length}, ${holes.length} holes, ${Date.now() - th} ms`);
            const eps = Math.max(tol * 4, 0.05);
            const surfaceNowOf = (shape: IShape) =>
                surfaceFit(mesh, shape, eps, 3000, inPlaceTriangles(shape)).off;
            let surfaceNow = holes.length > 0 ? surfaceNowOf(bodyShape(model)!) : 1;
            for (const hole of holes.slice(0, MAX_HOLES)) {
                if (!inTime()) break;
                progress.throwIfCancelled();
                const before = model.body.features;
                const sketchesBefore = model.sketches.length;
                for (const plan of hole.plans) appendExtrude(model, document, plan, tol);
                const after = bodyShape(model);
                const ok = failedFeature(model) === undefined && soundBody(after, partSolids);
                const next = ok ? measure(referenceMesh, after) : 1;
                let kept = ok && next <= viewRatio + 1e-5 && viewRatio - next >= 1e-4;
                if (ok && !kept && next <= viewRatio + 1e-5) {
                    // a countersink takes little volume: judged by the surface it puts right
                    const s = surfaceNowOf(after!);
                    if (s < surfaceNow - 0.002) kept = true;
                }
                REBUILD_DEBUG?.(
                    `hole ${hole.label}: ${(next * 100).toFixed(3)}% ${kept ? "kept" : "dropped"}`,
                );
                if (kept) {
                    viewRatio = next;
                    surfaceNow = surfaceNowOf(after!);
                } else {
                    model.body.setFeaturesEmitShapeChanged(before);
                    for (const sketch of model.sketches.splice(sketchesBefore)) sketch.parent?.remove(sketch);
                }
            }
        }
        const deadline = Math.min(t3 + (options.budgetMs ?? 60_000), finishBy);
        let ratio = viewRatio;
        let corrections = 0;
        const refVolume = solidVolume(reference);
        const corrective = referenceFaces <= MAX_DIFFERENCE_FACES && best.sound && !obliqueTrim;
        if (!corrective)
            REBUILD_DEBUG?.(
                `corrections skipped: ${!best.sound ? "unsound body" : obliqueTrim ? "oblique view cut" : `${referenceFaces} faces`}`,
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
            if (shape === undefined) return 1;
            // the triangles the volume measure already made (the mesh is cached on the shape)
            // (an unsound body in a kernel of its own, as the volume measure does it)
            const tri = soundBody(shape, partSolids) ? inPlaceTriangles(shape) : safeTriangles(shape);
            return surfaceFit(mesh, shape, fitEps, 3000, tri).off;
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
                // a pieces build is the axis's build again plus booleans on the reference: started
                // only with twice that build time (and half a minute) still left — a boolean cannot
                // be stopped once begun (extruder-motor-plate ran past 15 min). An axis never built
                // has no measure of its cost: on a big reference it is left out.
                const cost = buildMs.get(frame);
                const left = finishBy - Date.now();
                if (cost === undefined ? referenceFaces > MAX_PIECES_FACES : left < 2 * cost + 30_000) {
                    REBUILD_DEBUG?.(
                        `pieces on axis ${frame.axis.map((x) => x.toFixed(2))} skipped: build ${cost ?? "?"} ms, ${left} ms left`,
                    );
                    continue;
                }
                progress.throwIfCancelled();
                const from = 0.78 + (0.22 * i) / axes;
                await progress.report(from, "stl.stage.pieces{0}{1}", i + 1, axes);
                const alt = await attempt(
                    frame,
                    true,
                    subProgress(progress, from, from + 0.22 / axes),
                    sharpChosen,
                );
                const altSurface = alt === undefined || alt.error !== undefined ? 1 : surfaceOf(alt.model);
                REBUILD_DEBUG?.(
                    `pieces on axis ${frame.axis.map((x) => x.toFixed(2))}: ${alt === undefined ? "none" : `${(alt.ratio * 100).toFixed(3)}% surface ${(altSurface * 100).toFixed(1)}% ${alt.error ?? ""}`}`,
                );
                // closer on the surface, and not further off in volume
                if (
                    alt !== undefined &&
                    alt.error === undefined &&
                    // closer on the surface and not further off in volume — against the volume
                    // before the view trims: they lower the volume measure of a body the pieces
                    // would have beaten on the surface, and must not keep it
                    ((altSurface < surface - 0.01 &&
                        alt.ratio <= Math.max(ratio, firstRatio) * 1.2 + 0.001) ||
                        // or far closer in volume for a little more surface off (a view cut can
                        // trim the surface while it leaves much of the volume wrong: LED diffuser)
                        (ratio > 0.01 && alt.ratio < ratio * 0.5 && altSurface <= surface + 0.05))
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
