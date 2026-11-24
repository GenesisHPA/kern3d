// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** GRBL 1.1 realtime bytes beyond the basic ones: overrides, coolant toggles. */
export const OVERRIDE = {
    feedReset: "\x90",
    feedPlus10: "\x91",
    feedMinus10: "\x92",
    feedPlus1: "\x93",
    feedMinus1: "\x94",
    rapid100: "\x95",
    rapid50: "\x96",
    rapid25: "\x97",
    spindleReset: "\x99",
    spindlePlus10: "\x9a",
    spindleMinus10: "\x9b",
    spindlePlus1: "\x9c",
    spindleMinus1: "\x9d",
    spindleStop: "\x9e",
    floodToggle: "\xa0",
    mistToggle: "\xa1",
} as const;

export type Axis = "X" | "Y" | "Z";
export const AXES: readonly Axis[] = ["X", "Y", "Z"];

/** Jog steps offered, mm; 0 = continuous (moves while the button is held). */
export const JOG_STEPS = [0, 0.01, 0.1, 1, 10, 100] as const;

function fmt(v: number): string {
    return String(Math.round(v * 1000) / 1000);
}

/** A GRBL jog command: relative, in mm, cancellable with the jog-cancel byte. */
export function jogLine(moves: Partial<Record<Axis, number>>, feed: number): string | undefined {
    const words = AXES.filter((a) => moves[a] !== undefined && moves[a] !== 0).map(
        (a) => `${a}${fmt(moves[a]!)}`,
    );
    if (words.length === 0 || !(feed > 0)) return undefined;
    return `$J=G91 G21 ${words.join(" ")} F${Math.round(feed)}`;
}

/** Probe the top of the stock with a touch plate: down until contact, set Z to the plate, back up. */
export function probeLines(p: {
    thickness: number;
    travel: number;
    feed: number;
    retract: number;
}): string[] {
    return [
        "G21 G91",
        `G38.2 Z-${fmt(Math.abs(p.travel))} F${Math.round(p.feed)}`,
        `G10 L20 P0 Z${fmt(p.thickness)}`,
        `G0 Z${fmt(Math.abs(p.retract))}`,
        "G90",
    ];
}

/** Go to the work zero: up to the safe height first, then over, then down to it. */
export function goZeroLines(safeZ: number, axes: "xy" | "xyz"): string[] {
    const out = ["G90 G21", `G0 Z${fmt(Math.max(safeZ, 1))}`, "G0 X0 Y0"];
    if (axes === "xyz") out.push("G0 Z0");
    return out;
}

/** `$n=value` from `$$`. */
export function parseSetting(line: string): { id: number; value: string } | undefined {
    const m = /^\$(\d+)=(\S*)/.exec(line.trim());
    return m === null ? undefined : { id: Number(m[1]), value: m[2] };
}

/** The GRBL 1.1 settings with a name (i18n key `cnc.set.<id>`), the group they show under. */
export const GRBL_SETTINGS: readonly {
    id: number;
    group: "motion" | "limits" | "spindle" | "axis" | "other";
}[] = [
    { id: 0, group: "motion" },
    { id: 1, group: "motion" },
    { id: 2, group: "motion" },
    { id: 3, group: "motion" },
    { id: 4, group: "motion" },
    { id: 5, group: "limits" },
    { id: 6, group: "limits" },
    { id: 10, group: "other" },
    { id: 11, group: "motion" },
    { id: 12, group: "motion" },
    { id: 13, group: "other" },
    { id: 20, group: "limits" },
    { id: 21, group: "limits" },
    { id: 22, group: "limits" },
    { id: 23, group: "limits" },
    { id: 24, group: "limits" },
    { id: 25, group: "limits" },
    { id: 26, group: "limits" },
    { id: 27, group: "limits" },
    { id: 30, group: "spindle" },
    { id: 31, group: "spindle" },
    { id: 32, group: "spindle" },
    { id: 100, group: "axis" },
    { id: 101, group: "axis" },
    { id: 102, group: "axis" },
    { id: 110, group: "axis" },
    { id: 111, group: "axis" },
    { id: 112, group: "axis" },
    { id: 120, group: "axis" },
    { id: 121, group: "axis" },
    { id: 122, group: "axis" },
    { id: 130, group: "axis" },
    { id: 131, group: "axis" },
    { id: 132, group: "axis" },
];

/** The colour a machine state shows in. */
export function stateColor(state: string): string {
    switch (state) {
        case "Idle":
            return "#2f9e44";
        case "Run":
        case "Jog":
        case "Home":
            return "#1c7ed6";
        case "Hold":
        case "Door":
        case "Check":
            return "#f08c00";
        case "Alarm":
            return "#e03131";
        default:
            return "#868e96";
    }
}
