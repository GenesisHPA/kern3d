// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Point3 } from "./gcodePath";

/**
 * A pretend GRBL controller for `station.html?demo`: it answers lines with `ok` as it carries
 * them out, moves at the programmed feed, keeps work offsets, runs the spindle, reports status
 * to `?`, honours feed hold / resume / reset / jog cancel. Enough to try the station's screen
 * without a machine; it is not a G-code interpreter (no arcs — they go straight to the end).
 */
export class DemoGrbl {
    private readonly lines: string[] = [];
    private mpos: Point3 = [-250, -140, -30];
    private wco: Point3 = [-200, -90, -40];
    private target?: Point3;
    private feed = 600;
    private rapid = false;
    private spindle = 0;
    private absolute = true;
    private state = "Idle";
    private held = false;
    private timer: ReturnType<typeof setInterval>;

    constructor(
        private readonly onData: (text: string) => void,
        private readonly onClose: () => void,
    ) {
        this.timer = setInterval(() => this.step(0.02), 20);
        setTimeout(() => this.say("Grbl 1.1h ['$' for help]"), 50);
    }

    private say(text: string) {
        this.onData(`${text}\r\n`);
    }

    async write(data: string): Promise<void> {
        for (const ch of data) {
            if (ch === "?") this.report();
            else if (ch === "!") this.held = true;
            else if (ch === "~") this.held = false;
            else if (ch === "\x18") this.reset();
            else if (ch === "\x85") this.cancelJog();
            else if (ch.charCodeAt(0) >= 0x80) continue; // overrides: accepted, ignored
        }
        for (const line of data.split("\n")) {
            // realtime bytes (?, !, ~, reset, overrides) are not part of a line
            const l = [...line]
                .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) < 0x80 && !"?!~".includes(c))
                .join("")
                .trim();
            if (l) this.lines.push(l);
        }
    }

    async close(): Promise<void> {
        clearInterval(this.timer);
        this.onClose();
    }

    private reset() {
        this.lines.length = 0;
        this.target = undefined;
        this.held = false;
        this.spindle = 0;
        this.state = "Idle";
        this.say("Grbl 1.1h ['$' for help]");
    }

    private cancelJog() {
        if (this.state === "Jog") {
            this.target = undefined;
            this.lines.length = 0;
            this.state = "Idle";
        }
    }

    private report() {
        const f = (p: number[]) => p.map((v) => v.toFixed(3)).join(",");
        const state = this.held && this.state !== "Idle" ? "Hold:0" : this.state;
        this.say(
            `<${state}|MPos:${f(this.mpos)}|FS:${this.target ? (this.rapid ? 3000 : this.feed) : 0},${this.spindle}|WCO:${f(this.wco)}|Ov:100,100,100>`,
        );
    }

    /** Takes the next line when the last move is over; moves the tool on. */
    private step(dt: number) {
        if (this.held) return;
        if (this.target) {
            const d = this.target.map((v, i) => v - this.mpos[i]);
            const len = Math.hypot(...d);
            const speed = ((this.rapid ? 3000 : this.feed) / 60) * dt * 4; // ×4: a demo, not real time
            if (len <= speed) {
                this.mpos = this.target;
                this.target = undefined;
                this.say("ok");
            } else this.mpos = this.mpos.map((v, i) => v + (d[i] / len) * speed) as Point3;
            return;
        }
        if (this.state === "Run" || this.state === "Jog" || this.state === "Home") this.state = "Idle";
        const line = this.lines.shift();
        if (line !== undefined) this.execute(line.toUpperCase());
    }

    private execute(line: string) {
        if (line === "$X") return this.say("ok");
        // the demo machine: 350 × 150 × 120 mm of travel, no homing switches
        if (line === "$$") {
            for (const s of ["$20=0", "$21=0", "$22=0", "$130=350.000", "$131=150.000", "$132=120.000"])
                this.say(s);
            return this.say("ok");
        }
        if (line === "$H") {
            this.state = "Home";
            this.rapid = true;
            this.target = [0, 0, 0];
            return;
        }
        const jog = line.startsWith("$J=");
        const words = new Map(
            [...line.replace(/^\$J=/, "").matchAll(/([A-Z])([-+]?\d*\.?\d+)/g)].map((m) => [
                m[1],
                Number(m[2]),
            ]),
        );
        const g = [...line.matchAll(/G(\d+)/g)].map((m) => Number(m[1]));
        if (g.includes(90)) this.absolute = true;
        if (g.includes(91)) this.absolute = false;
        if (words.has("F")) this.feed = words.get("F")!;
        if (/M3|M4/.test(line)) this.spindle = words.get("S") ?? 12000;
        if (/M5/.test(line)) this.spindle = 0;
        if (g.includes(10) && words.get("L") === 20) {
            // G10 L20 P1: this point becomes the given work position
            this.wco = this.wco.map((v, i) => {
                const a = "XYZ"[i];
                return words.has(a) ? this.mpos[i] - words.get(a)! : v;
            }) as Point3;
            return this.say("ok");
        }
        const axes = ["X", "Y", "Z"].filter((a) => words.has(a));
        if (axes.length === 0) return this.say("ok");
        const relative = jog || !this.absolute;
        this.target = this.mpos.map((v, i) => {
            const a = "XYZ"[i];
            if (!words.has(a)) return v;
            return relative ? v + words.get(a)! : words.get(a)! + this.wco[i];
        }) as Point3;
        this.rapid = g.includes(0) && !jog;
        this.state = jog ? "Jog" : "Run";
    }
}

/** A demo job: a rounded pocket in three depths and a contour round it. */
export function demoProgram(): string {
    const out = ["(Kern3D demo pocket)", "G21 G90 G54", "M3 S12000", "G0 Z5", "G0 X0 Y0"];
    for (const z of [-1, -2.5, -4]) {
        out.push(`G1 Z${z} F300`);
        for (let r = 0; r < 7; r++) {
            const w = 40 - r * 5;
            const h = 25 - r * 3.2;
            if (h < 3) break;
            out.push(`G1 X${-w} Y${-h} F1200`, `X${w}`, `Y${h}`, `X${-w}`, `Y${-h}`);
        }
        out.push("G0 Z5", "G0 X0 Y0");
    }
    out.push("G0 X-46 Y-31", "G1 Z-5 F300", "G1 X46 F900", "Y31", "X-46", "Y-31", "G0 Z20", "M5", "G0 X0 Y0");
    return out.join("\n");
}
