// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The milling tool library: every cutter the machine has, with how it cuts. Kept on this
 * computer (localStorage), shared by every milling job; a job keeps a copy of the tools it uses
 * so it reopens the same elsewhere.
 */
export const TOOL_KINDS = ["flat", "ball", "bull", "vbit", "drill", "chamfer", "knife"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/**
 * A drag (swivel) knife held where the spindle goes: a free-turning blade whose tip trails its
 * axis by `offset`, so the path is shifted ahead of the line and corners swivel the blade round.
 * It never turns: a job that uses one has no spindle in it at all (see `millProgram`).
 */
export interface KnifeSettings {
    /** How far the blade's tip trails the holder's axis, mm (0.25 for a usual 45° blade). */
    offset: number;
    /** The depth an operation with this knife starts with, mm (film over its backing: 0.1–0.3). */
    cutDepth: number;
    /** A closed outline is cut on past its start by this much so the cut joins, mm. */
    overcut: number;
    /** Corners turning more than this, degrees, swivel the blade round (a loop or a lift). */
    cornerAngle: number;
    /** «loop»: round the corner in the material; «lift»: up to the top, swivel there, down again. */
    corners: "loop" | "lift";
}

export function defaultKnife(): KnifeSettings {
    return { offset: 0.25, cutDepth: 0.3, overcut: 1, cornerAngle: 30, corners: "loop" };
}

export function isKnife(tool: CamTool | undefined): boolean {
    return tool?.kind === "knife";
}

/** The knife settings of a tool (the defaults when it has none). */
export function knifeOf(tool: CamTool): KnifeSettings {
    return { ...defaultKnife(), ...tool.knife };
}

export interface CamTool {
    id: string;
    /** The pocket number in the changer / the T word (T1...). */
    number: number;
    name: string;
    kind: ToolKind;
    /** Cutting diameter, mm (a V-bit / chamfer: its widest). */
    diameter: number;
    /** Corner radius, mm (bull nose); a ball is diameter/2. */
    cornerRadius: number;
    /** V-bit / chamfer / drill point: the included angle, degrees. */
    angle: number;
    /** Flute (cutting) length, mm. */
    fluteLength: number;
    flutes: number;
    /** Cutting data: spindle rpm, feed and plunge mm/min, depth per pass and step-over mm. */
    rpm: number;
    feed: number;
    plunge: number;
    stepDown: number;
    stepOver: number;
    /** A drag knife's own settings (only for `kind` "knife"; optional, older files have none). */
    knife?: KnifeSettings;
}

const STORAGE_KEY = "kern3d.cam.tools";

let counter = 0;
export function newToolId(): string {
    counter++;
    return `t${Date.now().toString(36)}${counter.toString(36)}`;
}

/**
 * A sensible starter set: a 3 mm and a 6 mm flat end mill, a 3 mm ball, a 60° V-bit, a 3 mm drill
 * and a drag knife.
 */
export function defaultTools(): CamTool[] {
    const base = (
        number: number,
        name: string,
        kind: ToolKind,
        diameter: number,
        more: Partial<CamTool>,
    ): CamTool => ({
        id: `default-${number}`,
        number,
        name,
        kind,
        diameter,
        cornerRadius: kind === "ball" ? diameter / 2 : 0,
        angle: kind === "vbit" ? 60 : kind === "chamfer" ? 90 : kind === "drill" ? 118 : 0,
        fluteLength: diameter * 4,
        flutes: 2,
        rpm: 18000,
        feed: 800,
        plunge: 250,
        stepDown: diameter / 2,
        stepOver: diameter * 0.45,
        ...more,
    });
    return [
        base(1, "Фреза 3 мм", "flat", 3, { feed: 800, stepDown: 1 }),
        base(2, "Фреза 6 мм", "flat", 6, { feed: 1200, stepDown: 2, rpm: 15000 }),
        base(3, "Сферическая 3 мм", "ball", 3, { feed: 700, stepDown: 0.6, stepOver: 0.3 }),
        base(4, "Гравер V 60°", "vbit", 6, { feed: 600, stepDown: 0.3, fluteLength: 6 }),
        base(5, "Сверло 3 мм", "drill", 3, { flutes: 2, rpm: 8000, plunge: 150, stepDown: 3 }),
        base(6, "Флюгерный нож", "knife", 1, {
            flutes: 1,
            rpm: 0,
            feed: 1500,
            plunge: 300,
            stepDown: 5,
            stepOver: 1,
            fluteLength: 6,
            knife: defaultKnife(),
        }),
    ];
}

function finite(v: unknown, d: number, min = Number.NEGATIVE_INFINITY): number {
    return typeof v === "number" && Number.isFinite(v) ? Math.max(min, v) : d;
}

export function parseTool(raw: any): CamTool | undefined {
    if (raw === null || typeof raw !== "object") return undefined;
    const kind: ToolKind = TOOL_KINDS.includes(raw.kind) ? raw.kind : "flat";
    const diameter = finite(raw.diameter, 3, 0.01);
    return {
        id: typeof raw.id === "string" && raw.id !== "" ? raw.id : newToolId(),
        number: Math.round(finite(raw.number, 1, 0)),
        name: typeof raw.name === "string" ? raw.name : "",
        kind,
        diameter,
        cornerRadius: finite(raw.cornerRadius, kind === "ball" ? diameter / 2 : 0, 0),
        angle: finite(raw.angle, 0, 0),
        fluteLength: finite(raw.fluteLength, diameter * 4, 0.1),
        flutes: Math.round(finite(raw.flutes, 2, 1)),
        rpm: finite(raw.rpm, 18000, 0),
        feed: finite(raw.feed, 800, 1),
        plunge: finite(raw.plunge, 250, 1),
        stepDown: finite(raw.stepDown, diameter / 2, 0.01),
        stepOver: finite(raw.stepOver, diameter * 0.45, 0.01),
        ...(kind === "knife" ? { knife: parseKnife(raw.knife) } : {}),
    };
}

function parseKnife(raw: any): KnifeSettings {
    const d = defaultKnife();
    const r = raw !== null && typeof raw === "object" ? raw : {};
    return {
        offset: finite(r.offset, d.offset, 0),
        cutDepth: finite(r.cutDepth, d.cutDepth, 0),
        overcut: finite(r.overcut, d.overcut, 0),
        cornerAngle: Math.min(179, finite(r.cornerAngle, d.cornerAngle, 0)),
        corners: r.corners === "lift" ? "lift" : "loop",
    };
}

export function parseTools(json: string | null | undefined): CamTool[] | undefined {
    if (json === null || json === undefined || json === "") return undefined;
    try {
        const raw = JSON.parse(json);
        if (!Array.isArray(raw)) return undefined;
        return raw.map(parseTool).filter((t): t is CamTool => t !== undefined);
    } catch {
        return undefined;
    }
}

export function loadTools(): CamTool[] {
    try {
        return parseTools(globalThis.localStorage?.getItem(STORAGE_KEY)) ?? defaultTools();
    } catch {
        return defaultTools();
    }
}

export function storeTools(tools: CamTool[]) {
    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(tools));
    } catch {
        // storage off: the library lasts this session only
    }
}

/** The width a tool cuts at `depth` below its tip (a V-bit widens with depth). */
export function cutWidthAt(tool: CamTool, depth: number): number {
    if (tool.kind === "knife") return 0;
    if (tool.kind !== "vbit" && tool.kind !== "chamfer") return tool.diameter;
    const half = (Math.max(1, Math.min(179, tool.angle)) * Math.PI) / 360;
    return Math.min(tool.diameter, 2 * Math.max(0, depth) * Math.tan(half));
}
