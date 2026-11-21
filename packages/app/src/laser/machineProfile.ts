// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Bounds } from "./geometry";

/**
 * Where X0 Y0 is on the bed: its centre (the galvo / EzCAD convention, coordinates run
 * −W/2…+W/2) or its lower-left corner (a gantry GRBL machine's home).
 */
export const BED_ORIGINS = ["center", "corner"] as const;
export type BedOrigin = (typeof BED_ORIGINS)[number];

/**
 * What the red pointer traces to show where the job lands: its bounding box («Контур»), or the
 * outer outlines of its objects, simplified («Обводка»).
 */
export const FRAME_MODES = ["box", "outline"] as const;
export type FrameMode = (typeof FRAME_MODES)[number];

/** The controller board: GRBL over a serial port, or a JCZ / EzCAD galvo board over USB. */
export const LASER_CONTROLLERS = ["grbl", "jcz"] as const;
export type LaserController = (typeof LASER_CONTROLLERS)[number];

/**
 * The engraver this workstation drives: its bed, GRBL's power scale and motion limits, and the
 * serial speed. It belongs to the machine, not to a job, so it is kept in the browser's storage
 * rather than in the document.
 */
export interface MachineProfile {
    controller: LaserController;
    /** Where X0 Y0 is on the bed. */
    origin: BedOrigin;
    /** Work area, mm. */
    bedWidth: number;
    bedHeight: number;
    /** GRBL `$30`: the S value of full power. */
    maxS: number;
    /** M4 (dynamic power, scaled with the actual speed) rather than M3 (constant). */
    dynamicPower: boolean;
    /** mm/s², for the time estimate (GRBL `$120`/`$121`). */
    accel: number;
    /** G0 speed, mm/min (GRBL `$110`/`$111`). */
    rapid: number;
    /** GRBL `$11`, mm: how sharply the planner slows at corners. */
    junctionDeviation: number;
    baud: number;
    /** Send the head back to X0 Y0 at the end of a job. */
    returnHome: boolean;
    /** Framing (the red pointer): % of power while tracing; 0 = laser off, the head only moves. */
    framePower: number;
    /** Framing speed, mm/min. */
    frameSpeed: number;
    frameMode: FrameMode;
    /** M-code that switches a red pointer on before framing (empty: the machine has none). */
    pointerOn: string;
    /** …and off after it. */
    pointerOff: string;
}

export function defaultMachineProfile(): MachineProfile {
    return {
        controller: "grbl",
        origin: "center",
        bedWidth: 400,
        bedHeight: 400,
        maxS: 1000,
        dynamicPower: true,
        accel: 1000,
        rapid: 6000,
        junctionDeviation: 0.01,
        baud: 115200,
        returnHome: true,
        framePower: 0,
        frameSpeed: 3000,
        frameMode: "box",
        pointerOn: "",
        pointerOff: "",
    };
}

/** The bed in job coordinates: [0, W] × [0, H] from a corner origin, centred on a centre one. */
export function bedRect(profile: Pick<MachineProfile, "origin" | "bedWidth" | "bedHeight">): Bounds {
    const { bedWidth: w, bedHeight: h } = profile;
    return profile.origin === "center"
        ? { minX: -w / 2, minY: -h / 2, maxX: w / 2, maxY: h / 2 }
        : { minX: 0, minY: 0, maxX: w, maxY: h };
}

const STORAGE_KEY = "kern3d.laser.machine";

/** The stored profile with defaults for whatever is missing or not a sensible number. */
export function normalizeProfile(raw: Partial<MachineProfile> | undefined): MachineProfile {
    const base = defaultMachineProfile();
    if (raw === undefined || raw === null || typeof raw !== "object") return base;
    const out = { ...base };
    for (const key of Object.keys(base) as (keyof MachineProfile)[]) {
        const value = raw[key];
        if (key === "origin") {
            if (BED_ORIGINS.includes(value as BedOrigin)) out.origin = value as BedOrigin;
        } else if (key === "frameMode") {
            if (FRAME_MODES.includes(value as FrameMode)) out.frameMode = value as FrameMode;
        } else if (key === "controller") {
            if (LASER_CONTROLLERS.includes(value as LaserController))
                out.controller = value as LaserController;
        } else if (typeof base[key] === "string") {
            if (typeof value === "string") (out as any)[key] = value.trim();
        } else if (typeof base[key] === "boolean") {
            if (typeof value === "boolean") (out as any)[key] = value;
        } else if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
            (out as any)[key] = value;
        }
    }
    if (out.bedWidth <= 0) out.bedWidth = base.bedWidth;
    if (out.bedHeight <= 0) out.bedHeight = base.bedHeight;
    if (out.maxS <= 0) out.maxS = base.maxS;
    return out;
}

export function loadMachineProfile(): MachineProfile {
    try {
        const text = globalThis.localStorage?.getItem(STORAGE_KEY);
        return normalizeProfile(text ? JSON.parse(text) : undefined);
    } catch {
        return defaultMachineProfile();
    }
}

export function saveMachineProfile(profile: MachineProfile): void {
    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(profile));
    } catch {
        // storage full or blocked: the profile lives for this session only
    }
}
