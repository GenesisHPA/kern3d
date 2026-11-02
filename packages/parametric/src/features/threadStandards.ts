// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Thread presets: the sizes a Thread feature offers, with the two numbers its geometry needs —
 * the nominal (major) diameter and the pitch — and the profile form.
 *
 * - `iso` — ISO 261/724 metric, 60° (coarse and the common fine pitches).
 * - `unified` — ASME B1.1 UNC/UNF, 60°, the same basic profile as metric.
 * - `whitworth` — ISO 228-1 / BSPP "G" parallel pipe threads, 55° (the HPA fittings' thread).
 *
 * Tapered pipe threads (NPT, BSPT "R") are not in the table: the feature cuts a parallel thread
 * only.
 *
 * Like the hole presets, a pick writes the row's NUMBERS into the feature (`thread.ts`'s
 * `setParameter`), so a later edit to this table cannot silently retune existing threads; the
 * stored `size` is only the label the panel shows.
 */
export type ThreadForm = "iso" | "unified" | "whitworth";

export interface ThreadStandardRow {
    /** The designation as the panel shows it, unique in the table: "M8", "M8×1", "G1/4", "1/4-28 UNF". */
    readonly size: string;
    readonly form: ThreadForm;
    /** Nominal (major) diameter, mm. */
    readonly diameter: number;
    /** Pitch, mm (an inch thread's 25.4 / TPI). */
    readonly pitch: number;
}

const iso = (size: string, diameter: number, pitch: number): ThreadStandardRow => ({
    size,
    form: "iso",
    diameter,
    pitch,
});

const inch = (size: string, diameter: number, tpi: number, form: ThreadForm): ThreadStandardRow => ({
    size,
    form,
    diameter: round(diameter * 25.4),
    pitch: round(25.4 / tpi),
});

function round(value: number): number {
    return Math.round(value * 1000) / 1000;
}

/** ISO metric coarse (ISO 261 first and second choice, M2–M30). */
const ISO_COARSE: readonly ThreadStandardRow[] = [
    iso("M2", 2, 0.4),
    iso("M2.5", 2.5, 0.45),
    iso("M3", 3, 0.5),
    iso("M3.5", 3.5, 0.6),
    iso("M4", 4, 0.7),
    iso("M5", 5, 0.8),
    iso("M6", 6, 1),
    iso("M8", 8, 1.25),
    iso("M10", 10, 1.5),
    iso("M12", 12, 1.75),
    iso("M14", 14, 2),
    iso("M16", 16, 2),
    iso("M18", 18, 2.5),
    iso("M20", 20, 2.5),
    iso("M22", 22, 2.5),
    iso("M24", 24, 3),
    iso("M27", 27, 3),
    iso("M30", 30, 3.5),
];

/** ISO metric fine — the pitches ISO 261 lists first for each size. */
const ISO_FINE: readonly ThreadStandardRow[] = [
    iso("M3×0.35", 3, 0.35),
    iso("M4×0.5", 4, 0.5),
    iso("M5×0.5", 5, 0.5),
    iso("M6×0.75", 6, 0.75),
    iso("M8×1", 8, 1),
    iso("M10×1", 10, 1),
    iso("M10×1.25", 10, 1.25),
    iso("M12×1.25", 12, 1.25),
    iso("M12×1.5", 12, 1.5),
    iso("M14×1.5", 14, 1.5),
    iso("M16×1.5", 16, 1.5),
    iso("M18×1.5", 18, 1.5),
    iso("M20×1.5", 20, 1.5),
    iso("M22×1.5", 22, 1.5),
    iso("M24×2", 24, 2),
    iso("M27×2", 27, 2),
    iso("M30×2", 30, 2),
];

/** BSPP / G (ISO 228-1): major diameters from the standard, mm. */
const BSP: readonly ThreadStandardRow[] = [
    { size: "G1/16", form: "whitworth", diameter: 7.723, pitch: round(25.4 / 28) },
    { size: "G1/8", form: "whitworth", diameter: 9.728, pitch: round(25.4 / 28) },
    { size: "G1/4", form: "whitworth", diameter: 13.157, pitch: round(25.4 / 19) },
    { size: "G3/8", form: "whitworth", diameter: 16.662, pitch: round(25.4 / 19) },
    { size: "G1/2", form: "whitworth", diameter: 20.955, pitch: round(25.4 / 14) },
    { size: "G3/4", form: "whitworth", diameter: 26.441, pitch: round(25.4 / 14) },
    { size: "G1", form: "whitworth", diameter: 33.249, pitch: round(25.4 / 11) },
];

/** Unified fine and coarse (ASME B1.1). */
const UNIFIED: readonly ThreadStandardRow[] = [
    inch("#10-32 UNF", 0.19, 32, "unified"),
    inch("1/4-28 UNF", 0.25, 28, "unified"),
    inch("5/16-24 UNF", 0.3125, 24, "unified"),
    inch("3/8-24 UNF", 0.375, 24, "unified"),
    inch("7/16-20 UNF", 0.4375, 20, "unified"),
    inch("1/2-20 UNF", 0.5, 20, "unified"),
    inch("9/16-18 UNF", 0.5625, 18, "unified"),
    inch("5/8-18 UNF", 0.625, 18, "unified"),
    inch("3/4-16 UNF", 0.75, 16, "unified"),
    inch("#10-24 UNC", 0.19, 24, "unified"),
    inch("1/4-20 UNC", 0.25, 20, "unified"),
    inch("5/16-18 UNC", 0.3125, 18, "unified"),
    inch("3/8-16 UNC", 0.375, 16, "unified"),
    inch("1/2-13 UNC", 0.5, 13, "unified"),
];

/** Every preset, in panel order: metric coarse, metric fine, BSP, unified. */
export const THREAD_STANDARDS: readonly ThreadStandardRow[] = [
    ...ISO_COARSE,
    ...ISO_FINE,
    ...BSP,
    ...UNIFIED,
];

export const THREAD_FORMS: readonly ThreadForm[] = ["iso", "unified", "whitworth"];

export function threadRow(size: string): ThreadStandardRow | undefined {
    return THREAD_STANDARDS.find((row) => row.size === size);
}

/** The flank angle of a form, degrees (included angle). */
export function threadFlankAngle(form: ThreadForm): number {
    return form === "whitworth" ? 55 : 60;
}

/**
 * The basic radial depth of a form's thread, from the major diameter to the minor one:
 * 5H/8 for the 60° forms (ISO 68-1, the same for unified), 2H/3 for Whitworth — H being the
 * height of the sharp fundamental triangle.
 */
export function threadDepth(form: ThreadForm, pitch: number): number {
    const half = (threadFlankAngle(form) / 2) * (Math.PI / 180);
    const sharp = pitch / (2 * Math.tan(half));
    return form === "whitworth" ? (2 * sharp) / 3 : (5 * sharp) / 8;
}

/**
 * The diameter a modelled face of this thread is expected to have: the major diameter for an
 * external thread (the rod is turned to it), the tap-drill diameter `D − P` for an internal one
 * (the hole is drilled to it before tapping — what a designer models a threaded bore as). The
 * tap drill rather than the basic minor diameter: an M8 bore modelled at 6.8 must suggest M8,
 * not M8×1, whose basic minor diameter happens to be nearer.
 */
export function expectedFaceDiameter(row: ThreadStandardRow, internal: boolean): number {
    return internal ? row.diameter - row.pitch : row.diameter;
}

/**
 * The preset that best fits a face of `diameter` — the nearest expected face diameter, metric
 * coarse preferred by `PREFERENCE_MARGIN` and the table order breaking ties.
 * Undefined when even the nearest row is more than 10% (and 0.5 mm) away: a 50 mm shaft must not
 * be offered an M30 as though it fitted.
 */
export function suggestThreadSize(diameter: number, internal: boolean): ThreadStandardRow | undefined {
    let best: ThreadStandardRow | undefined;
    let bestError = Number.POSITIVE_INFINITY;
    for (const row of THREAD_STANDARDS) {
        const miss = Math.abs(expectedFaceDiameter(row, internal) - diameter);
        const error = miss + (ISO_COARSE.includes(row) ? 0 : PREFERENCE_MARGIN);
        // A strict margin, so a later row needs to be clearly better to displace an earlier one.
        if (error < bestError - 1e-3) {
            best = row;
            bestError = error;
        }
    }
    if (best === undefined || bestError > Math.max(0.5, 0.1 * diameter)) return undefined;
    return best;
}

/**
 * How much nearer, in mm, a fine, pipe or inch size must be than the metric coarse one to be
 * suggested instead: a Ø7.9 rod is an M8 printed a little small far more often than a 5/16" one
 * (7.94), and a Ø6.8 bore the M8 tap drill rather than a G1/16's (6.82).
 */
const PREFERENCE_MARGIN = 0.15;
