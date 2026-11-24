// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CamTool } from "./camTools";
import { type CamOperation, cutData, type Heights, type MillMove, operationMoves } from "./toolpath";

/** The milling machine: what the G-code may use. */
export interface MillMachine {
    /** GRBL has no tool changer: a change is a pause (M0) to swap by hand, then re-zero Z. */
    toolChange: "pause" | "m6";
    /** The controller's G-code dialect (see `POSTS`). */
    post: PostKind;
    /** Air blast / coolant per operation: M7 (mist / air) or M8 (flood); off — none. */
    air: "off" | "m7" | "m8";
    /** Wait after starting the spindle, s. */
    spindleDelay: number;
    /** Rapid speed for the time estimate, mm/min. */
    rapidFeed: number;
    heights: Heights;
    /** Work area, mm (a warning when the paths leave it). */
    width: number;
    depth: number;
    height: number;
    coolant: boolean;
}

export function defaultMillMachine(): MillMachine {
    return {
        toolChange: "pause",
        post: "grbl",
        air: "off",
        spindleDelay: 3,
        rapidFeed: 3000,
        heights: { safeZ: 5, clearance: 1 },
        width: 300,
        depth: 200,
        height: 60,
        coolant: false,
    };
}

export const POST_KINDS = ["grbl", "mach3", "linuxcnc"] as const;
export type PostKind = (typeof POST_KINDS)[number];

/**
 * What differs between controllers. GRBL: no tool changer (M6 ignored), no tool length
 * offsets. Mach3 (and the LAN motion boards it drives): M6 runs the change macro, G43 Hn takes
 * the tool's length. LinuxCNC: the same, the program wrapped in %.
 */
interface Post {
    begin: string[];
    end: string[];
    lengthOffset: boolean;
}
const POSTS: Record<PostKind, Post> = {
    grbl: { begin: [], end: ["M30"], lengthOffset: false },
    mach3: { begin: ["G40 G49 G80"], end: ["M30"], lengthOffset: true },
    linuxcnc: { begin: ["%", "G40 G49 G80 G64 P0.01"], end: ["M2", "%"], lengthOffset: true },
};

export interface MillProgram {
    gcode: string;
    /** Every operation's moves, for the preview. */
    moves: { op: CamOperation; tool: CamTool; moves: MillMove[] }[];
    /** Estimated run time, s (feeds as given, no acceleration). */
    seconds: number;
    /** Operations left out, with why. */
    skipped: { op: CamOperation; reason: "noTool" | "noGeometry" }[];
    bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number };
}

function f(v: number): string {
    const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "");
    return s === "-0" ? "0" : s;
}

/** The job as G-code (G21 mm, G90 absolute, the work's top at Z0) with the moves and an estimate. */
export function millProgram(
    ops: readonly CamOperation[],
    tools: readonly CamTool[],
    m: MillMachine,
): MillProgram {
    const post = POSTS[m.post] ?? POSTS.grbl;
    const out: string[] = [
        ...post.begin,
        `(Kern3D milling, ${m.post})`,
        "G21 G90 G17 G94",
        `G0 Z${f(m.heights.safeZ)}`,
    ];
    const moves: MillProgram["moves"] = [];
    const skipped: MillProgram["skipped"] = [];
    let seconds = 0;
    let tool: CamTool | undefined;
    let pos = { x: 0, y: 0, z: m.heights.safeZ };
    const b = { minX: Infinity, minY: Infinity, minZ: 0, maxX: -Infinity, maxY: -Infinity };
    for (const op of ops) {
        if (op.hidden === true) continue;
        const t = tools.find((x) => x.id === op.toolId);
        if (t === undefined) {
            skipped.push({ op, reason: "noTool" });
            continue;
        }
        const list = operationMoves(op, t, m.heights);
        if (list.length === 0) {
            skipped.push({ op, reason: "noGeometry" });
            continue;
        }
        const c = cutData(op, t);
        out.push(
            "",
            `(${op.name.replace(/[()]/g, "")} — T${t.number} ${t.name.replace(/[()]/g, "")} Ø${f(t.diameter)})`,
        );
        if (tool?.id !== t.id) {
            if (tool !== undefined) out.push("M5", `G0 Z${f(m.heights.safeZ)}`);
            if (post.lengthOffset) out.push(`T${t.number} M6 G43 H${t.number}`);
            else if (m.toolChange === "m6") out.push(`T${t.number} M6`);
            else if (tool !== undefined)
                out.push(`(change to T${t.number} ${t.name.replace(/[()]/g, "")}, set Z0)`, "M0");
            tool = t;
        }
        out.push(`S${Math.round(c.rpm)} M3`);
        if (m.spindleDelay > 0) out.push(`G4 P${f(m.spindleDelay)}`);
        if (m.coolant || m.air === "m8") out.push("M8");
        else if (m.air === "m7") out.push("M7");
        seconds += m.spindleDelay;
        let mode = "";
        let feed = -1;
        for (const mv of list) {
            const g = mv.type === "rapid" ? "G0" : "G1";
            const want = mv.type === "rapid" ? m.rapidFeed : mv.type === "plunge" ? c.plunge : c.feed;
            const words = [g === mode ? "" : g];
            if (mv.x !== pos.x) words.push(`X${f(mv.x)}`);
            if (mv.y !== pos.y) words.push(`Y${f(mv.y)}`);
            if (mv.z !== pos.z) words.push(`Z${f(mv.z)}`);
            if (g === "G1" && want !== feed) {
                words.push(`F${Math.round(want)}`);
                feed = want;
            }
            const line = words.filter((w) => w !== "").join(" ");
            if (line !== "" && line !== g) out.push(line);
            mode = g;
            const d = Math.hypot(mv.x - pos.x, mv.y - pos.y, mv.z - pos.z);
            seconds += (d / want) * 60;
            pos = { x: mv.x, y: mv.y, z: mv.z };
            if (mv.type !== "rapid") {
                b.minX = Math.min(b.minX, mv.x);
                b.minY = Math.min(b.minY, mv.y);
                b.maxX = Math.max(b.maxX, mv.x);
                b.maxY = Math.max(b.maxY, mv.y);
                b.minZ = Math.min(b.minZ, mv.z);
            }
        }
        if (m.coolant || m.air !== "off") out.push("M9");
        moves.push({ op, tool: t, moves: list });
    }
    out.push("", "M5", `G0 Z${f(m.heights.safeZ)}`, ...post.end, "");
    return { gcode: out.join("\n"), moves, seconds, skipped, bounds: b };
}
