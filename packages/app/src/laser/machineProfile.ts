// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The engraver this workstation drives: its bed, GRBL's power scale and motion limits, and the
 * serial speed. It belongs to the machine, not to a job, so it is kept in the browser's storage
 * rather than in the document.
 */
export interface MachineProfile {
    /** Work area, mm; the origin is the bed's lower-left corner. */
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
    /** Framing: % of power while tracing the job's box; 0 = laser off. */
    framePower: number;
    /** Framing speed, mm/min. */
    frameSpeed: number;
}

export function defaultMachineProfile(): MachineProfile {
    return {
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
    };
}

const STORAGE_KEY = "kern3d.laser.machine";

/** The stored profile with defaults for whatever is missing or not a sensible number. */
export function normalizeProfile(raw: Partial<MachineProfile> | undefined): MachineProfile {
    const base = defaultMachineProfile();
    if (raw === undefined || raw === null || typeof raw !== "object") return base;
    const out = { ...base };
    for (const key of Object.keys(base) as (keyof MachineProfile)[]) {
        const value = raw[key];
        if (typeof base[key] === "boolean") {
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
