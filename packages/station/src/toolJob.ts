// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { cleanLine } from "@chili3d/app/src/laser/grblController";
import type { Point3, ProgramPath } from "./gcodePath";

/** A tool change inside a program: before code line `at` the tool `tool` goes in. */
export interface PlannedChange {
    at: number;
    tool: number;
    name?: string;
}

/** A tool as a program names it: its number, and its name when the program says. */
export interface ToolRef {
    tool: number;
    name?: string;
}

/** Kern3D's operation comment: `(Карман — T1 Фреза 6 мм Ø6)`. */
const OP_TOOL = /\bT(\d+)\s+([^()]*?)\s*Ø\s*([\d.]+)\s*\)?\s*$/;

/**
 * A program as the station runs it: the code lines GRBL gets (comments gone), the program line
 * each came from, and the tool changes — Kern3D writes `(change to T2 Фреза 3 мм, set Z0)` + `M0`
 * for GRBL, other CAM `T2 M6`. The change lines themselves are not sent: the station does the
 * change (spindle off, to the change place, the new tool measured) between the parts.
 */
export function jobProgram(lines: readonly string[]): {
    code: string[];
    src: number[];
    changes: PlannedChange[];
    /** The tools in the order they are used: the first one, then each change's. */
    tools: ToolRef[];
} {
    const code: string[] = [];
    const src: number[] = [];
    const changes: PlannedChange[] = [];
    let next: { tool: number; name?: string } | undefined;
    let first: ToolRef | undefined;
    lines.forEach((raw, i) => {
        const line = raw.trim();
        if (first === undefined && changes.length === 0 && line.startsWith("(")) {
            const op = OP_TOOL.exec(line);
            if (op) first = { tool: Number(op[1]), name: `${op[2].trim()} Ø${op[3]}`.trim() };
        }
        const marker = /^\(change to T(\d+)\s*([^,)]*)/i.exec(line);
        if (marker) {
            next = { tool: Number(marker[1]), name: marker[2].trim() || undefined };
            return;
        }
        const c = cleanLine(line);
        if (c === "") return;
        const m6 = /^T(\d+)M0?6(?!\d)/i.exec(c);
        if (m6) {
            const tool = Number(m6[1]);
            changes.push({ at: code.length, tool, name: next?.tool === tool ? next.name : undefined });
            next = undefined;
            return;
        }
        if (/^M0?0$/i.test(c) && next !== undefined) {
            changes.push({ at: code.length, ...next });
            next = undefined;
            return;
        }
        code.push(c);
        src.push(i);
    });
    // two changes with nothing between them: only the last counts
    const merged = changes.filter((ch, i) => changes[i + 1]?.at !== ch.at);
    const tools: ToolRef[] = [
        ...(first ? [first] : []),
        ...merged.map((c) => ({ tool: c.tool, name: c.name })),
    ];
    return { code, src, changes: merged, tools };
}

function distanceToSegment(p: Point3, a: Point3, b: Point3): number {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const len = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    const t = len > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len)) : 0;
    const d = [a[0] + ab[0] * t - p[0], a[1] + ab[1] * t - p[1], a[2] + ab[2] * t - p[2]];
    return Math.hypot(d[0], d[1], d[2]);
}

/**
 * Where an interrupted job carries on from: of the program lines between `fromLine` and
 * `toLine` (those GRBL could have been cutting — it takes lines ahead of where the tool is), the
 * one whose path passes nearest to where the tool stopped. That line is cut again from its start:
 * a short stretch twice, never a stretch missed.
 */
export function resumeLine(path: ProgramPath, at: Point3, fromLine: number, toLine: number): number {
    let best = fromLine;
    let bestD = Number.POSITIVE_INFINITY;
    for (const s of path.segments) {
        if (s.line < fromLine || s.line > toLine) continue;
        const d = distanceToSegment(at, s.from, s.to);
        if (d < bestD - 1e-6) {
            bestD = d;
            best = s.line;
        }
    }
    return best;
}
