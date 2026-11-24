// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Probing, the way bCNC / gSender / Probe Basic do it on GRBL:
 *
 * - a fixed tool-length sensor (tool setter): the tool that set the work Z zero is measured
 *   once (the reference); every later tool is measured and its difference applied as a
 *   dynamic length offset (G43.1), so the work zero survives a tool change;
 * - a 3D touch probe in the spindle instead of a cutter for the work zero: edges, corners,
 *   the top, the centre of a hole or a boss. Its tip radius and run-out are allowed for; the
 *   probe is measured on the sensor like any tool, so the cutter after it lands on the same Z.
 *
 * Every routine works over `ProbeIO`, so it is tested without a machine.
 */

export type Vec3 = [number, number, number];

export interface ProbeSettings {
    /** Tool setter: where it is (machine coordinates) and the height to start the search from. */
    setter: { enabled: boolean; x: number; y: number; z: number };
    /** Machine Z to travel at between places (a little under the top). */
    safeZ: number;
    /** Where to stop for a tool change, machine coordinates. */
    change: { x: number; y: number; z: number };
    seekFeed: number;
    latchFeed: number;
    /** How far a search may go, mm. */
    travel: number;
    /** Back-off between the fast and the slow touch, mm. */
    retract: number;
    /** The 3D probe: ball diameter, its centre's offset from the spindle axis. */
    tip: number;
    offsetX: number;
    offsetY: number;
    /** Corner / boss probing: how far beside the edge to go down, how deep under the top. */
    clearance: number;
    depth: number;
}

export function defaultProbeSettings(): ProbeSettings {
    return {
        setter: { enabled: false, x: -10, y: -10, z: -5 },
        safeZ: -2,
        change: { x: -10, y: -10, z: -2 },
        seekFeed: 300,
        latchFeed: 40,
        travel: 40,
        retract: 2,
        tip: 2,
        offsetX: 0,
        offsetY: 0,
        clearance: 8,
        depth: 4,
    };
}

const KEY = "kern3d.cam.probe";

function num(v: unknown, d: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : d;
}

export function parseProbeSettings(json: string | null | undefined): ProbeSettings {
    const d = defaultProbeSettings();
    if (!json) return d;
    try {
        const r = JSON.parse(json);
        return {
            setter: {
                enabled: r?.setter?.enabled === true,
                x: num(r?.setter?.x, d.setter.x),
                y: num(r?.setter?.y, d.setter.y),
                z: num(r?.setter?.z, d.setter.z),
            },
            safeZ: num(r?.safeZ, d.safeZ),
            change: {
                x: num(r?.change?.x, d.change.x),
                y: num(r?.change?.y, d.change.y),
                z: num(r?.change?.z, d.change.z),
            },
            seekFeed: Math.max(1, num(r?.seekFeed, d.seekFeed)),
            latchFeed: Math.max(1, num(r?.latchFeed, d.latchFeed)),
            travel: Math.max(1, num(r?.travel, d.travel)),
            retract: Math.max(0.2, num(r?.retract, d.retract)),
            tip: Math.max(0, num(r?.tip, d.tip)),
            offsetX: num(r?.offsetX, d.offsetX),
            offsetY: num(r?.offsetY, d.offsetY),
            clearance: Math.max(0.5, num(r?.clearance, d.clearance)),
            depth: Math.max(0.2, num(r?.depth, d.depth)),
        };
    } catch {
        return d;
    }
}

export function loadProbeSettings(): ProbeSettings {
    try {
        return parseProbeSettings(localStorage.getItem(KEY));
    } catch {
        return defaultProbeSettings();
    }
}

export function storeProbeSettings(s: ProbeSettings) {
    try {
        localStorage.setItem(KEY, JSON.stringify(s));
    } catch {}
}

/** `[PRB:x,y,z:1]` → the machine position of the touch and whether it touched. */
export function parsePrb(line: string): { pos: Vec3; ok: boolean } | undefined {
    const m = /^\[PRB:([-\d.]+),([-\d.]+),([-\d.]+)(?:,[-\d.]+)*:(\d)\]/.exec(line.trim());
    if (m === null) return undefined;
    return { pos: [Number(m[1]), Number(m[2]), Number(m[3])], ok: m[4] === "1" };
}

/** What a routine needs from the machine. */
export interface ProbeIO {
    /** Send lines and wait until all are taken. */
    send(lines: string[]): Promise<void>;
    /** One probing move (G38.2 …): the machine position of the touch; rejects when nothing was touched. */
    probe(line: string): Promise<Vec3>;
}

const AXIS_INDEX = { X: 0, Y: 1, Z: 2 } as const;
type Axis = keyof typeof AXIS_INDEX;

function f(v: number): string {
    return String(Math.round(v * 1000) / 1000);
}

/**
 * A touch along one axis from where the probe is: fast, back off, slow. Returns the slow
 * touch (machine coordinates) and leaves the probe backed off from it.
 */
export async function touch(
    io: ProbeIO,
    s: ProbeSettings,
    axis: Axis,
    dir: 1 | -1,
    travel = s.travel,
): Promise<Vec3> {
    await io.send(["G21 G91"]);
    await io.probe(`G38.2 ${axis}${f(dir * travel)} F${Math.round(s.seekFeed)}`);
    await io.send([`G0 ${axis}${f(-dir * s.retract)}`]);
    const p = await io.probe(`G38.2 ${axis}${f(dir * (s.retract + 1))} F${Math.round(s.latchFeed)}`);
    await io.send([`G0 ${axis}${f(-dir * s.retract)}`, "G90"]);
    return p;
}

/** The surface a ball touched: its centre plus the radius in the direction of travel, plus run-out. */
export function edgeAt(s: ProbeSettings, axis: "X" | "Y", dir: 1 | -1, contact: Vec3): number {
    const c = contact[AXIS_INDEX[axis]];
    const offset = axis === "X" ? s.offsetX : s.offsetY;
    return c + dir * (s.tip / 2) + offset;
}

// ---- tool length ------------------------------------------------------------------------------

/** Measure the tool in the spindle on the setter: the machine Z of its tip's touch. */
export async function measureTool(io: ProbeIO, s: ProbeSettings): Promise<number> {
    await io.send([
        "G21 G90",
        "G49",
        `G53 G0 Z${f(s.safeZ)}`,
        `G53 G0 X${f(s.setter.x)} Y${f(s.setter.y)}`,
        `G53 G0 Z${f(s.setter.z)}`,
    ]);
    const p = await touch(io, s, "Z", -1);
    await io.send([`G53 G0 Z${f(s.safeZ)}`]);
    return p[2];
}

/** The dynamic offset for a tool measured against the reference one. */
export function lengthOffset(measured: number, reference: number): number {
    return Math.round((measured - reference) * 1000) / 1000;
}

export function applyOffsetLines(offset: number): string[] {
    return [`G43.1 Z${f(offset)}`];
}

// ---- work zero with the 3D probe --------------------------------------------------------------

/** One edge: X+ means moving +X onto the part's left (−X) face. Sets that axis's work zero there. */
export async function probeEdge(
    io: ProbeIO,
    s: ProbeSettings,
    axis: "X" | "Y",
    dir: 1 | -1,
): Promise<number> {
    const edge = edgeAt(s, axis, dir, await touch(io, s, axis, dir));
    await io.send([`G10 L2 P0 ${axis}${f(edge)}`]);
    return edge;
}

/** The top: work Z zero on it, allowing for the current tool's length offset. */
export async function probeTop(io: ProbeIO, s: ProbeSettings, offset: number): Promise<number> {
    const p = await touch(io, s, "Z", -1);
    const z = p[2] - offset;
    await io.send([`G10 L2 P0 Z${f(z)}`]);
    return z;
}

export type Corner = "frontLeft" | "frontRight" | "backLeft" | "backRight";

/**
 * A corner from above: the probe starts over the stock near the corner, inside it. Top
 * (optional), then down beside each of the two faces and onto it; sets X, Y (and Z) zero.
 */
export async function probeCorner(
    io: ProbeIO,
    s: ProbeSettings,
    corner: Corner,
    withZ: boolean,
    offset: number,
): Promise<{ x: number; y: number; z?: number }> {
    const dx: 1 | -1 = corner === "frontLeft" || corner === "backLeft" ? 1 : -1;
    const dy: 1 | -1 = corner === "frontLeft" || corner === "frontRight" ? 1 : -1;
    let z: number | undefined;
    if (withZ) z = await probeTop(io, s, offset);
    const out = s.clearance + s.tip / 2;
    const down = s.depth + s.retract;
    const hop = s.retract + 2;
    // X face: up, out past it, down, back onto it
    await io.send(["G21 G91", `G0 Z${f(hop)}`, `G0 X${f(-dx * out)}`, `G0 Z${f(-(hop + down))}`, "G90"]);
    const px = await touch(io, s, "X", dx, out + s.travel / 2);
    const x = edgeAt(s, "X", dx, px);
    // back over the stock, beside the corner by the clearance
    await io.send(["G91", `G0 Z${f(hop + down)}`, "G90", `G53 G0 X${f(px[0] + dx * (s.tip + s.clearance))}`]);
    // Y face
    await io.send(["G91", `G0 Y${f(-dy * out)}`, `G0 Z${f(-(hop + down))}`, "G90"]);
    const py = await touch(io, s, "Y", dy, out + s.travel / 2);
    const y = edgeAt(s, "Y", dy, py);
    await io.send(["G91", `G0 Z${f(hop + down)}`, "G90", `G53 G0 Y${f(py[1] + dy * (s.tip + s.clearance))}`]);
    await io.send([`G10 L2 P0 X${f(x)} Y${f(y)}`]);
    return { x, y, z };
}

/** The centre of a hole: the probe starts inside it, below the top; both ways in X, then Y. */
export async function probeHole(
    io: ProbeIO,
    s: ProbeSettings,
    setZero: boolean,
): Promise<{ x: number; y: number; d: number }> {
    const a = await touch(io, s, "X", -1);
    const b = await touch(io, s, "X", 1);
    const x = (a[0] + b[0]) / 2;
    await io.send([`G53 G0 X${f(x)}`]);
    const c = await touch(io, s, "Y", -1);
    const d = await touch(io, s, "Y", 1);
    const y = (c[1] + d[1]) / 2;
    await io.send([`G53 G0 Y${f(y)}`]);
    // X again from the true middle in Y: the first pass was on a chord
    const e = await touch(io, s, "X", -1);
    const g = await touch(io, s, "X", 1);
    const x2 = (e[0] + g[0]) / 2;
    await io.send([`G53 G0 X${f(x2)}`]);
    const cx = x2 + s.offsetX;
    const cy = y + s.offsetY;
    if (setZero) await io.send([`G10 L2 P0 X${f(cx)} Y${f(cy)}`]);
    return { x: cx, y: cy, d: Math.round((g[0] - e[0] + s.tip) * 1000) / 1000 };
}

/**
 * The centre of a boss of about `diameter`: the probe starts above its middle. For each side:
 * up, out past it, down, back in onto it.
 */
export async function probeBoss(
    io: ProbeIO,
    s: ProbeSettings,
    diameter: number,
    setZero: boolean,
): Promise<{ x: number; y: number; d: number }> {
    const out = diameter / 2 + s.clearance + s.tip / 2;
    const hop = s.retract + 2;
    const down = s.depth + hop;
    const side = async (axis: "X" | "Y", dir: 1 | -1): Promise<number> => {
        // dir: the direction of the touch; start on the other side
        await io.send(["G21 G91", `G0 Z${f(hop)}`, `G0 ${axis}${f(-dir * out)}`, `G0 Z${f(-down)}`, "G90"]);
        const p = await touch(io, s, axis, dir, s.clearance + s.travel / 2);
        // up, back over the middle (from the touch: half the boss and the ball), down to the start
        const middle = p[AXIS_INDEX[axis]] + dir * (diameter / 2 + s.tip / 2);
        await io.send([
            "G91",
            `G0 Z${f(down)}`,
            "G90",
            `G53 G0 ${axis}${f(middle)}`,
            "G91",
            `G0 Z${f(-hop)}`,
            "G90",
        ]);
        return p[AXIS_INDEX[axis]];
    };
    const x1 = await side("X", 1);
    const x2 = await side("X", -1);
    const y1 = await side("Y", 1);
    const y2 = await side("Y", -1);
    const cx = (x1 + x2) / 2 + s.offsetX;
    const cy = (y1 + y2) / 2 + s.offsetY;
    if (setZero) await io.send([`G10 L2 P0 X${f(cx)} Y${f(cy)}`]);
    return { x: cx, y: cy, d: Math.round((x2 - x1 - s.tip) * 1000) / 1000 };
}

// ---- tool changes in a program ----------------------------------------------------------------

export interface ProgramSegment {
    /** The tool to put in before this part (undefined for the first). */
    tool?: number;
    lines: string[];
}

/**
 * The program cut at its tool changes (`(change to Tn …)` + `M0`, or `Tn M6`): each part runs
 * as its own job, the change done between them by the panel. Comments are dropped.
 */
export function splitAtToolChanges(gcode: string[]): ProgramSegment[] {
    const out: ProgramSegment[] = [{ lines: [] }];
    let next: number | undefined;
    for (const raw of gcode) {
        const line = raw.trim();
        const change = /^\(change to T(\d+)/i.exec(line);
        if (change) {
            next = Number(change[1]);
            continue;
        }
        const m6 = /^T(\d+)\s*M0?6\b/i.exec(line);
        if (m6) {
            out.push({ tool: Number(m6[1]), lines: [] });
            next = undefined;
            continue;
        }
        if (/^M0?0$/i.test(line) && next !== undefined) {
            out.push({ tool: next, lines: [] });
            next = undefined;
            continue;
        }
        const code = line.replace(/\(.*?\)|;.*/g, "").trim();
        if (code !== "") out[out.length - 1].lines.push(code);
    }
    return out.filter((seg, i) => i === 0 || seg.lines.length > 0 || seg.tool !== undefined);
}

export function toChangeLines(s: ProbeSettings): string[] {
    return [
        "M5",
        "M9",
        "G21 G90",
        `G53 G0 Z${f(s.safeZ)}`,
        `G53 G0 X${f(s.change.x)} Y${f(s.change.y)}`,
        `G53 G0 Z${f(s.change.z)}`,
    ];
}
