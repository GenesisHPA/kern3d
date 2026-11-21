// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { fitProfile, type Profile2D, profileArea } from "./fit2d";
import { meshVolume, type TriMesh } from "./mesh";
import { type Loop2D, loopArea, type Slab, type SliceFrame, sectionAt, slabsOf } from "./slices";

/** One extrude of the rebuilt part: profiles sketched at `base` along the frame's axis, `depth` up. */
export interface PlannedExtrude {
    readonly frame: SliceFrame;
    readonly base: number;
    readonly depth: number;
    readonly profiles: readonly Profile2D[];
    /** Undefined for the first (standalone) feature. */
    readonly operation?: "fuse" | "cut";
    /** What it stands for, for the tree's names and the report. */
    readonly role: "body" | "hole" | "add" | "remove";
    /** Taper in degrees, the extrude's convention: positive narrows toward the end. */
    readonly draft?: number;
    /** A tapered extrude's straight stand-in (its mid-height section), for when the kernel will not taper it. */
    readonly straight?: readonly Profile2D[];
    /** An oblique extrude: the profiles' shift (u, v) over the whole depth. */
    readonly lean?: readonly [number, number];
    /**
     * A stretch no feature describes (its walls lean, but neither as a draft, a lean nor an
     * edge round): the part itself is taken here, clipped to the slab, `profiles` being the
     * straight stand-in should that fail.
     */
    readonly fromMesh?: boolean;
}

interface FittedSlab {
    readonly bottom: number;
    readonly top: number;
    readonly loops: Loop2D[];
    profiles: Profile2D[];
    /** Set on a tapered slab: its profiles are its bottom section. */
    readonly draft?: number;
    readonly straight?: Profile2D[];
    readonly lean?: [number, number];
    readonly fromMesh?: boolean;
}

/** Whether (u, v) is inside the material of a slab's loops (even-odd over all of them). */
export function insideLoops(loops: readonly Loop2D[], u: number, v: number): boolean {
    let inside = false;
    for (const loop of loops) {
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
            const [xi, yi] = loop[i];
            const [xj, yj] = loop[j];
            if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
        }
    }
    return inside;
}

const round = (x: number, q: number) => Math.round(x / q) * q;

/** A profile written so that two equal ones read the same (to `q`). */
function profileKey(p: Profile2D, q: number): string {
    if (p.kind === "circle") return `c${round(p.c[0], q)},${round(p.c[1], q)},${round(p.r, q)}`;
    return p.curves
        .map((c) =>
            c.kind === "line"
                ? `l${round(c.a[0], q)},${round(c.a[1], q)}`
                : `a${round(c.a[0], q)},${round(c.a[1], q)},${round(c.r, q)},${c.ccw ? 1 : 0}`,
        )
        .sort()
        .join(";");
}

/** A coarser key than `profileKey`: area (to 1 %) and the centre of its end points. */
function shapeKey(p: Profile2D, q: number): string {
    const area = profileArea(p);
    const points = p.kind === "circle" ? [p.c] : p.curves.map((c) => c.a);
    const cx = points.reduce((t, x) => t + x[0], 0) / points.length;
    const cy = points.reduce((t, x) => t + x[1], 0) / points.length;
    const step = Math.max(Math.abs(area) * 0.01, q * q);
    return `${Math.round(area / step)}@${round(cx, q * 20)},${round(cy, q * 20)}`;
}

const slabKey = (s: FittedSlab, q: number) =>
    `${s.draft ?? 0}#${s.profiles
        .map((p) => profileKey(p, q))
        .sort()
        .join("|")}`;

function perimeter(loop: Loop2D): number {
    let p = 0;
    for (let i = 0; i < loop.length; i++) {
        const [x1, y1] = loop[i];
        const [x2, y2] = loop[(i + 1) % loop.length];
        p += Math.hypot(x2 - x1, y2 - y1);
    }
    return p;
}

/** The loop's centre of area (a mean of its points would lean toward wherever it is finely cut). */
function centroid(loop: Loop2D): [number, number] {
    let a = 0;
    let x = 0;
    let y = 0;
    for (let i = 0; i < loop.length; i++) {
        const [x1, y1] = loop[i];
        const [x2, y2] = loop[(i + 1) % loop.length];
        const c = x1 * y2 - x2 * y1;
        a += c;
        x += (x1 + x2) * c;
        y += (y1 + y2) * c;
    }
    if (Math.abs(a) < 1e-12) {
        const n = loop.length;
        return [loop.reduce((t, p) => t + p[0], 0) / n, loop.reduce((t, p) => t + p[1], 0) / n];
    }
    return [x / (3 * a), y / (3 * a)];
}

/** Below this share of slanted side a slab is taken as straight-walled. */
const SLANTED = 0.03;
/** Sections a slab's taper is read from, as fractions of its height. */
const SAMPLES = [0.002, 0.25, 0.5, 0.75, 0.998];

/** One loop of a tapered slab: its bottom section and its taper (material convention). */
interface TaperedLoop {
    readonly loop: Loop2D;
    readonly draft: number;
}

/**
 * The loops of a slab whose walls lean, each with the taper that carries its bottom section to
 * its top: read off sections through the slab, the inward offset of each loop growing linearly
 * with height (offset = change of area over perimeter). Undefined when the loops do not hold
 * through the slab (they split or merge) or a loop's offset is not linear in height — a round,
 * not a draft or a cone.
 */
function taperOf(
    mesh: TriMesh,
    frame: SliceFrame,
    bottom: number,
    top: number,
    tol: number,
    slack = 0.004,
): TaperedLoop[] | undefined {
    const span = top - bottom;
    const sections = SAMPLES.map((f) => ({
        z: bottom + f * span,
        loops: sectionAt(mesh, frame, bottom + f * span, span * 0.01).filter(
            (l) => Math.abs(loopArea(l)) > tol * tol,
        ),
    }));
    const base = sections[0].loops;
    if (base.length === 0 || sections.some((s) => s.loops.length !== base.length)) {
        DEBUG_HOOK?.(
            `    taper ${bottom.toFixed(2)}..${top.toFixed(2)}: loop counts ${sections.map((x) => x.loops.length)}`,
        );
        return undefined;
    }
    const result: TaperedLoop[] = [];
    for (const loop of base) {
        const c = centroid(loop);
        const a0 = loopArea(loop);
        const p0 = perimeter(loop);
        let num = 0;
        let den = 0;
        const points: [number, number][] = [];
        for (const section of sections.slice(1)) {
            // the same loop higher up: the one whose centre is nearest, of the same sense
            let best: Loop2D | undefined;
            let bestDistance = Number.POSITIVE_INFINITY;
            for (const other of section.loops) {
                if (Math.sign(loopArea(other)) !== Math.sign(a0)) continue;
                const o = centroid(other);
                const d = Math.hypot(o[0] - c[0], o[1] - c[1]);
                if (d < bestDistance) {
                    bestDistance = d;
                    best = other;
                }
            }
            if (best === undefined) return undefined;
            // a loop sliding sideways is an oblique sweep, not a taper (whose loops stay centred)
            const bc = centroid(best);
            if (
                Math.hypot(bc[0] - c[0], bc[1] - c[1]) >
                Math.max(tol * 4, span * 0.01) + Math.abs(a0 - loopArea(best)) / Math.max(p0, 1e-9)
            ) {
                DEBUG_HOOK?.(
                    `    taper ${bottom.toFixed(2)}..${top.toFixed(2)}: centre slides ${Math.hypot(bc[0] - c[0], bc[1] - c[1]).toFixed(3)}`,
                );
                return undefined;
            }
            const dz = section.z - sections[0].z;
            // inward offset of the material: positive when the material shrinks upward
            const offset = (a0 - loopArea(best)) / ((p0 + perimeter(best)) / 2);
            points.push([dz, offset]);
            num += dz * offset;
            den += dz * dz;
        }
        const slope = den > 0 ? num / den : 0;
        const residual = Math.max(...points.map(([dz, d]) => Math.abs(d - slope * dz)));
        if (residual > Math.max(tol * 2, span * slack)) {
            DEBUG_HOOK?.(
                `    taper ${bottom.toFixed(2)}..${top.toFixed(2)}: residual ${residual.toFixed(4)} > ${Math.max(tol * 2, span * slack).toFixed(4)}`,
            );
            return undefined;
        }
        const draft = (Math.atan(slope) * 180) / Math.PI;
        if (Math.abs(draft) >= 80) return undefined;
        result.push({ loop, draft: Math.abs(draft) < 0.05 ? 0 : draft });
    }
    return result;
}

/**
 * A slab whose sections keep their shape and slide sideways with height (a leaning arm, an
 * oblique boss): every loop's area the same through the slab and its centre moving along one
 * straight line, all loops by the same shift. The shift over the whole slab, or undefined.
 */
function obliqueOf(
    mesh: TriMesh,
    frame: SliceFrame,
    bottom: number,
    top: number,
    tol: number,
): [number, number] | undefined {
    const span = top - bottom;
    const sections = SAMPLES.map((f) =>
        sectionAt(mesh, frame, bottom + f * span, span * 0.01).filter(
            (l) => Math.abs(loopArea(l)) > tol * tol,
        ),
    );
    const base = sections[0];
    if (base.length === 0 || sections.some((x) => x.length !== base.length)) return undefined;
    const slack = Math.max(tol * 4, span * 0.01);
    let shift: [number, number] | undefined;
    for (const loop of base) {
        const c0 = centroid(loop);
        const a0 = loopArea(loop);
        const centres: [number, number][] = [];
        for (const section of sections.slice(1)) {
            // the same loop higher up: same sense, area within 2 %, nearest centre
            const match = section
                .filter(
                    (l) =>
                        Math.sign(loopArea(l)) === Math.sign(a0) &&
                        Math.abs(loopArea(l) - a0) <= Math.abs(a0) * 0.02,
                )
                .map((l) => ({ c: centroid(l) }))
                .sort(
                    (a, b) =>
                        Math.hypot(a.c[0] - c0[0], a.c[1] - c0[1]) -
                        Math.hypot(b.c[0] - c0[0], b.c[1] - c0[1]),
                )[0];
            if (match === undefined) return undefined;
            centres.push(match.c);
        }
        const f1 = SAMPLES[SAMPLES.length - 1] - SAMPLES[0];
        const last = centres[centres.length - 1];
        const total: [number, number] = [(last[0] - c0[0]) / f1, (last[1] - c0[1]) / f1];
        for (let k = 0; k < centres.length; k++) {
            const f = SAMPLES[k + 1] - SAMPLES[0];
            if (
                Math.hypot(centres[k][0] - c0[0] - total[0] * f, centres[k][1] - c0[1] - total[1] * f) > slack
            )
                return undefined;
        }
        if (shift === undefined) shift = total;
        else if (Math.hypot(shift[0] - total[0], shift[1] - total[1]) > slack) return undefined;
    }
    if (shift === undefined || Math.hypot(shift[0], shift[1]) < Math.max(tol * 4, span * 0.005))
        return undefined;
    return shift;
}

/**
 * Whether a curved band is worth four short cones instead of one straight slab: the volume the
 * straight slab gets wrong (its section against the band's, height by height) less what four
 * linear pieces would, against 0.2 % of the part. Read off nine sections, no kernel call.
 */
function splitPays(mesh: TriMesh, frame: SliceFrame, slab: Slab, tol: number, partVolume: number): boolean {
    const { straight, pieces } = bandError(mesh, frame, slab, tol);
    return straight - pieces > partVolume * 0.002;
}

/** The volume a straight slab and four linear pieces get wrong across a band (nine sections). */
function bandError(
    mesh: TriMesh,
    frame: SliceFrame,
    slab: Slab,
    tol: number,
): { straight: number; pieces: number } {
    const span = slab.top - slab.bottom;
    const n = 8;
    const areas: number[] = [];
    for (let k = 0; k <= n; k++) {
        const z = slab.bottom + span * (0.002 + (0.996 * k) / n);
        areas.push(
            sectionAt(mesh, frame, z, span * 0.01)
                .filter((l) => Math.abs(loopArea(l)) > tol * tol)
                .reduce((a, l) => a + loopArea(l), 0),
        );
    }
    const mid = areas[n / 2];
    const dz = span / n;
    let straight = 0;
    let pieces = 0;
    for (let k = 0; k <= n; k++) {
        straight += Math.abs(areas[k] - mid) * dz;
        // four pieces: linear between every second sample
        const a = Math.floor(k / 2) * 2;
        const b = Math.min(a + 2, n);
        const t = b === a ? 0 : (k - a) / (b - a);
        pieces += Math.abs(areas[k] - (areas[a] + (areas[b] - areas[a]) * t)) * dz;
    }
    return { straight, pieces };
}

/**
 * A slab with leaning walls as one or more tapered slabs: the whole slab when its taper is
 * linear (a draft, a cone, a countersink), else split in four and each part tapered on its own
 * (a round, followed by short cones). Undefined when even the parts do not taper cleanly.
 */
function taperedSlabs(
    mesh: TriMesh,
    frame: SliceFrame,
    slab: Slab,
    tol: number,
    depth = 0,
    maxDepth = 0,
): { bottom: number; top: number; loops: TaperedLoop[] }[] | undefined {
    // a piece of a split band is a chord of a curve: it may bow by a few % of its height
    const loops = taperOf(mesh, frame, slab.bottom, slab.top, tol, depth > 0 ? 0.03 : 0.004);
    if (loops !== undefined) return [{ bottom: slab.bottom, top: slab.top, loops }];
    // a curved band is cut into short cones only when asked (`maxDepth`): an edge round is
    // recognised as a round instead, and a band is split only when that pays (`splitPays`)
    if (depth >= maxDepth) return undefined;
    const parts: { bottom: number; top: number; loops: TaperedLoop[] }[] = [];
    const n = 4;
    const span = slab.top - slab.bottom;
    for (let i = 0; i < n; i++) {
        const part = taperedSlabs(
            mesh,
            frame,
            { ...slab, bottom: slab.bottom + (span * i) / n, top: slab.bottom + (span * (i + 1)) / n },
            tol,
            depth + 1,
            maxDepth,
        );
        if (part === undefined) return undefined;
        parts.push(...part);
    }
    return parts;
}

/**
 * The part as extrudes along one frame: every slab between two cap heights is its section
 * extruded (neighbours with the same section merged into one), and every round hole is taken out
 * of the slabs it runs through and cut on its own — so the tree reads «body, body, …, hole Ø6,
 * hole Ø3», and a hole's diameter is one number to edit. A slab whose walls lean is extruded
 * with a taper; a hole tapering apart from the walls around it (a countersink) is a tapered cut.
 *
 * `tol` is the fit tolerance in mm. `holes: false` keeps holes in the sketches (for the small
 * corrective pieces, where splitting them out would only add features).
 */
export function planExtrusions(
    mesh: TriMesh,
    frame: SliceFrame,
    tol: number,
    options: {
        holes?: boolean;
        operation?: "fuse" | "cut";
        role?: PlannedExtrude["role"];
        /** When given, rounded and chamfered edges are recognised: their slabs go, the edges are collected here. */
        treatments?: EdgeTreatment[];
    } = {},
): PlannedExtrude[] {
    const q = Math.max(tol * 5, 1e-4);
    const fit = (loops: Loop2D[]) =>
        loops.map((l) => fitProfile(l, tol)).filter((p): p is Profile2D => p !== undefined);
    const slabs: FittedSlab[] = [];
    /** Tapered holes and islands that do not lean with their slab: extruded on their own. */
    const separate: PlannedExtrude[] = [];
    const raw = slabsOf(mesh, frame);
    const partVolume = Math.abs(meshVolume(mesh));
    const source = options.treatments ? absorbEdgeBands(mesh, frame, raw, tol, options.treatments) : raw;
    for (const s of source) {
        if (s.loops.length === 0) continue;
        let tapered = s.slanted >= SLANTED ? taperedSlabs(mesh, frame, s, tol) : undefined;
        if (tapered === undefined && s.slanted >= SLANTED && splitPays(mesh, frame, s, tol, partVolume)) {
            tapered = taperedSlabs(mesh, frame, s, tol, 0, 1);
        }
        const lean =
            s.slanted >= SLANTED && tapered === undefined
                ? obliqueOf(mesh, frame, s.bottom, s.top, tol)
                : undefined;
        DEBUG_HOOK?.(
            `slab ${s.bottom.toFixed(2)}..${s.top.toFixed(2)} slanted ${s.slanted.toFixed(2)} tapered ${tapered !== undefined} lean ${lean?.map((x) => x.toFixed(2))}`,
        );
        if (lean !== undefined) {
            // its bottom section, swept along the lean
            const low = sectionAt(
                mesh,
                frame,
                s.bottom + (s.top - s.bottom) * 0.002,
                (s.top - s.bottom) * 0.01,
            ).filter((l) => Math.abs(loopArea(l)) > tol * tol);
            slabs.push({ bottom: s.bottom, top: s.top, loops: low, profiles: fit(low), lean });
            continue;
        }
        if (tapered === undefined) {
            // leaning walls no feature here describes: the part's own piece, if it is worth it
            const fromMesh =
                s.slanted >= SLANTED && bandError(mesh, frame, s, tol).straight > partVolume * 5e-4;
            slabs.push({
                bottom: s.bottom,
                top: s.top,
                loops: s.loops,
                profiles: fit(s.loops),
                ...(fromMesh ? { fromMesh: true } : {}),
            });
            continue;
        }
        for (const part of tapered) {
            // the slab leans as its largest material loop does; loops leaning otherwise go apart
            const main = part.loops
                .filter((l) => loopArea(l.loop) > 0)
                .sort((a, b) => loopArea(b.loop) - loopArea(a.loop))[0];
            const draft = main?.draft ?? 0;
            const together = part.loops.filter((l) => Math.abs(l.draft - draft) < 0.2);
            const mid = sectionAt(mesh, frame, (part.bottom + part.top) / 2, (part.top - part.bottom) * 0.01);
            slabs.push({
                bottom: part.bottom,
                top: part.top,
                loops: together.map((l) => l.loop),
                profiles: fit(together.map((l) => l.loop)),
                ...(draft !== 0 ? { draft, straight: fit(mid) } : {}),
            });
            for (const apart of part.loops.filter((l) => Math.abs(l.draft - draft) >= 0.2)) {
                const profile = fitProfile(apart.loop, tol);
                if (profile === undefined) continue;
                const hole = loopArea(apart.loop) < 0;
                separate.push({
                    frame,
                    base: part.bottom,
                    depth: part.top - part.bottom,
                    // a hole is cut as material to take away: its taper, seen from the cut, flips
                    profiles: [asMaterial(profile)],
                    operation: hole ? "cut" : "fuse",
                    role: hole ? "hole" : (options.role ?? "body"),
                    ...(apart.draft !== 0 ? { draft: hole ? -apart.draft : apart.draft } : {}),
                });
            }
        }
    }

    const plans: PlannedExtrude[] = [];
    const holeCuts: PlannedExtrude[] = [];
    if (options.holes !== false) {
        // round holes: a clockwise circle, followed through the neighbouring straight slabs it runs on in
        for (let i = 0; i < slabs.length; i++) {
            if (slabs[i].draft !== undefined || slabs[i].lean !== undefined) continue;
            for (const hole of [...slabs[i].profiles]) {
                if (hole.kind !== "circle" || hole.ccw) continue;
                const key = profileKey(hole, q);
                let j = i;
                while (
                    j + 1 < slabs.length &&
                    slabs[j + 1].draft === undefined &&
                    slabs[j + 1].lean === undefined &&
                    Math.abs(slabs[j + 1].bottom - slabs[j].top) <= q
                ) {
                    const next = slabs[j + 1].profiles.find((p) => profileKey(p, q) === key);
                    if (next === undefined) break;
                    j++;
                }
                for (let k = i; k <= j; k++)
                    slabs[k].profiles = slabs[k].profiles.filter((p) => profileKey(p, q) !== key);
                // a cut ending in air runs on past the face, so the boolean never meets it edge-on
                const span = slabs[j].top - slabs[i].bottom;
                const ext = Math.max(span * 0.05, 0.5);
                const below = i === 0 || !insideLoops(slabs[i - 1].loops, hole.c[0], hole.c[1]) ? ext : 0;
                const above =
                    j === slabs.length - 1 || !insideLoops(slabs[j + 1].loops, hole.c[0], hole.c[1])
                        ? ext
                        : 0;
                holeCuts.push({
                    frame,
                    base: slabs[i].bottom - below,
                    depth: span + below + above,
                    // the cut's own sketch: the circle as material to take away
                    profiles: [{ ...hole, ccw: true }],
                    operation: "cut",
                    role: "hole",
                });
            }
        }
    }

    // neighbours with the same section are one extrude (straight ones only: a taper changes it)
    const merged: FittedSlab[] = [];
    for (const s of slabs) {
        if (s.profiles.length === 0) continue;
        const last = merged[merged.length - 1];
        if (
            last &&
            last.draft === undefined &&
            s.draft === undefined &&
            last.lean === undefined &&
            s.lean === undefined &&
            !last.fromMesh &&
            !s.fromMesh &&
            Math.abs(last.top - s.bottom) <= q &&
            slabKey(last, q) === slabKey(s, q)
        ) {
            merged[merged.length - 1] = { ...last, top: s.top };
        } else {
            merged.push({ ...s });
        }
    }
    for (const s of merged) {
        // a section that is only holes (all clockwise) holds no material
        if (!s.profiles.some((p) => profileArea(p) > 0)) continue;
        plans.push({
            frame,
            base: s.bottom,
            depth: s.top - s.bottom,
            profiles: s.profiles,
            role: options.role ?? "body",
            ...(options.operation ? { operation: options.operation } : {}),
            ...(s.draft !== undefined ? { draft: s.draft, straight: s.straight } : {}),
            ...(s.lean !== undefined ? { lean: s.lean } : {}),
            ...(s.fromMesh ? { fromMesh: true } : {}),
        });
    }
    if (options.operation === undefined) {
        plans.forEach((p, i) => {
            if (i > 0) (p as { operation?: "fuse" | "cut" }).operation = "fuse";
        });
    }
    // islands leaning apart join; holes cut — after the slabs they sit in; one running on
    // through the next slab with the same section and taper is one extrude
    const joined: PlannedExtrude[] = [];
    for (const p of separate) {
        const last = joined[joined.length - 1];
        // the same section, however its facets happened to fit: area and centre agree
        const key = (x: PlannedExtrude) =>
            `${x.operation}|${x.draft ?? 0}|${x.profiles.map((y) => shapeKey(y, q)).join("|")}`;
        if (
            last &&
            (last.draft ?? 0) === 0 &&
            (p.draft ?? 0) === 0 &&
            Math.abs(last.base + last.depth - p.base) <= q &&
            key(last) === key(p)
        ) {
            joined[joined.length - 1] = { ...last, depth: p.base + p.depth - last.base };
        } else {
            joined.push(p);
        }
    }
    const apart = joined.map((p) =>
        options.operation === undefined
            ? p
            : { ...p, operation: options.operation, role: options.role ?? p.role },
    );
    return [...plans, ...apart, ...holeCuts];
}

/** Diagnostics for the corpus test (unset in the app). */
export let DEBUG_HOOK: ((line: string) => void) | undefined;
export function setPlanDebug(hook: ((line: string) => void) | undefined) {
    DEBUG_HOOK = hook;
}

/** A rounded or chamfered edge of the rebuilt part: where it runs and how big it is. */
export interface EdgeTreatment {
    readonly frame: SliceFrame;
    /** Height of the edge along the frame's axis. */
    readonly height: number;
    /** The loops (in the frame's u, v) the edge runs along. */
    readonly loops: readonly Loop2D[];
    /** The stretches of the loops that are rounded (the rest of the edge stays sharp). */
    readonly moved: readonly { a: [number, number]; b: [number, number] }[];
    readonly kind: "fillet" | "chamfer";
    /** Radius, or the chamfer's distance. */
    readonly size: number;
}

function segmentDistance2(
    p: readonly [number, number],
    a: readonly [number, number],
    b: readonly [number, number],
): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Distance from a point to the nearest segment of any of the loops. */
export function distanceToLoops(p: readonly [number, number], loops: readonly Loop2D[]): number {
    let best = Number.POSITIVE_INFINITY;
    for (const loop of loops) {
        for (let i = 0; i < loop.length; i++)
            best = Math.min(best, segmentDistance2(p, loop[i], loop[(i + 1) % loop.length]));
    }
    return best;
}

function areaOf(loops: readonly Loop2D[]): number {
    return loops.reduce((a, l) => a + loopArea(l), 0);
}

function perimeterOf(loops: readonly Loop2D[]): number {
    return loops.reduce((a, l) => a + perimeter(l), 0);
}

/**
 * Slabs that are an edge's round or chamfer folded into the straight slab beside them: the band
 * whose bottom section is the slab below's goes into that slab (its top edge rounds off), one
 * whose top section is the slab above's into that one (its bottom edge, or the fillet at its
 * foot). The edge that is left sharp is recorded with the band's size, to be rounded or
 * chamfered as a feature of its own. A band that is neither — or whose two sizes disagree, not a
 * round or an equal chamfer — stays a slab.
 */
function absorbEdgeBands(
    mesh: TriMesh,
    frame: SliceFrame,
    raw: readonly Slab[],
    tol: number,
    out: EdgeTreatment[],
): Slab[] {
    const slabs: Slab[] = raw.map((x) => ({ ...x }));
    const q = Math.max(tol * 5, 1e-4);
    for (let i = 0; i < slabs.length; i++) {
        const band = slabs[i];
        if (band.slanted < SLANTED || band.loops.length === 0) continue;
        const span = band.top - band.bottom;
        const near = (z: number) =>
            sectionAt(mesh, frame, z, span * 0.01).filter((l) => Math.abs(loopArea(l)) > tol * tol);
        const low = near(band.bottom + span * 0.002);
        const high = near(band.top - span * 0.002);
        const aLow = areaOf(low);
        const aHigh = areaOf(high);
        const linear = taperOf(mesh, frame, band.bottom, band.top, tol) !== undefined;
        const below =
            i > 0 && Math.abs(slabs[i - 1].top - band.bottom) <= q && slabs[i - 1].slanted < SLANTED
                ? slabs[i - 1]
                : undefined;
        const above =
            i + 1 < slabs.length &&
            Math.abs(slabs[i + 1].bottom - band.top) <= q &&
            slabs[i + 1].slanted < SLANTED
                ? slabs[i + 1]
                : undefined;
        const same = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 0.02 + tol * 10;
        let host: Slab | undefined;
        let height = 0;
        if (below && same(aLow, areaOf(below.loops)) && below.loops.length === low.length) {
            host = below;
            height = band.top;
        } else if (above && same(aHigh, areaOf(above.loops)) && above.loops.length === high.length) {
            host = above;
            height = band.bottom;
        }
        DEBUG_HOOK?.(
            `band ${band.bottom.toFixed(3)}..${band.top.toFixed(3)} host ${host === undefined ? "none" : host === below ? "below" : "above"} aLow ${aLow.toFixed(1)} aHigh ${aHigh.toFixed(1)} below ${below ? areaOf(below.loops).toFixed(1) : "-"} above ${above ? areaOf(above.loops).toFixed(1) : "-"} loops ${low.length}/${high.length} linear ${linear}`,
        );
        if (host === undefined) continue;
        // how far each point of the section beside the host moved across the band: a rounded
        // stretch of the edge by the round's size, a stretch left sharp not at all
        const nearSide = host === below ? low : high;
        const farSide = host === below ? high : low;
        const moved: { a: [number, number]; b: [number, number] }[] = [];
        const shifts: number[] = [];
        for (const loop of nearSide) {
            const d = loop.map((p) => distanceToLoops(p, farSide));
            for (let k = 0; k < loop.length; k++) {
                const k2 = (k + 1) % loop.length;
                if (d[k] > tol * 4 && d[k2] > tol * 4) {
                    moved.push({ a: loop[k], b: loop[k2] });
                    shifts.push(d[k], d[k2]);
                }
            }
        }
        if (moved.length === 0) continue;
        shifts.sort((a, b) => a - b);
        // where rounds meet at a corner the shift runs down to nothing: the round's size is where
        // it is whole, near the top of the shifts
        const across = shifts[Math.min(shifts.length - 1, Math.floor(shifts.length * 0.9))];
        DEBUG_HOOK?.(`  moved ${moved.length} across ${across.toFixed(3)} span ${span.toFixed(3)}`);
        // a round's two legs are its radius; an equal chamfer's, its distance
        if (Math.abs(across - span) > Math.max(span, across) * 0.25) continue;
        const kind = linear ? "chamfer" : "fillet";
        out.push({
            frame,
            height,
            loops: host.loops,
            moved,
            kind,
            size: Number.parseFloat(((span + across) / 2).toFixed(4)),
        });
        const index = slabs.indexOf(host);
        slabs[index] = host === below ? { ...host, top: band.top } : { ...host, bottom: band.bottom };
        slabs.splice(i, 1);
        i--;
    }
    return slabs;
}

/** A profile as material (counter-clockwise), whatever sense it was read in. */
function asMaterial(p: Profile2D): Profile2D {
    if (p.kind === "circle") return { ...p, ccw: true };
    if (profileArea(p) > 0) return p;
    return {
        kind: "chain",
        curves: [...p.curves]
            .reverse()
            .map((c) =>
                c.kind === "line" ? { ...c, a: c.b, b: c.a } : { ...c, a: c.b, b: c.a, ccw: !c.ccw },
            ),
    };
}
