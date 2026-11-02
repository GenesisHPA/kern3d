// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The persisted description of a 2D drawing: the sheet, the title block, the views and the
 * annotations placed on it. Geometry is NOT part of it — every view is projected again from
 * the live model whenever the drawing is shown or exported, which is what keeps the views
 * associative. Coordinates on the sheet are millimetres from the sheet's lower-left corner,
 * y up; points a dimension measures are stored in the view's own model-space 2D frame
 * (millimetres of the model, before the view scale), so the value is read off the model and
 * moving or rescaling the view carries the dimension along.
 */

export type Vec3 = [number, number, number];

export const SHEET_FORMATS = ["A4", "A3", "A2", "A1", "A0"] as const;
export type SheetFormat = (typeof SHEET_FORMATS)[number];

export const SHEET_ORIENTATIONS = ["landscape", "portrait"] as const;
export type SheetOrientation = (typeof SHEET_ORIENTATIONS)[number];

export const TITLE_BLOCK_KINDS = ["gost", "iso", "none"] as const;
export type TitleBlockKind = (typeof TITLE_BLOCK_KINDS)[number];

/** First angle is the ГОСТ 2.305 / ISO-E default; third angle is the US one. */
export const PROJECTION_ANGLES = ["first", "third"] as const;
export type ProjectionAngle = (typeof PROJECTION_ANGLES)[number];

export const VIEW_ORIENTATIONS = ["front", "top", "right", "left", "bottom", "back", "iso"] as const;
export type ViewOrientation = (typeof VIEW_ORIENTATIONS)[number];

/** Where a projected view sits relative to its parent on the sheet. */
export const PROJECTION_SIDES = ["right", "left", "up", "down"] as const;
export type ProjectionSide = (typeof PROJECTION_SIDES)[number];

export const TITLE_FIELDS = [
    "name",
    "designation",
    "material",
    "mass",
    "scale",
    "sheet",
    "sheets",
    "developer",
    "checker",
    "techControl",
    "normControl",
    "approver",
    "date",
    "organization",
    "letter",
] as const;
export type TitleField = (typeof TITLE_FIELDS)[number];

export interface SheetData {
    format: SheetFormat;
    orientation: SheetOrientation;
}

export interface TitleBlockData {
    kind: TitleBlockKind;
    fields: Partial<Record<TitleField, string>>;
}

export interface DrawingViewData {
    id: string;
    /** Id of the model node the view projects. */
    sourceId: string;
    /** Display name of the base orientation; for a projected view the one it was derived to. */
    orientation: ViewOrientation | "custom";
    /** Model axis drawn along the sheet's +x. */
    u: Vec3;
    /** Model axis drawn along the sheet's +y. */
    v: Vec3;
    /** Paper / model: 0.5 is 1:2. */
    scale: number;
    /** Sheet position of the view's centre (the centre of its projected bounds). */
    x: number;
    y: number;
    /** A projected view keeps the parent's scale and stays aligned with it. */
    parentId?: string;
    side?: ProjectionSide;
    showHidden: boolean;
    showTangent: boolean;
    showCenterMarks: boolean;
    label?: string;
}

export type Point2 = [number, number];

export const LINEAR_DIMENSION_KINDS = ["horizontal", "vertical", "aligned"] as const;
export type LinearDimensionKind = (typeof LINEAR_DIMENSION_KINDS)[number];

export interface LinearDimensionData {
    id: string;
    kind: LinearDimensionKind;
    viewId: string;
    /** Measured points in the view's model 2D frame. */
    a: Point2;
    b: Point2;
    /** Signed distance on paper (mm) from the measured points to the dimension line. */
    offset: number;
    /** Replaces the computed value when set (e.g. a tolerance appended by hand). */
    textOverride?: string;
}

export interface RadialDimensionData {
    id: string;
    kind: "diameter" | "radius";
    viewId: string;
    /** Circle centre in the view's model 2D frame. */
    center: Point2;
    /** Model radius. */
    radius: number;
    /** Direction of the leader, degrees from the sheet's +x. */
    angle: number;
    textOverride?: string;
}

export type DrawingDimensionData = LinearDimensionData | RadialDimensionData;

export function isRadialDimension(d: DrawingDimensionData): d is RadialDimensionData {
    return d.kind === "diameter" || d.kind === "radius";
}

export interface DrawingNoteData {
    id: string;
    x: number;
    y: number;
    text: string;
    /** Character height on paper, mm. */
    height: number;
}

export interface DrawingData {
    sheet: SheetData;
    projection: ProjectionAngle;
    titleBlock: TitleBlockData;
    views: DrawingViewData[];
    dimensions: DrawingDimensionData[];
    notes: DrawingNoteData[];
}

export function defaultDrawingData(): DrawingData {
    return {
        sheet: { format: "A3", orientation: "landscape" },
        projection: "first",
        titleBlock: { kind: "gost", fields: { sheet: "1", sheets: "1" } },
        views: [],
        dimensions: [],
        notes: [],
    };
}

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
    return values.includes(value as T) ? (value as T) : fallback;
}

function finite(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function vec3(value: unknown, fallback: Vec3): Vec3 {
    if (!Array.isArray(value) || value.length !== 3) return fallback;
    return [finite(value[0], fallback[0]), finite(value[1], fallback[1]), finite(value[2], fallback[2])];
}

function point2(value: unknown): Point2 {
    if (!Array.isArray(value)) return [0, 0];
    return [finite(value[0], 0), finite(value[1], 0)];
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function parseView(raw: unknown): DrawingViewData | undefined {
    const r = asRecord(raw);
    if (typeof r["id"] !== "string" || typeof r["sourceId"] !== "string") return undefined;
    const orientation =
        r["orientation"] === "custom" ? "custom" : oneOf(VIEW_ORIENTATIONS, r["orientation"], "front");
    return {
        id: r["id"],
        sourceId: r["sourceId"],
        orientation,
        u: vec3(r["u"], [1, 0, 0]),
        v: vec3(r["v"], [0, 0, 1]),
        scale: Math.max(1e-6, finite(r["scale"], 1)),
        x: finite(r["x"], 0),
        y: finite(r["y"], 0),
        parentId: typeof r["parentId"] === "string" ? r["parentId"] : undefined,
        side: r["side"] === undefined ? undefined : oneOf(PROJECTION_SIDES, r["side"], "right"),
        showHidden: r["showHidden"] !== false,
        showTangent: r["showTangent"] === true,
        showCenterMarks: r["showCenterMarks"] !== false,
        label: typeof r["label"] === "string" ? r["label"] : undefined,
    };
}

function parseDimension(raw: unknown): DrawingDimensionData | undefined {
    const r = asRecord(raw);
    if (typeof r["id"] !== "string" || typeof r["viewId"] !== "string") return undefined;
    const textOverride = typeof r["textOverride"] === "string" ? r["textOverride"] : undefined;
    if (r["kind"] === "diameter" || r["kind"] === "radius") {
        return {
            id: r["id"],
            kind: r["kind"],
            viewId: r["viewId"],
            center: point2(r["center"]),
            radius: Math.abs(finite(r["radius"], 1)),
            angle: finite(r["angle"], 45),
            textOverride,
        };
    }
    return {
        id: r["id"],
        kind: oneOf(LINEAR_DIMENSION_KINDS, r["kind"], "aligned"),
        viewId: r["viewId"],
        a: point2(r["a"]),
        b: point2(r["b"]),
        offset: finite(r["offset"], 10),
        textOverride,
    };
}

function parseNote(raw: unknown): DrawingNoteData | undefined {
    const r = asRecord(raw);
    if (typeof r["id"] !== "string") return undefined;
    return {
        id: r["id"],
        x: finite(r["x"], 0),
        y: finite(r["y"], 0),
        text: typeof r["text"] === "string" ? r["text"] : "",
        height: Math.max(0.5, finite(r["height"], 3.5)),
    };
}

function parseList<T>(value: unknown, parse: (raw: unknown) => T | undefined): T[] {
    if (!Array.isArray(value)) return [];
    return value.map(parse).filter((x): x is T => x !== undefined);
}

function parseFields(value: unknown): Partial<Record<TitleField, string>> {
    const r = asRecord(value);
    const fields: Partial<Record<TitleField, string>> = {};
    for (const key of TITLE_FIELDS) {
        if (typeof r[key] === "string") fields[key] = r[key] as string;
    }
    return fields;
}

/**
 * Reads a stored drawing back, tolerating anything malformed: a field that does not parse
 * takes its default, an entry that cannot be read is dropped. A drawing must always open.
 */
export function parseDrawingData(json: string | undefined): DrawingData {
    const result = defaultDrawingData();
    if (!json) return result;
    let raw: Record<string, unknown>;
    try {
        raw = asRecord(JSON.parse(json));
    } catch {
        return result;
    }
    const sheet = asRecord(raw["sheet"]);
    const title = asRecord(raw["titleBlock"]);
    return {
        sheet: {
            format: oneOf(SHEET_FORMATS, sheet["format"], result.sheet.format),
            orientation: oneOf(SHEET_ORIENTATIONS, sheet["orientation"], result.sheet.orientation),
        },
        projection: oneOf(PROJECTION_ANGLES, raw["projection"], result.projection),
        titleBlock: {
            kind: oneOf(TITLE_BLOCK_KINDS, title["kind"], result.titleBlock.kind),
            fields: title["fields"] === undefined ? result.titleBlock.fields : parseFields(title["fields"]),
        },
        views: parseList(raw["views"], parseView),
        dimensions: parseList(raw["dimensions"], parseDimension),
        notes: parseList(raw["notes"], parseNote),
    };
}

export function stringifyDrawingData(data: DrawingData): string {
    return JSON.stringify(data);
}

let idCounter = 0;
/** Short ids, unique within a drawing: time-based with a counter for same-tick calls. */
export function newDrawingItemId(prefix: string): string {
    idCounter = (idCounter + 1) % 1_000_000;
    return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}
