// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The 4th axis: a rotary (A, degrees) laid on the table along X or Y when a job needs it, taken
 * off otherwise. What it is (motor, microstepping, the reduction) gives the steps per degree the
 * controller has to know; its speed and acceleration are in degrees.
 */
export interface RotarySettings {
    /** On the table now: the A axis shows on the screen and can be jogged. */
    installed: boolean;
    /** The machine axis it lies along (its spindle's axis). */
    along: "X" | "Y";
    /** Motor full steps per turn: 200 for 1.8°, 400 for 0.9°. */
    stepsPerRev: number;
    /** Driver microstepping. */
    microsteps: number;
    /** Reduction, motor turns per chuck turn: 1 direct, 4 for 1:4, 6 for 1:6 (worm 1:90 → 90). */
    ratio: number;
    /** Top speed, degrees per minute. */
    maxRate: number;
    /** Acceleration, degrees per second². */
    accel: number;
    /** The usual stock diameter, mm: for the surface travel per degree. */
    diameter: number;
}

export function defaultRotary(): RotarySettings {
    return {
        installed: false,
        along: "X",
        stepsPerRev: 200,
        microsteps: 16,
        ratio: 6,
        maxRate: 3600,
        accel: 180,
        diameter: 50,
    };
}

const KEY = "kern3d.station.rotary";

function num(v: unknown, d: number, min = 0): number {
    return typeof v === "number" && Number.isFinite(v) && v > min ? v : d;
}

export function parseRotary(json: string | null | undefined): RotarySettings {
    const d = defaultRotary();
    try {
        const r = JSON.parse(json ?? "{}") as Partial<RotarySettings>;
        return {
            installed: r.installed === true,
            along: r.along === "Y" ? "Y" : "X",
            stepsPerRev: num(r.stepsPerRev, d.stepsPerRev),
            microsteps: num(r.microsteps, d.microsteps),
            ratio: num(r.ratio, d.ratio),
            maxRate: num(r.maxRate, d.maxRate),
            accel: num(r.accel, d.accel),
            diameter: num(r.diameter, d.diameter),
        };
    } catch {
        return d;
    }
}

let current: RotarySettings | undefined;

export function rotary(): RotarySettings {
    current ??= parseRotary(localStorage.getItem(KEY));
    return current;
}

/** Keeps the settings and tells the screen (`station-rotary` event). */
export function setRotary(next: RotarySettings) {
    current = next;
    localStorage.setItem(KEY, JSON.stringify(next));
    dispatchEvent(new Event("station-rotary"));
}

/** Steps per degree of the chuck. */
export function stepsPerDegree(s: RotarySettings): number {
    return (s.stepsPerRev * s.microsteps * s.ratio) / 360;
}

/** How far the stock's surface moves per degree, mm. */
export function surfacePerDegree(s: RotarySettings): number {
    return (Math.PI * s.diameter) / 360;
}

const f = (v: number) => String(Math.round(v * 10000) / 10000);

/**
 * The lines that set the A axis on a FluidNC controller (its settings are in degrees for a
 * rotary), then save them to the board's config so they survive a restart.
 */
export function fluidncLines(s: RotarySettings): string[] {
    return [
        `$/axes/a/steps_per_mm=${f(stepsPerDegree(s))}`,
        `$/axes/a/max_rate_mm_per_min=${f(s.maxRate)}`,
        `$/axes/a/acceleration_mm_per_sec2=${f(s.accel)}`,
        "$CD=config.yaml",
    ];
}

/** Whether a controller can drive a 4th axis, from its welcome line. */
export function controllerHasA(firmware: string | undefined): boolean {
    return firmware !== undefined && /fluidnc|grblhal/i.test(firmware);
}
