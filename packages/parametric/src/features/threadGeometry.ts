// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ICylindricalSurface,
    type IEdge,
    type IFace,
    type IShape,
    type ISurface,
    type IWire,
    Result,
    ShapeTypes,
    type TrackedShape,
    type XYZ,
} from "@chili3d/core";
import { bornEdgeIdMap } from "./operationIds";
import { primitiveFrameXvec } from "./primitive";
import { type ThreadForm, threadDepth, threadFlankAngle } from "./threadStandards";
import { writeUncontestedIds } from "./trackedId";

/**
 * The geometry behind a Thread feature, kept apart from the handler so the command's live
 * preview builds through exactly the same code (`threadCommand.ts`).
 *
 * The modelled thread is a helical GROOVE cut from the body in both cases: on a shaft it is cut
 * inward from the surface down to the minor diameter, in a bore outward from the wall up to the
 * major diameter. The groove's tool is the thread form's section — a trapezoid in the plane
 * through the axis — swept along a helix with the AXIS held as the sweep's binormal, so the
 * section stays in an axial plane all the way round (a Frenet frame would tilt it with the
 * helix). Three rules keep the kernel safe; the release wasm aborts on any OCCT raise, so every
 * one of them is checked BEFORE a kernel call rather than recovered from after:
 *
 * - **No tangency.** The tool's air-side edge sits 0.1·P past the face, never on it, and a knee
 *   that would land on the face is moved off it — a tool face lying ON the body's surface is
 *   the tangential boolean case OCCT handles worst.
 * - **No self-touch.** The section is never wider than `MAX_WIDTH`·P along the axis, so two
 *   neighbouring turns of the swept tool never touch each other (a profile one pitch wide would
 *   make the sweep self-intersecting). Where the flanks would grow wider — only ever outside the
 *   material for a face of the right size — the section continues with straight radial sides.
 * - **Stays in the span.** The helix starts and stops half a section short of the thread's
 *   span, so the tool never leaves it axially and never cuts a shoulder or a neighbouring face
 *   past the end of the picked one.
 *
 * What the kernel builds is checked as well: the tool must be one valid solid, and the cut must
 * leave one valid body per input body, with less volume than before.
 */

/** The widest the tool's section may be, in pitches — see the module doc. */
const MAX_WIDTH = 0.94;

/** How far past the face the tool's air-side edge reaches, in pitches. */
const AIR_MARGIN = 0.1;

/** The axial gap between the tool and the ends of its span, in pitches. */
const END_MARGIN = 0.02;

/** A thread longer than this many turns is refused: the sweep and the cut grow with every turn. */
export const MAX_THREAD_TURNS = 400;

/** The thread's numbers, resolved to millimetres (see `ThreadFeatureData`). */
export interface ThreadSpec {
    readonly form: ThreadForm;
    readonly diameter: number;
    readonly pitch: number;
    readonly clearance: number;
    readonly offset: number;
    /** Undefined runs the rest of the face. */
    readonly length?: number;
    readonly flip: boolean;
}

/** A cylindrical face's frame: its axis, its radius, which side the material is on, its span. */
export interface CylinderFrame {
    readonly origin: XYZ;
    /** Unit axis direction; `start`/`end` are positions along it from `origin`. */
    readonly axis: XYZ;
    readonly radius: number;
    /** A bore (material outside the face) rather than a shaft. */
    readonly internal: boolean;
    readonly start: number;
    readonly end: number;
}

/** Whether `surface` is a cylinder — read structurally, the interface has no type tag. */
function asCylinder(surface: ISurface): ICylindricalSurface | undefined {
    const candidate = surface as Partial<ICylindricalSurface> & { semiAngle?: unknown; area?: unknown };
    return typeof candidate.radius === "number" &&
        candidate.axis !== undefined &&
        candidate.location !== undefined &&
        candidate.semiAngle === undefined &&
        candidate.area === undefined
        ? (surface as ICylindricalSurface)
        : undefined;
}

/**
 * The frame of a cylindrical face, or an error for any other face. The side is read off the
 * face's own normal (oriented by the solid, so a bore's points at the axis); the span is the
 * extent of the face's boundary along the axis.
 */
export function cylinderOfFace(face: IFace): Result<CylinderFrame> {
    const surface = face.surface();
    let cylinder: { origin: XYZ; axis: XYZ; radius: number } | undefined;
    try {
        const basis = asCylinder(surface) ?? trimmedBasis(surface);
        if (basis !== undefined) {
            cylinder = { origin: basis.location, axis: basis.axis, radius: basis.radius };
        }
    } finally {
        surface.dispose();
    }
    const axis = cylinder?.axis.normalize();
    if (cylinder === undefined || axis === undefined || !(cylinder.radius > 0)) {
        return Result.err("Thread needs a cylindrical face");
    }
    const [point, normal] = face.normal(0, 0);
    const offAxis = point.sub(cylinder.origin);
    const radial = offAxis.sub(axis.multiply(offAxis.dot(axis)));
    if (normal.length() < 1e-12 || radial.length() < 1e-9)
        return Result.err("Thread needs a cylindrical face");
    const span = axialSpan(face, cylinder.origin, axis);
    if (span === undefined || span.end - span.start < 1e-6) return Result.err("Thread face has no length");
    return Result.ok({
        origin: cylinder.origin,
        axis,
        radius: cylinder.radius,
        internal: normal.dot(radial) < 0,
        ...span,
    });
}

function trimmedBasis(surface: ISurface): ICylindricalSurface | undefined {
    const trimmed = surface as Partial<{ basisSurface(): ISurface }>;
    if (typeof trimmed.basisSurface !== "function") return undefined;
    const basis = trimmed.basisSurface();
    const cylinder = asCylinder(basis);
    if (cylinder === undefined) basis.dispose();
    return cylinder;
}

/** The face's extent along the axis, sampled off its boundary edges. */
function axialSpan(face: IFace, origin: XYZ, axis: XYZ): { start: number; end: number } | undefined {
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const edge of face.findSubShapes(ShapeTypes.edge) as IEdge[]) {
        try {
            const first = edge.firstParameter();
            const last = edge.lastParameter();
            for (let i = 0; i <= 8; i++) {
                const along = edge
                    .pointAt(first + ((last - first) * i) / 8)
                    .sub(origin)
                    .dot(axis);
                start = Math.min(start, along);
                end = Math.max(end, along);
            }
        } catch {
            // A degenerate edge has no curve to sample; the others bound the face.
        }
    }
    return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : undefined;
}

/** One straight side of the tool's section, in (ρ radius, ζ along the axis from the helix start). */
interface SectionSide {
    readonly from: readonly [number, number];
    readonly to: readonly [number, number];
    readonly role: string;
}

/** Everything the tool is built from: the helix and the section at its start. */
export interface ThreadPlan {
    readonly frame: CylinderFrame;
    /** Where the helix starts along the axis, from `frame.origin`. */
    readonly helixStart: number;
    readonly turns: number;
    readonly pitch: number;
    /** The helix's radius: the groove's root. */
    readonly rootRadius: number;
    readonly section: readonly SectionSide[];
}

/**
 * Lays the thread out on the face: the groove's radii from the standard, the section, the helix
 * range — refusing, with a message, everything the kernel must never be asked to build.
 */
export function planThread(frame: CylinderFrame, spec: ThreadSpec): Result<ThreadPlan> {
    const { pitch, diameter, clearance } = spec;
    if (!(diameter > 0)) return Result.err("Thread diameter must be positive");
    if (!(pitch > 0)) return Result.err("Thread pitch must be positive");
    if (pitch > diameter / 2) return Result.err("Thread pitch is too large for the diameter");
    if (!(clearance >= 0) || clearance > 0.3 * pitch) {
        return Result.err("Thread clearance must be between 0 and 0.3 × pitch");
    }
    const radii = grooveRadii(frame, spec);
    if (!radii.isOk) return Result.err(radii.error);
    const range = helixRange(frame, spec, radii.value.halfWidth);
    if (!range.isOk) return Result.err(range.error);
    return Result.ok({
        frame,
        helixStart: range.value.start,
        turns: range.value.turns,
        pitch,
        rootRadius: radii.value.root,
        section: radii.value.section,
    });
}

/** The groove's root and air-side radii, its section, and the section's half width along the axis. */
function grooveRadii(
    frame: CylinderFrame,
    spec: ThreadSpec,
): Result<{ root: number; section: SectionSide[]; halfWidth: number }> {
    const { pitch, diameter, clearance, form } = spec;
    const depth = threadDepth(form, pitch);
    const major = diameter / 2;
    const face = frame.radius;
    // The root is the groove's deep end: the minor radius on a shaft, the major one in a bore.
    const root = frame.internal ? major + clearance : major - depth - clearance;
    const air = frame.internal ? face - AIR_MARGIN * pitch : face + AIR_MARGIN * pitch;
    const intoMaterial = frame.internal ? root - face : face - root;
    if (root <= 0.2 * pitch || air <= 0.05 * pitch) return Result.err("Thread is too large for this face");
    if (intoMaterial < 0.25 * depth) {
        return Result.err(
            `Thread face ⌀${format(2 * face)} is too ${frame.internal ? "large" : "small"} for ⌀${format(diameter)}`,
        );
    }
    if (intoMaterial > depth + clearance + 0.5 * pitch) {
        return Result.err(
            `Thread face ⌀${format(2 * face)} is too ${frame.internal ? "small" : "large"} for ⌀${format(diameter)}`,
        );
    }
    const section = grooveSection(root, air, face, rootWidth(form, frame.internal) * pitch, spec);
    return Result.ok({ root, section, halfWidth: Math.max(...section.map((side) => Math.abs(side.to[1]))) });
}

/**
 * The root flat's width, in pitches: the basic profile's flat at the groove's deep end — P/4 at
 * a 60° bolt's minor diameter, P/8 at a 60° nut's major one (ISO 68-1); Whitworth's rounded
 * root is taken as its H/6 truncation, P/6 on both.
 */
function rootWidth(form: ThreadForm, internal: boolean): number {
    if (form === "whitworth") return 1 / 6;
    return internal ? 1 / 8 : 1 / 4;
}

/**
 * The section, centred on ζ = 0, as the closed polygon root → flank → (knee → radial side) →
 * air edge → back. Flanks run at the form's half angle until the section is `MAX_WIDTH` wide;
 * from that knee on the sides run straight out. A knee within 0.02·P of the face is pulled in
 * by 0.03·P, so no corner of the tool lies on the body's surface.
 */
function grooveSection(
    root: number,
    air: number,
    face: number,
    flat: number,
    spec: ThreadSpec,
): SectionSide[] {
    const { pitch } = spec;
    const tan = Math.tan(((threadFlankAngle(spec.form) / 2) * Math.PI) / 180);
    const out = Math.sign(air - root);
    const full = Math.abs(air - root);
    let knee = (MAX_WIDTH * pitch - flat) / (2 * tan);
    if (Math.abs(root + out * knee - face) < 0.02 * pitch) knee -= 0.03 * pitch;
    const half = (rho: number) => flat / 2 + Math.abs(rho - root) * tan;
    const corners: [number, number][] = [[root, -flat / 2]];
    const roles: string[] = [];
    if (knee < full) {
        const kneeRho = root + out * knee;
        corners.push(
            [kneeRho, -half(kneeRho)],
            [air, -half(kneeRho)],
            [air, half(kneeRho)],
            [kneeRho, half(kneeRho)],
        );
        roles.push("flankLow", "sideLow", "crest", "sideHigh", "flankHigh");
    } else {
        corners.push([air, -half(air)], [air, half(air)]);
        roles.push("flankLow", "crest", "flankHigh");
    }
    corners.push([root, flat / 2]);
    roles.push("root");
    return corners.map((from, index) => ({
        from,
        to: corners[(index + 1) % corners.length],
        role: roles[index],
    }));
}

/** The helix's start along the axis and its turn count — see "Stays in the span". */
function helixRange(
    frame: CylinderFrame,
    spec: ThreadSpec,
    halfWidth: number,
): Result<{ start: number; turns: number }> {
    const { offset, length, flip, pitch } = spec;
    if (!(offset >= 0)) return Result.err("Thread offset must not be negative");
    if (length !== undefined && !(length > 0)) return Result.err("Thread length must be positive");
    const faceLength = frame.end - frame.start;
    const used = offset + (length ?? faceLength - offset);
    if (offset >= faceLength || used > faceLength + 1e-6) {
        return Result.err(`Thread does not fit on the face (${format(faceLength)} long)`);
    }
    const low = flip ? frame.end - used : frame.start + offset;
    const high = flip ? frame.end - offset : frame.start + used;
    const inset = halfWidth + END_MARGIN * pitch;
    const rise = high - low - 2 * inset;
    if (rise < 0.25 * pitch) return Result.err("Thread is too short for its pitch");
    const turns = rise / pitch;
    if (turns > MAX_THREAD_TURNS) return Result.err(`Thread has more than ${MAX_THREAD_TURNS} turns`);
    return Result.ok({ start: low + inset, turns });
}

function format(value: number): string {
    return `${parseFloat(value.toFixed(2))}`;
}

/** The swept tool with its content-seeded sub-shape ids (all undefined without kernel history). */
export interface ThreadTool {
    readonly shape: IShape;
    readonly faceIds: (string | undefined)[];
    readonly edgeIds: (string | undefined)[];
}

/**
 * Sweeps the section along the helix. With kernel history the tool's faces are named by the
 * section side that swept them — `thread:<featureId>:<role>.<k>`, k counting that side's faces in
 * enumeration order (the kernel splits the helix into one edge per turn, so a side sweeps one face
 * per turn) — the two caps `start`/`end`, and every edge by the faces it borders.
 */
export function buildThreadTool(plan: ThreadPlan, featureId: string): Result<ThreadTool> {
    const { frame } = plan;
    const xvec = primitiveFrameXvec(frame.axis);
    const base = frame.origin.add(frame.axis.multiply(plan.helixStart));
    const at = ([rho, zeta]: readonly [number, number]) =>
        base.add(xvec.multiply(rho)).add(frame.axis.multiply(zeta));
    const owned: { dispose(): void }[] = [];
    try {
        const edges: IEdge[] = [];
        for (const side of plan.section) {
            const edge = shapeFactory.line(at(side.from), at(side.to));
            if (!edge.isOk) return Result.err(edge.error);
            edges.push(edge.value);
        }
        owned.push(...edges);
        const wire = shapeFactory.wire(edges);
        if (!wire.isOk) return Result.err(wire.error);
        owned.push(wire.value);
        const profile = shapeFactory.face([wire.value]);
        if (!profile.isOk) return Result.err(profile.error);
        owned.push(profile.value);
        const helix = shapeFactory.helix(
            base,
            frame.axis,
            xvec,
            plan.rootRadius,
            plan.pitch,
            plan.turns * 360,
        );
        if (!helix.isOk) return Result.err(helix.error);
        owned.push(helix.value);
        const roles = sectionEdgeRoles(profile.value, plan.section, at);
        return sweepTool(profile.value, helix.value, frame.axis, roles, featureId);
    } finally {
        owned.forEach((x) => x.dispose());
    }
}

function sweepTool(
    profile: IFace,
    helix: IWire,
    axis: XYZ,
    roles: readonly (string | undefined)[],
    featureId: string,
): Result<ThreadTool> {
    let shape: IShape;
    let history: TrackedShape | undefined;
    if (shapeFactory.sweepWithModeTracked !== undefined) {
        const swept = shapeFactory.sweepWithModeTracked(profile, helix, "fixed", false, axis);
        if (!swept.isOk) return Result.err(`Thread sweep failed: ${swept.error}`);
        shape = swept.value.shape;
        history = swept.value;
    } else {
        const swept = shapeFactory.sweepWithMode?.([profile], helix, "fixed", false, axis);
        if (swept === undefined) return Result.err("The kernel cannot sweep a thread");
        if (!swept.isOk) return Result.err(`Thread sweep failed: ${swept.error}`);
        shape = swept.value;
    }
    if (shape.findSubShapes(ShapeTypes.solid).length !== 1 || !shape.checkShape()) {
        shape.dispose();
        return Result.err("Thread sweep did not make a valid solid");
    }
    return Result.ok({ shape, ...seedToolIds(shape, history, roles, featureId) });
}

/** Each enumerated profile edge's section role, matched by midpoint. */
function sectionEdgeRoles(
    profile: IFace,
    section: readonly SectionSide[],
    at: (point: readonly [number, number]) => XYZ,
): (string | undefined)[] {
    const mids = section.map((side) => ({
        mid: at(side.from).add(at(side.to)).multiply(0.5),
        role: side.role,
    }));
    return (profile.findSubShapes(ShapeTypes.edge) as IEdge[]).map((edge) => {
        const mid = edge.startPoint().add(edge.endPoint()).multiply(0.5);
        return mids.find((x) => x.mid.distanceTo(mid) < 1e-7)?.role;
    });
}

function seedToolIds(
    shape: IShape,
    history: TrackedShape | undefined,
    roles: readonly (string | undefined)[],
    featureId: string,
): { faceIds: (string | undefined)[]; edgeIds: (string | undefined)[] } {
    const faces = shape.findSubShapes(ShapeTypes.face) as IFace[];
    const edges = shape.findSubShapes(ShapeTypes.edge) as IEdge[];
    const faceIds: (string | undefined)[] = new Array(faces.length).fill(undefined);
    const edgeIds: (string | undefined)[] = new Array(edges.length).fill(undefined);
    if (history === undefined) return { faceIds, edgeIds };

    const candidates = new Map<number, string>();
    const counts = new Map<string, number>();
    history.faceEdgeMap?.forEach((edgeIndex, faceIndex) => {
        const role = roles[edgeIndex];
        if (role === undefined || faceIndex < 0 || faceIndex >= faces.length) return;
        const k = counts.get(role) ?? 0;
        counts.set(role, k + 1);
        candidates.set(faceIndex, `thread:${featureId}:${role}.${k}`);
    });
    const caps = history.capFaces ?? [];
    for (const cap of caps) candidates.set(cap, `thread:${featureId}:end`);
    const rest = faces.map((_, index) => index).filter((index) => !candidates.has(index));
    if (rest.length === 1) candidates.set(rest[0], `thread:${featureId}:start`);
    writeUncontestedIds(faceIds, candidates);
    for (const [edgeIndex, id] of bornEdgeIdMap(shape, edges, faces, faceIds, () => true)) {
        edgeIds[edgeIndex] = id;
    }
    return { faceIds, edgeIds };
}

/**
 * Checks a cut's result against the body it was cut from: valid, the same number of solids, and
 * smaller — a thread that removed nothing (or everything) is a failed one, not a quiet success.
 */
export function checkThreadedBody(input: IShape, output: IShape): Result<IShape> {
    const before = input.findSubShapes(ShapeTypes.solid).length;
    const after = output.findSubShapes(ShapeTypes.solid).length;
    if (after !== before || !output.checkShape()) {
        return Result.err("Thread cut did not leave a valid body");
    }
    const removed = input.volume() - output.volume();
    if (!(removed > 1e-9) || !(output.volume() > 0)) return Result.err("Thread cut removed no material");
    return Result.ok(output);
}
