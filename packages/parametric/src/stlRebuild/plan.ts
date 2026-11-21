// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { fitProfile, type Profile2D, profileArea } from "./fit2d";
import type { TriMesh } from "./mesh";
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
}

interface FittedSlab {
    readonly bottom: number;
    readonly top: number;
    readonly loops: Loop2D[];
    profiles: Profile2D[];
    /** Set on a tapered slab: its profiles are its bottom section. */
    readonly draft?: number;
    readonly straight?: Profile2D[];
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

function centroid(loop: Loop2D): [number, number] {
    let x = 0;
    let y = 0;
    for (const p of loop) {
        x += p[0];
        y += p[1];
    }
    return [x / loop.length, y / loop.length];
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
): TaperedLoop[] | undefined {
    const span = top - bottom;
    const sections = SAMPLES.map((f) => ({
        z: bottom + f * span,
        loops: sectionAt(mesh, frame, bottom + f * span, span * 0.01).filter(
            (l) => Math.abs(loopArea(l)) > tol * tol,
        ),
    }));
    const base = sections[0].loops;
    if (base.length === 0 || sections.some((s) => s.loops.length !== base.length)) return undefined;
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
            const dz = section.z - sections[0].z;
            // inward offset of the material: positive when the material shrinks upward
            const offset = (a0 - loopArea(best)) / ((p0 + perimeter(best)) / 2);
            points.push([dz, offset]);
            num += dz * offset;
            den += dz * dz;
        }
        const slope = den > 0 ? num / den : 0;
        const residual = Math.max(...points.map(([dz, d]) => Math.abs(d - slope * dz)));
        if (residual > Math.max(tol * 2, span * 0.004)) return undefined;
        const draft = (Math.atan(slope) * 180) / Math.PI;
        if (Math.abs(draft) >= 80) return undefined;
        result.push({ loop, draft: Math.abs(draft) < 0.05 ? 0 : draft });
    }
    return result;
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
): { bottom: number; top: number; loops: TaperedLoop[] }[] | undefined {
    const loops = taperOf(mesh, frame, slab.bottom, slab.top, tol);
    if (loops !== undefined) return [{ bottom: slab.bottom, top: slab.top, loops }];
    if (depth >= 1) return undefined;
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
    options: { holes?: boolean; operation?: "fuse" | "cut"; role?: PlannedExtrude["role"] } = {},
): PlannedExtrude[] {
    const q = Math.max(tol * 5, 1e-4);
    const fit = (loops: Loop2D[]) =>
        loops.map((l) => fitProfile(l, tol)).filter((p): p is Profile2D => p !== undefined);
    const slabs: FittedSlab[] = [];
    /** Tapered holes and islands that do not lean with their slab: extruded on their own. */
    const separate: PlannedExtrude[] = [];
    for (const s of slabsOf(mesh, frame)) {
        if (s.loops.length === 0) continue;
        const tapered = s.slanted >= SLANTED ? taperedSlabs(mesh, frame, s, tol) : undefined;
        if (tapered === undefined) {
            slabs.push({ bottom: s.bottom, top: s.top, loops: s.loops, profiles: fit(s.loops) });
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
            if (slabs[i].draft !== undefined) continue;
            for (const hole of [...slabs[i].profiles]) {
                if (hole.kind !== "circle" || hole.ccw) continue;
                const key = profileKey(hole, q);
                let j = i;
                while (
                    j + 1 < slabs.length &&
                    slabs[j + 1].draft === undefined &&
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
