// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { apply, type Bounds, isEmpty, type Pt, transformPaths } from "./geometry";
import { hatchPaths } from "./hatch";
import {
    jobBounds,
    type LaserImageObject,
    type LaserJobData,
    type LaserObject,
    type LaserVectorObject,
    objectMatrix,
    placement,
} from "./laserData";
import type { MachineProfile } from "./machineProfile";
import { orderPaths } from "./pathOrder";
import { type GrayImage, powerMap, resampleGray } from "./raster";

/** A white stretch of a raster line longer than this is crossed with G0 instead of G1 S0, mm. */
export const WHITE_SKIP = 1;

/** A coordinate or value as GRBL reads it: at most three decimals, no trailing zeros, no "-0". */
export function fmt(value: number): string {
    const rounded = Math.round(value * 1000) / 1000;
    if (Object.is(rounded, -0) || rounded === 0) return "0";
    return String(rounded);
}

/**
 * Emits G-code with only the words that change: a move repeats X/Y only when they differ, S and
 * F only when they change. Motion is always written (G0 or G1) so each line reads on its own.
 */
export class GcodeWriter {
    readonly lines: string[] = [];
    private x: number | undefined;
    private y: number | undefined;
    private s: number | undefined;
    private f: number | undefined;
    /** Keeps the head inside the bed (overscan at an edge would otherwise run past it). */
    clamp?: { width: number; height: number };

    get position(): Pt {
        return { x: this.x ?? 0, y: this.y ?? 0 };
    }

    raw(line: string) {
        this.lines.push(line);
    }

    private axes(p: Pt): string {
        const x = this.clamp === undefined ? p.x : Math.min(this.clamp.width, Math.max(0, p.x));
        const y = this.clamp === undefined ? p.y : Math.min(this.clamp.height, Math.max(0, p.y));
        let words = "";
        if (this.x === undefined || fmt(x) !== fmt(this.x)) words += ` X${fmt(x)}`;
        if (this.y === undefined || fmt(y) !== fmt(this.y)) words += ` Y${fmt(y)}`;
        this.x = x;
        this.y = y;
        return words;
    }

    rapid(p: Pt) {
        const words = this.axes(p);
        if (words !== "") this.lines.push(`G0${words}`);
    }

    cut(p: Pt, s: number, feed: number) {
        const words = this.axes(p);
        if (words === "") return;
        let line = `G1${words}`;
        const sv = Math.round(s);
        if (this.s !== sv) line += ` S${sv}`;
        if (this.f !== feed) line += ` F${fmt(feed)}`;
        this.s = sv;
        this.f = feed;
        this.lines.push(line);
    }
}

export interface GcodeResult {
    lines: string[];
    /** i18n keys of what the user should know: the job runs past the bed, an image is missing… */
    warnings: string[];
}

function sOf(o: LaserObject, profile: MachineProfile): number {
    return (Math.max(0, Math.min(100, o.op.power)) / 100) * profile.maxS;
}

function vectorLines(o: LaserVectorObject, w: GcodeWriter, profile: MachineProfile) {
    const paths = transformPaths(o.paths, objectMatrix(o));
    const s = sOf(o, profile);
    for (const trace of orderPaths(paths, w.position)) {
        w.rapid(trace[0]);
        for (let k = 1; k < trace.length; k++) w.cut(trace[k], s, o.op.speed);
    }
}

function fillLines(o: LaserVectorObject, w: GcodeWriter, profile: MachineProfile) {
    const paths = transformPaths(o.paths, objectMatrix(o));
    const s = sOf(o, profile);
    for (const segment of hatchPaths(paths, o.op.fillInterval, o.op.fillAngle + o.angle)) {
        w.rapid(segment.from);
        w.cut(segment.to, s, o.op.speed);
    }
}

/** One raster line's runs of equal power: [startColumn, endColumn (exclusive), S]. */
function runsOf(power: Float32Array, row: number, cols: number, maxS: number): [number, number, number][] {
    const runs: [number, number, number][] = [];
    for (let c = 0; c < cols; c++) {
        const s = Math.round(power[row * cols + c] * maxS);
        const last = runs[runs.length - 1];
        if (last !== undefined && last[2] === s) last[1] = c + 1;
        else runs.push([c, c + 1, s]);
    }
    while (runs.length > 0 && runs[0][2] === 0) runs.shift();
    while (runs.length > 0 && runs[runs.length - 1][2] === 0) runs.pop();
    return runs;
}

/**
 * Line-by-line engraving of a picture: the image resampled to the resolution over the object's
 * size, one scan line per row from the bottom, alternating direction. Each line is entered
 * `overscan` before its first burnt pixel and left the same distance after its last, with the
 * laser at S0, so the head turns round off the work; equal-power pixels merge into one move and
 * a long white stretch is crossed with G0.
 */
export function rasterLines(o: LaserImageObject, image: GrayImage, w: GcodeWriter, profile: MachineProfile) {
    const r = o.op.raster;
    const cols = Math.max(1, Math.round(o.width * r.resolution));
    const rows = Math.max(1, Math.round(o.height * r.resolution));
    const px = o.width / cols;
    const py = o.height / rows;
    const power = powerMap(resampleGray(image, cols, rows), r);
    const m = placement(o);
    const at = (x: number, y: number) => apply(m, { x, y });
    const maxS = sOf(o, profile);
    const feed = o.op.speed;
    let line = 0;
    for (let k = 0; k < rows; k++) {
        const row = rows - 1 - k; // image rows run top-down, the bed's y up
        const runs = runsOf(power, row, cols, maxS);
        if (runs.length === 0) continue;
        const y = (k + 0.5) * py;
        const forward = line % 2 === 0;
        line++;
        if (!forward) runs.reverse();
        const edge = (c: number) => c * px;
        const first = forward ? edge(runs[0][0]) : edge(runs[0][1]);
        const last = forward ? edge(runs[runs.length - 1][1]) : edge(runs[runs.length - 1][0]);
        const dir = forward ? 1 : -1;
        w.rapid(at(first - dir * r.overscan, y));
        if (r.overscan > 0) w.cut(at(first, y), 0, feed);
        for (const [c0, c1, s] of runs) {
            const end = forward ? edge(c1) : edge(c0);
            if (s === 0 && (c1 - c0) * px > WHITE_SKIP) w.rapid(at(end, y));
            else w.cut(at(end, y), s, feed);
        }
        if (r.overscan > 0) w.cut(at(last + dir * r.overscan, y), 0, feed);
    }
}

function outsideBed(b: Bounds, profile: MachineProfile): boolean {
    const eps = 1e-6;
    return (
        b.minX < -eps || b.minY < -eps || b.maxX > profile.bedWidth + eps || b.maxY > profile.bedHeight + eps
    );
}

/**
 * The whole job as GRBL 1.1 G-code for laser mode (`$32=1`): millimetres, absolute, M4 (or M3)
 * with S0 so G0 moves never burn, then every visible object in list order, each pass after the
 * other, air assist around the objects that want it, and the laser off at the end.
 * `images` holds the pixels of the image objects by id.
 */
export function generateGcode(
    job: LaserJobData,
    profile: MachineProfile,
    images: ReadonlyMap<string, GrayImage> = new Map(),
): GcodeResult {
    const w = new GcodeWriter();
    const warnings: string[] = [];
    const objects = job.objects.filter((o) => !o.hidden);
    const bounds = jobBounds(job);
    if (!isEmpty(bounds) && outsideBed(bounds, profile)) warnings.push("laser.warn.outsideBed");
    w.raw("; Kern3D laser job");
    w.raw(`; bed ${fmt(profile.bedWidth)} x ${fmt(profile.bedHeight)} mm, S max ${fmt(profile.maxS)}`);
    w.raw("G21");
    w.raw("G90");
    w.raw(`${profile.dynamicPower ? "M4" : "M3"} S0`);
    w.clamp = { width: profile.bedWidth, height: profile.bedHeight };
    for (const o of objects) {
        w.raw(`; ${o.name.replace(/[\r\n;()]/g, " ")}`);
        if (o.op.air) w.raw("M8");
        for (let pass = 0; pass < Math.max(1, o.op.passes); pass++) {
            if (o.kind === "image") {
                const image = images.get(o.id);
                if (image === undefined) {
                    if (!warnings.includes("laser.warn.imageMissing"))
                        warnings.push("laser.warn.imageMissing");
                    break;
                }
                rasterLines(o, image, w, profile);
            } else if (o.op.mode === "fill") fillLines(o, w, profile);
            else vectorLines(o, w, profile);
        }
        if (o.op.air) w.raw("M9");
    }
    w.raw("M5");
    if (profile.returnHome) w.rapid({ x: 0, y: 0 });
    return { lines: w.lines, warnings };
}

/**
 * Tracing the job's box so the work can be lined up under the head: laser off (M5 and G0) when
 * `framePower` is 0, otherwise a faint constant-power line (M3) at `frameSpeed`.
 */
export function frameGcode(bounds: Bounds, profile: MachineProfile): string[] {
    if (isEmpty(bounds)) return [];
    const corners: Pt[] = [
        { x: bounds.minX, y: bounds.minY },
        { x: bounds.maxX, y: bounds.minY },
        { x: bounds.maxX, y: bounds.maxY },
        { x: bounds.minX, y: bounds.maxY },
        { x: bounds.minX, y: bounds.minY },
    ];
    const w = new GcodeWriter();
    w.raw("G21");
    w.raw("G90");
    const s = (Math.max(0, Math.min(100, profile.framePower)) / 100) * profile.maxS;
    if (s <= 0) {
        w.raw("M5");
        w.rapid(corners[0]);
        for (const c of corners.slice(1)) {
            const words = `X${fmt(c.x)} Y${fmt(c.y)}`;
            w.raw(`G1 ${words} F${fmt(profile.frameSpeed)}`);
        }
        return w.lines;
    }
    w.rapid(corners[0]);
    w.raw("M3 S0");
    for (const c of corners.slice(1)) w.cut(c, s, profile.frameSpeed);
    w.raw("M5");
    return w.lines;
}
