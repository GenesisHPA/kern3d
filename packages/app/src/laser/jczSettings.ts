// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * A JCZ (EzCAD) galvo machine's settings: the lens field and how the board's two galvo
 * channels map onto the job's X and Y, the timing the board needs, and the marking pens.
 * Defaults are those of the MeerK40t balor driver (MIT) for a fiber source, with the field the
 * user's machine has (150 mm). Most can be read from EzCAD's own files (`ezcadImport.ts`).
 */
export interface JczPen {
    name: string;
    /** mm/s. */
    speed: number;
    /** %. */
    power: number;
    /** kHz. */
    frequency: number;
    /** MOPA pulse width, ns; 0 = not sent. */
    pulseWidth: number;
    /** µs. */
    laserOnDelay: number;
    laserOffDelay: number;
    polygonDelay: number;
}

export interface JczSettings {
    /** Lens field (square), mm: the whole 16-bit galvo range. */
    field: number;
    /** Field offset and rotation as EzCAD's «Поле» page has them, mm / degrees. */
    offsetX: number;
    offsetY: number;
    angle: number;
    /** The board's first galvo channel drives the job's Y (EzCAD GALVOX=1). */
    swapXY: boolean;
    /** Reverse each galvo channel (EzCAD GALVONEGATE0/1). */
    negate0: boolean;
    negate1: boolean;
    /** Per-channel scale, % (EzCAD GALVOASPECT0/1, as we read it). */
    scale0: number;
    scale1: number;
    /** EzCAD's distortion terms, kept for reference: the protocol has no such command, a .cor file does it. */
    distortion: [number, number];
    /** EzCAD LASERTYPE, kept for reference. */
    laserType: number;
    /** The source's pulse-frequency range, kHz (EzCAD MINPWMFREQ / MAXPWMFREQ). */
    minFrequency: number;
    maxFrequency: number;
    /** Output port bits: the laser enable and the red pointer. */
    laserPin: number;
    lightPin: number;
    /** Red pointer speed, mm/s, and its offset from the laser, mm. */
    lightSpeed: number;
    lightOffsetX: number;
    lightOffsetY: number;
    /** Jump (travel) speed, mm/s. */
    jumpSpeed: number;
    /** Jump delay for short / long jumps, µs, and where long starts, mm. */
    jumpDelayShort: number;
    jumpDelayLong: number;
    jumpLongDistance: number;
    /** Fiber: time for the MO to open before marking, ms. */
    openMoDelay: number;
    /** Board initialisation values (balor defaults). */
    firstPulseKiller: number;
    pwmHalfPeriod: number;
    pwmPulseWidth: number;
    standby1: number;
    standby2: number;
    /** A loaded .cor table, base64 of 65 × 65 word pairs; empty = none. */
    correction: string;
    /** Marking pens (EzCAD MarkParam.lib), the first is the default for new objects. */
    pens: JczPen[];
}

export function defaultPen(): JczPen {
    return {
        name: "Default",
        speed: 1000,
        power: 50,
        frequency: 50,
        pulseWidth: 0,
        laserOnDelay: 100,
        laserOffDelay: 100,
        polygonDelay: 100,
    };
}

export function defaultJczSettings(): JczSettings {
    return {
        field: 150,
        offsetX: 0,
        offsetY: 0,
        angle: 0,
        swapXY: true,
        negate0: false,
        negate1: false,
        scale0: 100,
        scale1: 100,
        distortion: [1, 1],
        laserType: 2,
        minFrequency: 20,
        maxFrequency: 100,
        laserPin: 0,
        lightPin: 8,
        lightSpeed: 3000,
        lightOffsetX: 0,
        lightOffsetY: 0,
        jumpSpeed: 2000,
        jumpDelayShort: 8,
        jumpDelayLong: 200,
        jumpLongDistance: 10,
        openMoDelay: 8,
        firstPulseKiller: 200,
        pwmHalfPeriod: 125,
        pwmPulseWidth: 125,
        standby1: 2000,
        standby2: 20,
        correction: "",
        pens: [defaultPen()],
    };
}

function num(v: unknown, fallback: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function normalizePen(raw: Partial<JczPen> | undefined): JczPen {
    const base = defaultPen();
    if (raw === undefined || raw === null || typeof raw !== "object") return base;
    return {
        name: typeof raw.name === "string" ? raw.name : base.name,
        speed: num(raw.speed, base.speed),
        power: num(raw.power, base.power),
        frequency: num(raw.frequency, base.frequency),
        pulseWidth: num(raw.pulseWidth, base.pulseWidth),
        laserOnDelay: num(raw.laserOnDelay, base.laserOnDelay),
        laserOffDelay: num(raw.laserOffDelay, base.laserOffDelay),
        polygonDelay: num(raw.polygonDelay, base.polygonDelay),
    };
}

export function normalizeJczSettings(raw: Partial<JczSettings> | undefined): JczSettings {
    const base = defaultJczSettings();
    if (raw === undefined || raw === null || typeof raw !== "object") return base;
    const out: JczSettings = { ...base };
    for (const key of Object.keys(base) as (keyof JczSettings)[]) {
        const value = raw[key];
        const b = base[key];
        if (typeof b === "number" && typeof value === "number" && Number.isFinite(value))
            (out as any)[key] = value;
        else if (typeof b === "boolean" && typeof value === "boolean") (out as any)[key] = value;
        else if (typeof b === "string" && typeof value === "string") (out as any)[key] = value;
    }
    if (Array.isArray(raw.distortion) && raw.distortion.length === 2)
        out.distortion = [num(raw.distortion[0], 1), num(raw.distortion[1], 1)];
    if (Array.isArray(raw.pens) && raw.pens.length > 0) out.pens = raw.pens.map(normalizePen);
    if (!(out.field > 0)) out.field = base.field;
    return out;
}
