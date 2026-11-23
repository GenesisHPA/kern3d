// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Pt } from "./geometry";
import type { LaserJobData, LaserObject } from "./laserData";

/**
 * A rotary chuck on a galvo machine. The part turns about an axis lying along the job's X: the
 * job's Y is the part's surface unrolled (one turn = π·diameter mm). The galvo marks what is
 * under it, the chuck turns the part, the galvo marks the next stretch.
 *
 * - "strips" (as EzCAD's rotary marking): the unrolled job is cut into bands across Y, each
 *   `stripWidth` wide; a band is marked at the field's centre line (where the surface is square
 *   to the beam), then the part turns by the band's width.
 * - "index": each object is marked whole at its own angle (`LaserObject.rotaryAngle`), the part
 *   turned to it first — text on four sides of a part, say.
 */
export interface RotaryJob {
    enabled: boolean;
    mode: "strips" | "index";
    /** Diameter of the part where it is marked, mm. */
    diameter: number;
    /** Length of the part along the axis, mm: the unrolled field's width. */
    length: number;
    /** Band width in "strips" mode, mm on the surface. Narrow = less distortion on the curve. */
    stripWidth: number;
}

/** The machine's rotary axis as the board drives it. */
export interface RotaryAxis {
    /** The board's axis number (EzCAD «Ось расширения» 0 / 1). */
    axis: number;
    /** Pulses for one turn of the chuck: motor steps × microsteps × gear ratio. */
    pulsesPerRev: number;
    /** Turning direction reversed. */
    invert: boolean;
    /** Back to the start angle when the job ends. */
    returnToStart: boolean;
    /** Time to let the chuck settle after a turn, ms. */
    settleMs: number;
}

export function defaultRotaryJob(): RotaryJob {
    return { enabled: false, mode: "strips", diameter: 100, length: 100, stripWidth: 4 };
}

export function defaultRotaryAxis(): RotaryAxis {
    return { axis: 0, pulsesPerRev: 3200, invert: false, returnToStart: true, settleMs: 150 };
}

/** One stop of the chuck: the angle to turn to, and what is marked there. */
export interface RotaryStep {
    /** Degrees from the job's start (0 = the first band / angle). */
    angle: number;
    /** Only the moves with job Y inside this band are marked ("strips"). */
    clipY?: [number, number];
    /** Added to job Y so the band lies on the field's centre line. */
    shiftY: number;
    /** Only these objects ("index"). */
    objects?: ReadonlySet<string>;
}

/** Surface mm per degree of the chuck. */
export function mmPerDegree(diameter: number): number {
    return (Math.PI * Math.max(1e-6, diameter)) / 360;
}

/** The object's box corners on the bed (rotation included). */
function corners(o: LaserObject): Pt[] {
    const cx = o.x + o.width / 2;
    const cy = o.y + o.height / 2;
    const a = (o.angle * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
    ].map(([u, v]) => {
        const dx = (u * o.width) / 2;
        const dy = (v * o.height) / 2;
        return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
    });
}

/** Y range the visible objects cover, or undefined when there are none. */
export function jobYRange(job: LaserJobData): [number, number] | undefined {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const o of job.objects) {
        if (o.hidden) continue;
        for (const p of corners(o)) {
            lo = Math.min(lo, p.y);
            hi = Math.max(hi, p.y);
        }
    }
    return lo <= hi ? [lo, hi] : undefined;
}

/**
 * The chuck's stops for a job. `centerY` is the job Y of the field's centre line (0 with the
 * origin in the field's centre). "strips": the first band starts at the job's lowest Y, its
 * centre is angle 0; "index": the objects grouped by their angle, in increasing order.
 */
export function rotarySteps(job: LaserJobData, rotary: RotaryJob, centerY: number): RotaryStep[] {
    if (rotary.mode === "index") {
        const groups = new Map<number, Set<string>>();
        for (const o of job.objects) {
            if (o.hidden) continue;
            const angle = Math.round((o.rotaryAngle ?? 0) * 1000) / 1000;
            if (!groups.has(angle)) groups.set(angle, new Set());
            groups.get(angle)!.add(o.id);
        }
        return [...groups.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([angle, objects]) => ({ angle, shiftY: 0, objects }));
    }
    const range = jobYRange(job);
    if (range === undefined) return [];
    const width = Math.max(0.2, rotary.stripWidth);
    const count = Math.max(1, Math.ceil((range[1] - range[0]) / width - 1e-9));
    const perDegree = mmPerDegree(rotary.diameter);
    const firstCenter = range[0] + width / 2;
    const steps: RotaryStep[] = [];
    for (let k = 0; k < count; k++) {
        const y0 = range[0] + k * width;
        const center = y0 + width / 2;
        steps.push({
            angle: (center - firstCenter) / perDegree,
            clipY: [y0, y0 + width],
            shiftY: centerY - center,
        });
    }
    return steps;
}

/**
 * The parts of a polyline with Y inside [y0, y1), cut where it crosses the band's edges. A point
 * on the upper edge belongs to the next band, so a line along an edge is marked once.
 */
export function clipPolylineY(line: readonly Pt[], y0: number, y1: number): Pt[][] {
    const out: Pt[][] = [];
    let current: Pt[] = [];
    const inside = (p: Pt) => p.y >= y0 && p.y < y1;
    for (let i = 0; i < line.length; i++) {
        const p = line[i];
        if (i === 0) {
            if (inside(p)) current.push(p);
            continue;
        }
        const a = line[i - 1];
        // the segment's part inside the band, by its crossings of both edges
        const ts: number[] = [0, 1];
        for (const y of [y0, y1]) {
            if ((a.y - y) * (p.y - y) < 0) ts.push((y - a.y) / (p.y - a.y));
        }
        ts.sort((u, v) => u - v);
        for (let j = 0; j < ts.length - 1; j++) {
            const ta = ts[j];
            const tb = ts[j + 1];
            if (tb - ta < 1e-12) continue;
            const mid = { x: a.x + (p.x - a.x) * ((ta + tb) / 2), y: a.y + (p.y - a.y) * ((ta + tb) / 2) };
            const pa = { x: a.x + (p.x - a.x) * ta, y: a.y + (p.y - a.y) * ta };
            const pb = { x: a.x + (p.x - a.x) * tb, y: a.y + (p.y - a.y) * tb };
            if (inside(mid) || (mid.y === y0 && a.y === p.y)) {
                if (current.length === 0) current.push(pa);
                current.push(pb);
            } else if (current.length > 0) {
                if (current.length > 1) out.push(current);
                current = [];
            }
        }
    }
    if (current.length > 1) out.push(current);
    return out;
}

/** Chuck position in pulses for an angle (degrees), with the direction setting. */
export function anglePulses(angle: number, axis: RotaryAxis): number {
    return Math.round(((axis.invert ? -angle : angle) / 360) * axis.pulsesPerRev);
}
