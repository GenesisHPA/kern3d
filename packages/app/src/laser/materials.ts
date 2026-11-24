// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { LaserMode, LaserOperation } from "./laserData";

/**
 * The material library: an operation's settings saved under a name («Анодированный алюминий —
 * заливка», «Фанера 4 мм — рез»), applied to the selection in one pick. Kept in this browser /
 * this computer (localStorage), the same for every job.
 */
export interface MaterialPreset {
    name: string;
    mode: LaserMode;
    power: number;
    speed: number;
    passes: number;
    frequency: number;
    fillInterval: number;
    fillAngle: number;
    air: boolean;
}

const STORAGE_KEY = "kern3d.laser.materials";

function finite(v: unknown, d: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : d;
}

export function parseMaterials(json: string | null | undefined): MaterialPreset[] {
    if (json === null || json === undefined || json === "") return [];
    try {
        const raw = JSON.parse(json);
        if (!Array.isArray(raw)) return [];
        return raw
            .filter((x) => typeof x?.name === "string" && x.name.trim() !== "")
            .map((x) => ({
                name: String(x.name).trim(),
                mode: x.mode === "fill" ? "fill" : "line",
                power: finite(x.power, 50),
                speed: finite(x.speed, 1000),
                passes: Math.max(1, Math.round(finite(x.passes, 1))),
                frequency: finite(x.frequency, 30),
                fillInterval: finite(x.fillInterval, 0.05),
                fillAngle: finite(x.fillAngle, 0),
                air: x.air === true,
            }));
    } catch {
        return [];
    }
}

export function loadMaterials(): MaterialPreset[] {
    try {
        return parseMaterials(globalThis.localStorage?.getItem(STORAGE_KEY));
    } catch {
        return [];
    }
}

function store(list: MaterialPreset[]) {
    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
        // storage off (private window): the library lasts this session only
    }
}

/** The operation's settings saved under `name` (one of that name is replaced). */
export function saveMaterial(name: string, op: LaserOperation): MaterialPreset[] {
    const preset = presetOf(name.trim(), op);
    const list = loadMaterials().filter((m) => m.name !== preset.name);
    list.push(preset);
    list.sort((a, b) => a.name.localeCompare(b.name));
    store(list);
    return list;
}

export function removeMaterial(name: string): MaterialPreset[] {
    const list = loadMaterials().filter((m) => m.name !== name);
    store(list);
    return list;
}

export function presetOf(name: string, op: LaserOperation): MaterialPreset {
    return {
        name,
        mode: op.mode,
        power: op.power,
        speed: op.speed,
        passes: op.passes,
        frequency: op.frequency,
        fillInterval: op.fillInterval,
        fillAngle: op.fillAngle,
        air: op.air,
    };
}

/** The preset onto an operation; the mode only where the object can take it (an image stays one). */
export function applyMaterial(op: LaserOperation, m: MaterialPreset) {
    op.power = m.power;
    op.speed = m.speed;
    op.passes = m.passes;
    op.frequency = m.frequency;
    op.fillInterval = m.fillInterval;
    op.fillAngle = m.fillAngle;
    op.air = m.air;
    if (op.mode !== "image" && m.mode !== "image") op.mode = m.mode;
}

/**
 * The test matrix: power across, speed down, one square per pair — burned once on a scrap of a
 * new material to find its settings. Values evenly spaced from `from` to `to`, both included.
 */
export interface TestMatrixSpec {
    powerFrom: number;
    powerTo: number;
    columns: number;
    speedFrom: number;
    speedTo: number;
    rows: number;
    /** Square side and the gap between squares, mm. */
    cell: number;
    gap: number;
    mode: "fill" | "line";
}

export function defaultTestMatrix(): TestMatrixSpec {
    return {
        powerFrom: 20,
        powerTo: 100,
        columns: 5,
        speedFrom: 500,
        speedTo: 3000,
        rows: 5,
        cell: 5,
        gap: 2,
        mode: "fill",
    };
}

export function steps(from: number, to: number, count: number): number[] {
    const n = Math.max(1, Math.round(count));
    if (n === 1) return [from];
    return Array.from({ length: n }, (_, i) => Math.round((from + ((to - from) * i) / (n - 1)) * 100) / 100);
}

export interface MatrixCell {
    /** Lower-left corner relative to the matrix's top-left (y goes down: negative). */
    x: number;
    y: number;
    power: number;
    speed: number;
}

/** The squares, row by row from the top: x to the right, y downward from 0. */
export function matrixCells(spec: TestMatrixSpec): MatrixCell[] {
    const powers = steps(spec.powerFrom, spec.powerTo, spec.columns);
    const speeds = steps(spec.speedFrom, spec.speedTo, spec.rows);
    const pitch = spec.cell + spec.gap;
    const cells: MatrixCell[] = [];
    speeds.forEach((speed, r) =>
        powers.forEach((power, c) =>
            cells.push({ x: c * pitch, y: -(r + 1) * pitch + spec.gap, power, speed }),
        ),
    );
    return cells;
}
