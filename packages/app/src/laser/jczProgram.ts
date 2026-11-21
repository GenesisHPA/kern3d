// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.
//
// The job as LMC list commands for a JCZ galvo board. The command sequence (list header,
// per-layer settings in the fiber order, jumps with short/long delays, marks) follows the
// MIT-licensed MeerK40t balor driver and galvoplotter — see THIRD_PARTY_NOTICES.md.

import { apply, type Pt, transformPaths } from "./geometry";
import { hatchPaths } from "./hatch";
import type { JczPen, JczSettings } from "./jczSettings";
import {
    type LaserImageObject,
    type LaserJobData,
    type LaserObject,
    objectMatrix,
    placement,
    withOrigin,
} from "./laserData";
import {
    GALVO_CENTER,
    GALVO_MAX,
    jumpTo,
    List,
    type LmcCommand,
    listDelay,
    markCurrent,
    markTo,
    qSwitchPeriod,
    speedWord,
} from "./lmc";
import { bedRect, type MachineProfile } from "./machineProfile";
import { orderPaths } from "./pathOrder";
import { type GrayImage, powerMap, resampleGray } from "./raster";

/** Galvo units across one millimetre of the field (MeerK40t: 0xFFFF / lens size). */
export function galvosPerMm(jcz: JczSettings): number {
    return GALVO_MAX / jcz.field;
}

/**
 * Job millimetres to the board's two 16-bit galvo words: measured from the centre of the bed
 * (the field's centre, 0x8000), shifted by the field offset, turned by the field angle, the
 * channels swapped and reversed as the machine is wired, and scaled per channel. Outside the
 * field the words are clamped and `clipped` is set.
 */
export class GalvoMapper {
    private readonly cx: number;
    private readonly cy: number;
    private readonly cos: number;
    private readonly sin: number;
    private readonly k0: number;
    private readonly k1: number;
    clipped = false;

    constructor(
        profile: Pick<MachineProfile, "origin" | "bedWidth" | "bedHeight" | "jcz">,
        private readonly extra: Pt = { x: 0, y: 0 },
    ) {
        const bed = bedRect(profile);
        const j = profile.jcz;
        this.cx = (bed.minX + bed.maxX) / 2;
        this.cy = (bed.minY + bed.maxY) / 2;
        const a = (j.angle * Math.PI) / 180;
        this.cos = Math.cos(a);
        this.sin = Math.sin(a);
        const k = galvosPerMm(j);
        this.k0 = (k * j.scale0) / 100;
        this.k1 = (k * j.scale1) / 100;
        this.jcz = j;
    }

    private readonly jcz: JczSettings;

    /** The words of the job's zero: the bed's centre, where the galvo rests between runs. */
    zero(): [number, number] {
        return this.map({ x: this.cx, y: this.cy });
    }

    map(p: Pt): [number, number] {
        const j = this.jcz;
        const x0 = p.x - this.cx + j.offsetX + this.extra.x;
        const y0 = p.y - this.cy + j.offsetY + this.extra.y;
        const x = x0 * this.cos - y0 * this.sin;
        const y = x0 * this.sin + y0 * this.cos;
        let a = j.swapXY ? y : x;
        let b = j.swapXY ? x : y;
        if (j.negate0) a = -a;
        if (j.negate1) b = -b;
        return [this.word(GALVO_CENTER + a * this.k0), this.word(GALVO_CENTER + b * this.k1)];
    }

    private word(v: number): number {
        const r = Math.round(v);
        if (r < 0 || r > GALVO_MAX) this.clipped = true;
        return Math.max(0, Math.min(GALVO_MAX, r));
    }
}

/** Polylines to burn in job mm, one object's pass: outlines, hatch lines, or raster runs. */
export function burnPolylines(o: LaserObject, image: GrayImage | undefined): Pt[][] {
    if (o.kind === "image") return image === undefined ? [] : rasterRuns(o, image);
    const paths = transformPaths(o.paths, objectMatrix(o));
    if (o.op.mode === "fill")
        return hatchPaths(paths, o.op.fillInterval, o.op.fillAngle + o.angle).map((s) => [s.from, s.to]);
    return orderPaths(paths);
}

/**
 * A picture on a galvo: line by line, alternating direction, each run of burnt pixels one
 * mark. The board takes no per-pixel power, so a grayscale setting is engraved dithered.
 */
function rasterRuns(o: LaserImageObject, image: GrayImage): Pt[][] {
    const r = o.op.raster;
    const cols = Math.max(1, Math.round(o.width * r.resolution));
    const rows = Math.max(1, Math.round(o.height * r.resolution));
    const px = o.width / cols;
    const py = o.height / rows;
    const settings = r.mode === "grayscale" ? { ...r, mode: "dither" as const } : r;
    const power = powerMap(resampleGray(image, cols, rows), settings);
    const m = placement(o);
    const runs: Pt[][] = [];
    let line = 0;
    for (let k = 0; k < rows; k++) {
        const row = rows - 1 - k;
        const y = (k + 0.5) * py;
        const rowRuns: [number, number][] = [];
        let start = -1;
        for (let c = 0; c <= cols; c++) {
            const on = c < cols && power[row * cols + c] > 0;
            if (on && start < 0) start = c;
            if (!on && start >= 0) {
                rowRuns.push([start, c]);
                start = -1;
            }
        }
        if (rowRuns.length === 0) continue;
        const forward = line++ % 2 === 0;
        if (!forward) rowRuns.reverse();
        for (const [c0, c1] of rowRuns) {
            const a = apply(m, { x: (forward ? c0 : c1) * px, y });
            const b = apply(m, { x: (forward ? c1 : c0) * px, y });
            runs.push([a, b]);
        }
    }
    return runs;
}

export function penOf(jcz: JczSettings, name: string): JczPen {
    return jcz.pens.find((p) => p.name === name) ?? jcz.pens[0];
}

export interface JczProgram {
    commands: LmcCommand[];
    /** Estimated marking time, s. */
    seconds: number;
    warnings: string[];
}

/** Writes jumps and marks, keeping the last galvo position the distance words need. */
class ListWriter {
    readonly commands: LmcCommand[] = [];
    x = GALVO_CENTER;
    y = GALVO_CENTER;
    private jumpDelay: number | undefined;

    constructor(private readonly jcz: JczSettings) {}

    push(c: LmcCommand) {
        this.commands.push(c);
    }

    jump(x: number, y: number) {
        if (x === this.x && y === this.y) return;
        const long = Math.hypot(x - this.x, y - this.y) / galvosPerMm(this.jcz) > this.jcz.jumpLongDistance;
        const delay = long ? this.jcz.jumpDelayLong : this.jcz.jumpDelayShort;
        if (delay !== this.jumpDelay) {
            this.jumpDelay = delay;
            this.commands.push(listDelay(List.JumpDelay, delay));
        }
        this.commands.push(jumpTo(x, y, this.x, this.y));
        this.x = x;
        this.y = y;
    }

    mark(x: number, y: number) {
        if (x === this.x && y === this.y) return;
        this.commands.push(markTo(x, y, this.x, this.y));
        this.x = x;
        this.y = y;
    }
}

/** A pen's settings in the fiber order of the reference: pulse width, current, Q-switch, speed, delays. */
function settingsCommands(o: LaserObject, jcz: JczSettings): LmcCommand[] {
    const pen = penOf(jcz, o.op.pen);
    const k = galvosPerMm(jcz);
    const commands: LmcCommand[] = [];
    if (pen.pulseWidth > 0) commands.push([List.FiberYLPMPulseWidth, pen.pulseWidth]);
    commands.push(
        [List.MarkCurrent, markCurrent(o.op.power)],
        [List.QSwitchPeriod, qSwitchPeriod(o.op.frequency)],
        [List.MarkSpeed, speedWord(o.op.speed / 60, k)],
        listDelay(List.LaserOnDelay, pen.laserOnDelay),
        listDelay(List.LaserOffDelay, pen.laserOffDelay),
        listDelay(List.PolygonDelay, pen.polygonDelay),
    );
    return commands;
}

/**
 * The marking program: the list header of the reference's program mode (ready, the fiber MO
 * open delay, the laser port, the jump speed), then per visible object its settings and its
 * passes as jumps and marks, and the end of the list. The time counts marks at the object's
 * speed, jumps at the jump speed, and the delays.
 */
export function jczProgram(
    stored: LaserJobData,
    profile: MachineProfile,
    images: ReadonlyMap<string, GrayImage> = new Map(),
): JczProgram {
    const job = withOrigin(stored, profile);
    const jcz = profile.jcz;
    const mapper = new GalvoMapper(profile);
    const w = new ListWriter(jcz);
    const warnings: string[] = [];
    let seconds = 0;
    w.push([List.ReadyMark]);
    if (jcz.openMoDelay > 0) w.push([List.DelayTime, Math.round(jcz.openMoDelay * 100)]);
    w.push([List.WritePort, 1 << jcz.laserPin]);
    w.push([List.JumpSpeed, speedWord(jcz.jumpSpeed, galvosPerMm(jcz))]);
    let head: Pt = { x: 0, y: 0 };
    for (const o of job.objects) {
        if (o.hidden) continue;
        const image = o.kind === "image" ? images.get(o.id) : undefined;
        if (o.kind === "image" && image === undefined) {
            if (!warnings.includes("laser.warn.imageMissing")) warnings.push("laser.warn.imageMissing");
            continue;
        }
        for (const c of settingsCommands(o, jcz)) w.push(c);
        const pen = penOf(jcz, o.op.pen);
        const speed = Math.max(1e-6, o.op.speed / 60);
        const lines = burnPolylines(o, image);
        for (let pass = 0; pass < Math.max(1, o.op.passes); pass++) {
            for (const line of lines) {
                if (line.length < 2) continue;
                const [sx, sy] = mapper.map(line[0]);
                seconds += Math.hypot(line[0].x - head.x, line[0].y - head.y) / jcz.jumpSpeed;
                w.jump(sx, sy);
                for (let i = 1; i < line.length; i++) {
                    const [x, y] = mapper.map(line[i]);
                    w.mark(x, y);
                    seconds += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y) / speed;
                }
                seconds +=
                    (pen.laserOnDelay + pen.laserOffDelay + pen.polygonDelay * (line.length - 2)) / 1e6;
                head = line[line.length - 1];
            }
        }
    }
    w.push([List.EndOfList]);
    if (mapper.clipped) warnings.push("laser.warn.outsideField");
    return { commands: w.commands, seconds, warnings };
}

/**
 * One round of the red pointer along `paths` (job mm), in the reference's light mode: the
 * light off for the jump to each path's start, on along the path (jumps, the laser never
 * fires), shifted by the pointer's offset from the laser.
 */
export function jczLightRound(paths: readonly Pt[][], profile: MachineProfile): LmcCommand[] {
    const jcz = profile.jcz;
    const mapper = new GalvoMapper(profile, { x: jcz.lightOffsetX, y: jcz.lightOffsetY });
    const w = new ListWriter(jcz);
    const light = 1 << jcz.lightPin;
    for (const path of paths) {
        if (path.length < 2) continue;
        w.push([List.WritePort, 0]);
        const [sx, sy] = mapper.map(path[0]);
        w.jump(sx, sy);
        w.push([List.WritePort, light]);
        for (const p of path.slice(1)) {
            const [x, y] = mapper.map(p);
            w.jump(x, y);
        }
    }
    return w.commands;
}

/** The start of a light list: ready, the light on, the pointer's speed. */
export function jczLightHeader(profile: MachineProfile): LmcCommand[] {
    const jcz = profile.jcz;
    return [
        [List.ReadyMark],
        [List.WritePort, 1 << jcz.lightPin],
        [List.JumpSpeed, speedWord(jcz.lightSpeed, galvosPerMm(jcz))],
    ];
}
