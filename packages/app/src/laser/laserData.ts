// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type Affine,
    addPoint,
    apply,
    type Bounds,
    emptyBounds,
    type LaserPath,
    multiply,
    rotation,
    scaling,
    translation,
} from "./geometry";
import type { BedOrigin, MachineProfile } from "./machineProfile";
import { type LaserShape, parseShape } from "./shapes";

/**
 * A laser job as the document keeps it: the objects on the bed and how each is burnt. The
 * machine (bed size, S range, acceleration, port) is not part of it — that is the workstation's
 * profile, kept apart (`machineProfile.ts`).
 */

/** Line: along the outlines. Fill: hatched inside them. Image: engraved pixel by pixel. */
export const LASER_MODES = ["line", "fill", "image"] as const;
export type LaserMode = (typeof LASER_MODES)[number];

/** Line-to-line grayscale, error-diffusion dithering, or a plain black/white threshold. */
export const RASTER_MODES = ["grayscale", "dither", "threshold"] as const;
export type RasterMode = (typeof RASTER_MODES)[number];

export const DITHER_KINDS = ["floyd", "jarvis"] as const;
export type DitherKind = (typeof DITHER_KINDS)[number];

export interface RasterSettings {
    mode: RasterMode;
    dither: DitherKind;
    /** Lines (and pixels along them) per millimetre. */
    resolution: number;
    /** −100…100, added to the lightness. */
    brightness: number;
    /** −100…100. */
    contrast: number;
    /** Applied to the lightness, 1 = unchanged; above 1 darkens the mid-tones. */
    gamma: number;
    invert: boolean;
    /** Threshold mode: pixels darker than this lightness % burn. */
    threshold: number;
    /** Grayscale: pixels lighter than (100 − this) % are skipped as white. */
    whiteClip: number;
    /** Grayscale: the power % the lightest burnt pixel gets (the darkest gets the layer's power). */
    minPower: number;
    /** How far past each line the head runs with the laser off, so it turns round off the work, mm. */
    overscan: number;
}

export interface LaserOperation {
    mode: LaserMode;
    /** % of the machine's maximum S. */
    power: number;
    /** mm/min. */
    speed: number;
    passes: number;
    /** M8 on for the object, M9 after it. */
    air: boolean;
    /** Fill: hatch spacing, mm. */
    fillInterval: number;
    /** Fill: hatch direction, degrees from +x. */
    fillAngle: number;
    raster: RasterSettings;
    /** Galvo (JCZ): pulse frequency, kHz. */
    frequency: number;
    /** Galvo (JCZ): the pen whose delays and pulse width are used; empty = the first pen. */
    pen: string;
}

interface LaserObjectBase {
    id: string;
    name: string;
    /** Lower-left corner of the object's box before rotation, bed mm. */
    x: number;
    y: number;
    /** Size on the bed, mm. */
    width: number;
    height: number;
    /** Counter-clockwise about the box centre, degrees. */
    angle: number;
    lockAspect: boolean;
    /** Left out of the job and the preview, but kept. */
    hidden?: boolean;
    op: LaserOperation;
}

export interface LaserVectorObject extends LaserObjectBase {
    kind: "vector";
    /** Outlines in the object's own frame: [0, sourceWidth] × [0, sourceHeight], mm, y up. */
    paths: LaserPath[];
    sourceWidth: number;
    sourceHeight: number;
    /** Drawn with a tool: the figure the outlines are made from, again on every change. */
    shape?: LaserShape;
}

export interface LaserImageObject extends LaserObjectBase {
    kind: "image";
    /** The picture as a data URL (PNG / JPEG / BMP), kept with the document. */
    dataUrl: string;
    pixelWidth: number;
    pixelHeight: number;
}

export type LaserObject = LaserVectorObject | LaserImageObject;

export interface LaserJobData {
    version: 1;
    /**
     * The origin the objects' coordinates are measured from. A job stored before there was a
     * choice has none and was made on the corner; `withOrigin` moves a job onto the machine's.
     */
    origin: BedOrigin;
    objects: LaserObject[];
}

export function defaultRaster(): RasterSettings {
    return {
        mode: "grayscale",
        dither: "floyd",
        resolution: 10,
        brightness: 0,
        contrast: 0,
        gamma: 1,
        invert: false,
        threshold: 50,
        whiteClip: 5,
        minPower: 0,
        overscan: 2,
    };
}

export function defaultOperation(mode: LaserMode): LaserOperation {
    return {
        mode,
        power: mode === "line" ? 80 : 50,
        speed: mode === "image" ? 3000 : 1000,
        passes: 1,
        air: false,
        fillInterval: 0.1,
        fillAngle: 0,
        raster: defaultRaster(),
        frequency: 30,
        pen: "",
    };
}

export function defaultLaserJob(origin: BedOrigin = "center"): LaserJobData {
    return { version: 1, origin, objects: [] };
}

/**
 * The job measured from `profile`'s origin: every object shifted by half the bed when the job
 * was laid out from the other one, so it stays where it was on the bed. A copy when it moves.
 */
export function withOrigin(
    job: LaserJobData,
    profile: Pick<MachineProfile, "origin" | "bedWidth" | "bedHeight">,
): LaserJobData {
    if (job.origin === profile.origin) return job;
    const sign = profile.origin === "center" ? -1 : 1;
    const dx = (sign * profile.bedWidth) / 2;
    const dy = (sign * profile.bedHeight) / 2;
    return {
        ...job,
        origin: profile.origin,
        objects: job.objects.map((o) => ({ ...o, x: o.x + dx, y: o.y + dy })),
    };
}

let counter = 0;
export function newLaserId(): string {
    counter = (counter + 1) % 1_000_000;
    return `o${Date.now().toString(36)}${counter.toString(36)}`;
}

/** The object's own frame (source units) to the bed: scale to size, turn about the centre, place. */
export function objectMatrix(o: LaserObject): Affine {
    const sourceW = o.kind === "vector" ? o.sourceWidth : o.pixelWidth;
    const sourceH = o.kind === "vector" ? o.sourceHeight : o.pixelHeight;
    const sx = sourceW > 0 ? o.width / sourceW : 1;
    const sy = sourceH > 0 ? o.height / sourceH : 1;
    return multiply(placement(o), scaling(sx, sy));
}

/** The box frame ([0, width] × [0, height] mm) to the bed: turned about its centre and placed. */
export function placement(o: Pick<LaserObject, "x" | "y" | "width" | "height" | "angle">): Affine {
    const cx = o.width / 2;
    const cy = o.height / 2;
    return multiply(translation(o.x + cx, o.y + cy), multiply(rotation(o.angle), translation(-cx, -cy)));
}

/** The four corners of the object's box on the bed, counter-clockwise from its lower left. */
export function objectCorners(o: LaserObject) {
    const m = placement(o);
    return [
        apply(m, { x: 0, y: 0 }),
        apply(m, { x: o.width, y: 0 }),
        apply(m, { x: o.width, y: o.height }),
        apply(m, { x: 0, y: o.height }),
    ];
}

/** The axis-aligned box around everything that will be burnt. */
export function jobBounds(data: LaserJobData): Bounds {
    const b = emptyBounds();
    for (const o of data.objects) {
        if (o.hidden) continue;
        for (const p of objectCorners(o)) addPoint(b, p);
    }
    return b;
}

function finite(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
    return options.includes(value as T) ? (value as T) : fallback;
}

function parseOperation(raw: Partial<LaserOperation> | undefined, mode: LaserMode): LaserOperation {
    const base = defaultOperation(mode);
    const r: Partial<RasterSettings> = raw?.raster ?? {};
    const raster = base.raster;
    return {
        mode: oneOf(raw?.mode, LASER_MODES, mode),
        power: finite(raw?.power, base.power),
        speed: finite(raw?.speed, base.speed),
        passes: Math.max(1, Math.round(finite(raw?.passes, 1))),
        air: raw?.air === true,
        fillInterval: finite(raw?.fillInterval, base.fillInterval),
        fillAngle: finite(raw?.fillAngle, base.fillAngle),
        frequency: finite(raw?.frequency, base.frequency),
        pen: typeof raw?.pen === "string" ? raw.pen : "",
        raster: {
            mode: oneOf(r.mode, RASTER_MODES, raster.mode),
            dither: oneOf(r.dither, DITHER_KINDS, raster.dither),
            resolution: finite(r.resolution, raster.resolution),
            brightness: finite(r.brightness, raster.brightness),
            contrast: finite(r.contrast, raster.contrast),
            gamma: finite(r.gamma, raster.gamma),
            invert: r.invert === true,
            threshold: finite(r.threshold, raster.threshold),
            whiteClip: finite(r.whiteClip, raster.whiteClip),
            minPower: finite(r.minPower, raster.minPower),
            overscan: finite(r.overscan, raster.overscan),
        },
    };
}

function parseObject(raw: any): LaserObject | undefined {
    if (raw === null || typeof raw !== "object") return undefined;
    const base = {
        id: typeof raw.id === "string" ? raw.id : newLaserId(),
        name: typeof raw.name === "string" ? raw.name : "",
        x: finite(raw.x, 0),
        y: finite(raw.y, 0),
        width: finite(raw.width, 10),
        height: finite(raw.height, 10),
        angle: finite(raw.angle, 0),
        lockAspect: raw.lockAspect !== false,
        hidden: raw.hidden === true ? true : undefined,
    };
    if (raw.kind === "image" && typeof raw.dataUrl === "string") {
        return {
            ...base,
            kind: "image",
            dataUrl: raw.dataUrl,
            pixelWidth: finite(raw.pixelWidth, 1),
            pixelHeight: finite(raw.pixelHeight, 1),
            op: { ...parseOperation(raw.op, "image"), mode: "image" },
        };
    }
    if (raw.kind === "vector" && Array.isArray(raw.paths)) {
        const op = parseOperation(raw.op, "line");
        return {
            ...base,
            kind: "vector",
            paths: raw.paths.filter((p: any) => Array.isArray(p?.points)),
            sourceWidth: finite(raw.sourceWidth, base.width),
            sourceHeight: finite(raw.sourceHeight, base.height),
            op: op.mode === "image" ? { ...op, mode: "line" } : op,
            ...shapeField(raw.shape),
        };
    }
    return undefined;
}

function shapeField(raw: unknown): { shape?: LaserShape } {
    const shape = parseShape(raw);
    return shape === undefined ? {} : { shape };
}

/** A job from its stored JSON; anything unreadable becomes an empty job, unknown fields defaults. */
export function parseLaserJob(json: string | undefined): LaserJobData {
    if (json === undefined || json === "") return defaultLaserJob();
    // unreadable falls through to an empty job below
    try {
        const raw = JSON.parse(json);
        const objects = Array.isArray(raw?.objects) ? raw.objects.map(parseObject) : [];
        return {
            version: 1,
            origin: raw?.origin === "center" ? "center" : "corner",
            objects: objects.filter((o: LaserObject | undefined) => o !== undefined),
        };
    } catch {
        return defaultLaserJob();
    }
}

/** Coordinates rounded to a micron keep the stored JSON small. */
export function stringifyLaserJob(data: LaserJobData): string {
    return JSON.stringify(data, (key, value) =>
        typeof value === "number" && (key === "x" || key === "y") ? Math.round(value * 1e4) / 1e4 : value,
    );
}
