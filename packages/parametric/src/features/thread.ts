// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IFace,
    type IShape,
    LENGTH_UNITS,
    type ParameterValue,
    Result,
    resolveUnitSpec,
    type Scope,
    ShapeTypes,
} from "@chili3d/core";
import { trackedBoolean } from "./boolean";
import {
    type FeatureContext,
    type FeatureHandler,
    registerFeature,
    type ShapeTracking,
    type ThreadFeatureData,
} from "./feature";
import { applyTrackedOperation } from "./operation";
import { captureProfileRef } from "./profileRef";
import { matchSourceFaceIndexes } from "./sourceFaceMatcher";
import {
    buildThreadTool,
    checkThreadedBody,
    cylinderOfFace,
    planThread,
    type ThreadPlan,
    type ThreadSpec,
} from "./threadGeometry";
import { THREAD_FORMS, THREAD_STANDARDS, threadRow } from "./threadStandards";

/**
 * Thread: a screw thread on a cylindrical face of the chain input — see `ThreadFeatureData` for
 * the contract and `threadGeometry.ts` for how the groove is built and kept kernel-safe.
 *
 * The face is named and resolved exactly as an offset's are (a `ProfileRef` matched against
 * `context.input` itself, tracked id first, fingerprint second). A modelled thread is ONE tracked
 * cut of the swept tool, so the body's ids survive it and the tool's faces carry content names
 * (`thread:<featureId>:<role>.<k>`); a cosmetic one passes the input through untouched, ids and
 * all — but is still laid out on the face, so a size that does not fit says so in either mode.
 */
const threadHandler: FeatureHandler<ThreadFeatureData> = {
    display: (feature) => (feature.modeled ? "command.feature.thread" : "feature.thread.cosmeticTitle"),
    icon: "icon-helix",
    reselectable: true,

    nodeIds: () => [],

    parameters: (feature) => [
        // The size row writes its row's numbers into the fields below (`setParameter`); the
        // stored `size` is the label it shows, kept even when the numbers are then retyped.
        {
            key: "size",
            display: "feature.thread.size",
            value: feature.size,
            choices: THREAD_STANDARDS.map((row) => ({ value: row.size })),
        },
        { key: "diameter", display: "dimension.diameter", value: feature.diameter, unit: LENGTH_UNITS },
        { key: "pitch", display: "helix.pitch", value: feature.pitch, unit: LENGTH_UNITS },
        { key: "modeled", display: "feature.thread.modeled", value: feature.modeled },
        // A blank length runs the rest of the face — the feature then carries no `length`.
        { key: "length", display: "feature.thread.length", value: feature.length ?? "", unit: LENGTH_UNITS },
        { key: "offset", display: "feature.thread.offset", value: feature.offset ?? 0, unit: LENGTH_UNITS },
        { key: "flip", display: "feature.thread.flip", value: feature.flip === true },
        {
            key: "clearance",
            display: "feature.thread.clearance",
            value: feature.clearance ?? 0,
            unit: LENGTH_UNITS,
        },
    ],

    setParameter: (feature, key, value) => {
        if (key === "size") return typeof value === "string" ? applySize(feature, value) : feature;
        if (key === "modeled" || key === "flip") {
            return typeof value === "boolean" ? { ...feature, [key]: value } : feature;
        }
        if (typeof value === "boolean") return feature;
        if (key === "length") {
            const { length: _, ...rest } = feature;
            return value === "" ? rest : { ...rest, length: value };
        }
        if (key === "diameter" || key === "pitch" || key === "offset" || key === "clearance") {
            return { ...feature, [key]: value };
        }
        return feature;
    },

    applyResolvedRefs: (feature, { resolvedProfiles }) =>
        resolvedProfiles?.[0] === undefined ? feature : { ...feature, face: resolvedProfiles[0] },

    evaluate(feature, context): Result<IShape> {
        const spec = resolveThreadSpec(feature, context.scope);
        if (!spec.isOk) return Result.err(spec.error);
        const input = context.input;
        if (input === undefined) return Result.err("Thread requires a preceding feature");
        const face = resolveThreadFace(feature, context, input);
        if (!face.isOk) return Result.err(face.error);
        const plan = threadPlanOn(face.value, spec.value);
        if (!plan.isOk) return Result.err(plan.error);
        if (!feature.modeled) {
            passThrough(context.tracking);
            return Result.ok(input);
        }
        return cutThread(input, plan.value, feature.id, context.tracking);
    },
};

/** Writes a picked size's NUMBERS into the feature (see `threadStandards.ts`). */
function applySize(feature: ThreadFeatureData, size: string): ThreadFeatureData {
    const row = threadRow(size);
    if (row === undefined) return feature;
    return { ...feature, size: row.size, form: row.form, diameter: row.diameter, pitch: row.pitch };
}

/** The fields a thread's geometry is built from. */
export type ThreadSpecFields = Pick<
    ThreadFeatureData,
    "form" | "diameter" | "pitch" | "length" | "offset" | "flip" | "clearance"
>;

/** The feature's numbers in millimetres; the geometric checks are `planThread`'s. */
export function resolveThreadSpec(feature: ThreadSpecFields, scope: Scope): Result<ThreadSpec> {
    // The panel's dropdown cannot write a bad form; this keeps a hand-edited file from reaching
    // geometry that would read it wrong.
    if (!THREAD_FORMS.includes(feature.form)) return Result.err(`Invalid thread form: ${feature.form}`);
    const fields = [feature.diameter, feature.pitch, feature.offset, feature.clearance, feature.length];
    const values: (number | undefined)[] = [];
    for (const value of fields) {
        const resolved = resolveOptional(value, scope);
        if (!resolved.isOk) return Result.err(resolved.error);
        values.push(resolved.value);
    }
    const [diameter, pitch, offset, clearance, length] = values;
    if (diameter === undefined || pitch === undefined)
        return Result.err("Thread needs a diameter and a pitch");
    return Result.ok({
        form: feature.form,
        diameter,
        pitch,
        offset: offset ?? 0,
        clearance: clearance ?? 0,
        length,
        flip: feature.flip === true,
    });
}

/** An unset or blank length field is ABSENT, not zero — the caller supplies the default. */
function resolveOptional(value: ParameterValue | undefined, scope: Scope): Result<number | undefined> {
    if (value === undefined || value === "") return Result.ok(undefined);
    const resolved = resolveUnitSpec(value, scope, LENGTH_UNITS);
    return resolved.isOk ? Result.ok(resolved.value) : Result.err(resolved.error);
}

/**
 * Re-matches the stored face on the rebuilt input and re-anchors it — the offset feature's
 * contract. A face split since the pick (a later cut across it) is taken by its first piece: the
 * thread's helix runs a full circle whatever piece names the cylinder.
 */
function resolveThreadFace(
    feature: ThreadFeatureData,
    context: FeatureContext,
    input: IShape,
): Result<IFace> {
    const faces = input.findSubShapes(ShapeTypes.face) as IFace[];
    const faceIds = context.tracking?.inputFaceIds;
    const matched = matchSourceFaceIndexes(faces, faceIds, [feature.face]);
    if (!matched.isOk) return Result.err(matched.error);
    const index = matched.value.indexes[0];
    if (index === undefined) return Result.err("Thread face not found after rebuild");
    if (context.tracking !== undefined) {
        context.tracking.resolvedProfiles = [
            captureProfileRef(faces[index], faceIds?.[index], feature.face.splitPiece),
        ];
    }
    return Result.ok(faces[index]);
}

/** The thread laid out on `face`: its cylinder, then the plan (see `planThread`). */
export function threadPlanOn(face: IFace, spec: ThreadSpec): Result<ThreadPlan> {
    const frame = cylinderOfFace(face);
    return frame.isOk ? planThread(frame.value, spec) : Result.err(frame.error);
}

/** A cosmetic thread changes nothing — every sub-shape keeps its id. */
function passThrough(tracking: ShapeTracking | undefined): void {
    if (tracking === undefined) return;
    tracking.outputFaceIds = [...tracking.inputFaceIds];
    tracking.outputEdgeIds = [...tracking.inputEdgeIds];
}

/**
 * Sweeps the tool and cuts it from the input in one boolean — tracked when the kernel and the
 * chain can, plain otherwise — then checks what came back (`checkThreadedBody`). The tool is this
 * call's own and is freed whatever happens; a rejected result is freed too.
 */
export function cutThread(
    input: IShape,
    plan: ThreadPlan,
    featureId: string,
    tracking?: ShapeTracking,
): Result<IShape> {
    const tool = buildThreadTool(plan, featureId);
    if (!tool.isOk) return Result.err(tool.error);
    try {
        const tracked = trackedBoolean("cut");
        const cut =
            tracked === undefined || tracking === undefined
                ? shapeFactory.booleanCut([input], [tool.value.shape])
                : applyTrackedOperation(input, tracking, tracked, tool.value);
        if (!cut.isOk) return Result.err(`Thread cut failed: ${cut.error}`);
        const checked = checkThreadedBody(input, cut.value);
        if (!checked.isOk) cut.value.dispose();
        return checked;
    } finally {
        tool.value.shape.dispose();
    }
}

registerFeature("thread", threadHandler);
