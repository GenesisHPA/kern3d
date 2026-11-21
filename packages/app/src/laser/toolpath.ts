// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { MachineProfile } from "./machineProfile";

/** One straight move of the head, as the preview draws it and the estimate times it. */
export interface Move {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    rapid: boolean;
    /** S while the move runs; 0 when the laser is off (G0, M5, S0). */
    power: number;
    /** mm/min; for a rapid, the machine's G0 speed. */
    feed: number;
}

function stripComment(line: string): string {
    return line
        .replace(/\([^)]*\)/g, "")
        .replace(/;.*$/, "")
        .trim()
        .toUpperCase();
}

/**
 * The moves of a G-code program — the subset this module writes and GRBL runs for a laser:
 * G0/G1, G90/G91, G20/G21, M3/M4/M5, S and F. Arcs and anything else are skipped.
 */
export function parseToolpath(lines: readonly string[], rapidFeed: number): Move[] {
    const moves: Move[] = [];
    let x = 0;
    let y = 0;
    let motion = 0;
    let absolute = true;
    let unit = 1;
    let s = 0;
    let feed = 1000;
    let laserOn = false;
    for (const raw of lines) {
        const line = stripComment(raw);
        if (line === "" || line.startsWith("$")) continue;
        let nx: number | undefined;
        let ny: number | undefined;
        const re = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
        for (let m = re.exec(line); m !== null; m = re.exec(line)) {
            const v = Number(m[2]);
            switch (m[1]) {
                case "G":
                    if (v === 0 || v === 1) motion = v;
                    else if (v === 90) absolute = true;
                    else if (v === 91) absolute = false;
                    else if (v === 20) unit = 25.4;
                    else if (v === 21) unit = 1;
                    break;
                case "M":
                    if (v === 3 || v === 4) laserOn = true;
                    else if (v === 5 || v === 2 || v === 30) laserOn = false;
                    break;
                case "S":
                    s = v;
                    break;
                case "F":
                    feed = v * unit;
                    break;
                case "X":
                    nx = v * unit;
                    break;
                case "Y":
                    ny = v * unit;
                    break;
            }
        }
        if (nx === undefined && ny === undefined) continue;
        const tx = nx === undefined ? x : absolute ? nx : x + nx;
        const ty = ny === undefined ? y : absolute ? ny : y + ny;
        if (tx !== x || ty !== y) {
            const rapid = motion === 0;
            moves.push({
                x0: x,
                y0: y,
                x1: tx,
                y1: ty,
                rapid,
                power: !rapid && laserOn ? s : 0,
                feed: rapid ? rapidFeed : feed,
            });
        }
        x = tx;
        y = ty;
    }
    return moves;
}

/**
 * Seconds the machine takes for the moves, the way GRBL's planner runs them: each move speeds
 * up and slows down at `accel` (a trapezoid), corners are taken at the junction-deviation speed
 * (`$11`; a straight continuation keeps going, a reversal stops), and the head starts and ends
 * at rest. Look-ahead runs over the whole program, which GRBL's 16-block planner only
 * approximates, so the estimate is a little optimistic on dense rasters.
 */
export function estimateTime(
    moves: readonly Move[],
    profile: Pick<MachineProfile, "accel" | "junctionDeviation">,
): number {
    const n = moves.length;
    if (n === 0) return 0;
    const a = Math.max(1e-6, profile.accel);
    const length = new Float64Array(n);
    const vmax = new Float64Array(n);
    const ux = new Float64Array(n);
    const uy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const m = moves[i];
        const dx = m.x1 - m.x0;
        const dy = m.y1 - m.y0;
        length[i] = Math.hypot(dx, dy);
        vmax[i] = Math.max(1e-6, m.feed / 60);
        ux[i] = length[i] > 0 ? dx / length[i] : 0;
        uy[i] = length[i] > 0 ? dy / length[i] : 0;
    }
    // entry[i]: the largest speed at the start of move i its corner allows
    const entry = new Float64Array(n + 1);
    for (let i = 1; i < n; i++) {
        entry[i] = Math.min(vmax[i - 1], vmax[i], junctionSpeed(ux, uy, i, a, profile.junctionDeviation));
    }
    entry[0] = 0;
    entry[n] = 0;
    // backward pass: slow down in time for the next limit; forward pass: speed up only as far as possible
    for (let i = n - 1; i >= 0; i--)
        entry[i] = Math.min(entry[i], Math.sqrt(entry[i + 1] ** 2 + 2 * a * length[i]));
    for (let i = 0; i < n; i++)
        entry[i + 1] = Math.min(entry[i + 1], Math.sqrt(entry[i] ** 2 + 2 * a * length[i]));
    let total = 0;
    for (let i = 0; i < n; i++) total += trapezoidTime(length[i], entry[i], entry[i + 1], vmax[i], a);
    return total;
}

/** GRBL's corner speed between move i−1 and move i. */
function junctionSpeed(ux: Float64Array, uy: Float64Array, i: number, a: number, deviation: number): number {
    const cos = -(ux[i - 1] * ux[i] + uy[i - 1] * uy[i]);
    if (cos > 0.999999) return 0; // reversal
    if (cos < -0.999999) return Infinity; // straight on
    const sinHalf = Math.sqrt(0.5 * (1 - cos));
    return Math.sqrt((a * deviation * sinHalf) / (1 - sinHalf));
}

/** Time over `length` from speed v0 to v1, cruising at most at vmax, accelerating at a. */
export function trapezoidTime(length: number, v0: number, v1: number, vmax: number, a: number): number {
    if (length <= 0) return 0;
    const accelDistance = (vmax * vmax - v0 * v0) / (2 * a);
    const decelDistance = (vmax * vmax - v1 * v1) / (2 * a);
    if (accelDistance + decelDistance <= length) {
        const cruise = length - accelDistance - decelDistance;
        return (vmax - v0) / a + cruise / vmax + (vmax - v1) / a;
    }
    // no cruise: the peak where the speed-up and slow-down meet
    const peak = Math.sqrt(Math.max(v0 * v0, v1 * v1, a * length + (v0 * v0 + v1 * v1) / 2));
    return Math.max(0, (peak - v0) / a) + Math.max(0, (peak - v1) / a);
}

export interface ToolpathStats {
    seconds: number;
    burnLength: number;
    travelLength: number;
}

export function toolpathStats(moves: readonly Move[], profile: MachineProfile): ToolpathStats {
    let burn = 0;
    let travel = 0;
    for (const m of moves) {
        const l = Math.hypot(m.x1 - m.x0, m.y1 - m.y0);
        if (m.power > 0) burn += l;
        else travel += l;
    }
    return { seconds: estimateTime(moves, profile), burnLength: burn, travelLength: travel };
}

/** "1:05:09", "4:07", "0:12". */
export function formatDuration(seconds: number): string {
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
