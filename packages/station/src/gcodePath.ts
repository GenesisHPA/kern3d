// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export type Point3 = [number, number, number];

/** One straight piece of the tool's path, in work coordinates (mm). */
export interface PathSegment {
    from: Point3;
    to: Point3;
    /** A G0 rapid (drawn faint) rather than a cut. */
    rapid: boolean;
    /** The program line (0-based, of all lines) the piece comes from. */
    line: number;
}

export interface ProgramPath {
    segments: PathSegment[];
    min: Point3;
    max: Point3;
}

const ARC_STEP_MM = 1;

function words(line: string): Map<string, number> {
    const out = new Map<string, number>();
    const clean = line
        .replace(/\([^)]*\)/g, "")
        .replace(/;.*$/, "")
        .toUpperCase();
    for (const m of clean.matchAll(/([A-Z])\s*([-+]?\d*\.?\d+)/g)) {
        // G and M words are read by `gCodes`; here only the values (X, Y, Z, I, J, F…)
        if (m[1] !== "G" && m[1] !== "M" && m[1] !== "N") out.set(m[1], Number(m[2]));
    }
    return out;
}

/** The G words of a line, all of them (a line may carry `G90 G1`). */
function gCodes(line: string): number[] {
    const clean = line
        .replace(/\([^)]*\)/g, "")
        .replace(/;.*$/, "")
        .toUpperCase();
    return [...clean.matchAll(/G\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
}

/**
 * The path a program draws: G0/G1 lines and G2/G3 arcs (in the XY plane, I/J centres) cut into
 * short pieces, absolute or relative (G90/G91), mm or inch (G21/G20). Enough to show where the
 * tool goes; it is not a controller (no canned cycles, no cutter compensation).
 */
export function programPath(lines: readonly string[]): ProgramPath {
    const segments: PathSegment[] = [];
    let pos: Point3 = [0, 0, 0];
    let motion = 0;
    let absolute = true;
    let scale = 1;
    lines.forEach((raw, index) => {
        const g = gCodes(raw);
        for (const code of g) {
            if (code === 90) absolute = true;
            else if (code === 91) absolute = false;
            else if (code === 20) scale = 25.4;
            else if (code === 21) scale = 1;
            else if (code === 0 || code === 1 || code === 2 || code === 3) motion = code;
        }
        // a line moving in machine coordinates or probing is not part of the drawn path
        if (g.includes(53) || g.some((c) => c >= 38 && c < 39) || g.includes(28) || g.includes(30)) return;
        const w = words(raw);
        if (!w.has("X") && !w.has("Y") && !w.has("Z")) return;
        const target = pos.map((v, i) => {
            const letter = "XYZ"[i];
            if (!w.has(letter)) return v;
            const value = w.get(letter)! * scale;
            return absolute ? value : v + value;
        }) as Point3;
        if (motion === 2 || motion === 3) {
            segments.push(
                ...arc(
                    pos,
                    target,
                    (w.get("I") ?? 0) * scale,
                    (w.get("J") ?? 0) * scale,
                    motion === 2,
                    index,
                ),
            );
        } else {
            segments.push({ from: pos, to: target, rapid: motion === 0, line: index });
        }
        pos = target;
    });
    return { segments, ...bounds(segments) };
}

function arc(
    from: Point3,
    to: Point3,
    i: number,
    j: number,
    clockwise: boolean,
    line: number,
): PathSegment[] {
    const cx = from[0] + i;
    const cy = from[1] + j;
    const r = Math.hypot(i, j);
    const a0 = Math.atan2(from[1] - cy, from[0] - cx);
    let a1 = Math.atan2(to[1] - cy, to[0] - cx);
    if (clockwise && a1 >= a0) a1 -= 2 * Math.PI;
    if (!clockwise && a1 <= a0) a1 += 2 * Math.PI;
    const n = Math.max(2, Math.ceil((Math.abs(a1 - a0) * r) / ARC_STEP_MM));
    const out: PathSegment[] = [];
    let prev = from;
    for (let k = 1; k <= n; k++) {
        const t = k / n;
        const a = a0 + (a1 - a0) * t;
        const p: Point3 =
            k === n ? to : [cx + r * Math.cos(a), cy + r * Math.sin(a), from[2] + (to[2] - from[2]) * t];
        out.push({ from: prev, to: p, rapid: false, line });
        prev = p;
    }
    return out;
}

function bounds(segments: readonly PathSegment[]): { min: Point3; max: Point3 } {
    if (segments.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
    const min: Point3 = [Infinity, Infinity, Infinity];
    const max: Point3 = [-Infinity, -Infinity, -Infinity];
    for (const s of segments) {
        if (s.rapid) continue;
        for (const p of [s.from, s.to])
            for (let i = 0; i < 3; i++) {
                min[i] = Math.min(min[i], p[i]);
                max[i] = Math.max(max[i], p[i]);
            }
    }
    if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
    return { min, max };
}

/** The program as GRBL gets it: no comments, no blanks, no `%`. */
export function programLines(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== "" && l !== "%");
}

/** A rough run time, s: the cut lengths at their feeds plus rapids at `rapidFeed` (mm/min). */
export function estimateSeconds(lines: readonly string[], rapidFeed = 3000): number {
    const path = programPath(lines);
    let feed = 1000;
    const feedOfLine = new Map<number, number>();
    lines.forEach((l, i) => {
        const m = /F\s*([\d.]+)/i.exec(l.replace(/\([^)]*\)/g, ""));
        if (m) feed = Number(m[1]);
        feedOfLine.set(i, feed);
    });
    let seconds = 0;
    for (const s of path.segments) {
        const len = Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1], s.to[2] - s.from[2]);
        const f = s.rapid ? rapidFeed : (feedOfLine.get(s.line) ?? 1000);
        seconds += (len / Math.max(1, f)) * 60;
    }
    return seconds;
}
