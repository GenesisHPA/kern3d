// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PubSub } from "@chili3d/core";
import { GrblController, type GrblStatus, REALTIME } from "../laser/grblController";
import { el, t } from "../laser/laserUi";
import { WebSerialConnection } from "../laser/webSerial";
import style from "./camControl.module.css";
import type { MillMachine } from "./camGcode";
import { levelProgram } from "./camLevel";
import { type ProgramSegment, splitAtToolChanges } from "./camProbe";
import { ProbeWorkflow } from "./camProbePanel";
import { clock, frameLines, outsideTravel, parseOffsetLine, runFromLine, timeLeft } from "./camRun";
import type { CamTool } from "./camTools";
import {
    AXES,
    type Axis,
    GRBL_SETTINGS,
    goZeroLines,
    JOG_STEPS,
    jogLine,
    OVERRIDE,
    parseSetting,
    probeLines,
    stateColor,
} from "./machineControl";
import type { VfdSpindle } from "./vfd";

export interface ControlHost {
    machine(): MillMachine;
    /** The program to run, its lines (comments kept: they mark the tool changes). */
    programLines(): string[];
    /** The job's tools. */
    tools(): CamTool[];
    /** The program's extent (work coordinates) and estimated time, s. */
    summary(): {
        bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number };
        seconds: number;
    };
    /** The inverter when it is on and connected. */
    vfd(): VfdSpindle | undefined;
}

const PREFS = "kern3d.cam.panel";

/** A panel preference kept between sessions (step, speeds, the plate). */
function pref<T>(key: string, fallback: T): T {
    try {
        const v = JSON.parse(localStorage.getItem(PREFS) ?? "{}")[key];
        return v === undefined || typeof v !== typeof fallback ? fallback : (v as T);
    } catch {
        return fallback;
    }
}

function storePref(key: string, value: unknown) {
    try {
        const all = JSON.parse(localStorage.getItem(PREFS) ?? "{}");
        all[key] = value;
        localStorage.setItem(PREFS, JSON.stringify(all));
    } catch {}
}

const AXIS_COLORS: Record<Axis, string> = { X: "#ff6b6b", Y: "#51cf66", Z: "#4dabf7" };
const WCS = ["G54", "G55", "G56", "G57", "G58", "G59"];

function btn(text: string, onClick: () => void, cls = "", title = ""): HTMLButtonElement {
    const b = el("button", { textContent: text, title, onclick: onClick });
    b.className = [style.btn, cls].filter((c) => c).join(" ");
    return b;
}

function card(title: string, ...children: Node[]): HTMLElement {
    const c = el("section", {}, el("h4", { textContent: title }), ...children);
    c.className = style.card;
    return c;
}

/**
 * The machine control panel, after LinuxCNC's screens (QtDragon, gmoccapy, Probe Basic):
 * big position readouts with zero / touch-off per axis, a jog pad with steps, the spindle
 * and coolant by hand, feed / rapid / spindle overrides, cycle start / pause / stop with the
 * program's current line, MDI, a touch-plate probe and the controller's settings.
 */
export class MachineControl {
    readonly element = el("div");
    private grbl?: GrblController;
    private port?: WebSerialConnection;
    private poll?: ReturnType<typeof setInterval>;
    private status: GrblStatus = { state: "—" };
    private accessories = "";
    private overrides: [number, number, number] = [100, 100, 100];
    private step = pref("step", 1);
    private jogFeed = pref("jogFeed", 1000);
    private rpm = pref("rpm", 12000);
    private readonly offsets = new Map<string, number[]>();
    private fromLine = 1;
    private started = 0;
    private checkMode = false;
    private readonly timeText = el("div");
    private readonly travelText = el("div");
    private running: string[] = [];
    private acked = 0;
    private spindleAt = 0;
    private readonly log: string[] = [];
    private readonly history: string[] = [];
    private settings = new Map<number, string>();
    private probe = pref("plate", { thickness: 20, travel: 30, feed: 100, retract: 5 });
    private tab: "program" | "mdi" | "probe" | "offsets" | "settings" = "program";
    private segments: ProgramSegment[] = [];
    private readonly bannerHost = el("div");
    private readonly workflow = new ProbeWorkflow(
        () => this.grbl,
        () => this.host.tools(),
        () => this.workflowChanged(),
        (text) => this.addLog(text),
        () => this.host.summary().bounds,
    );

    // live parts, updated in place on every status report
    private readonly stateBadge = el("span");
    private readonly dro = new Map<Axis, { work: HTMLElement; machine: HTMLElement }>();
    private readonly spindleText = el("div");
    private readonly feedText = el("div");
    private readonly ovText = { feed: el("b"), rapid: el("b"), spindle: el("b") };
    private readonly pinsText = el("div");
    private readonly progress = el("div");
    private readonly progressBar = el("div");
    private readonly lines = el("div");
    private readonly console = el("pre");
    private readonly coolantButtons = { mist: el("button"), flood: el("button") };
    private readonly tabBody = el("div");

    constructor(private readonly host: ControlHost) {
        this.element.className = style.root;
        document.addEventListener("keydown", this.onKey);
        document.addEventListener("keyup", this.onKeyUp);
    }

    /** Built on first show: the job is not loaded yet when the panel is made. */
    show() {
        if (this.element.childElementCount === 0) this.build();
    }

    dispose() {
        document.removeEventListener("keydown", this.onKey);
        document.removeEventListener("keyup", this.onKeyUp);
        void this.disconnect();
    }

    get connected(): boolean {
        return this.grbl !== undefined;
    }

    // ---- connection ---------------------------------------------------------------------------

    private async connect() {
        try {
            let controller: GrblController | undefined;
            const port = await WebSerialConnection.request(
                115200,
                (text) => controller?.receive(text),
                () => this.dropped(),
            );
            controller = new GrblController(port);
            controller.on((e) => {
                if (e.type === "status") this.onStatus(e.status);
                else if (e.type === "in" || e.type === "out") this.onLine(e.type, e.text);
                else if (e.type === "progress") {
                    this.acked = e.acked;
                    this.showProgress();
                    void this.followSpindle();
                } else if (e.type === "job") {
                    this.addLog(`— ${t(`laser.job.${e.state}`)}`);
                    if (e.state === "done") void this.nextSegment();
                    else if (e.state === "stopped" || e.state === "error") this.segments = [];
                } else if (e.type === "alarm")
                    this.addLog(`ALARM:${e.code} — ${t(`laser.grbl.alarm.${e.code}`)}`);
                else if (e.type === "error")
                    this.addLog(`error:${e.code} — ${t(`laser.grbl.error.${e.code}`)} ← ${e.line}`);
            });
            this.grbl = controller;
            this.port = port;
            this.poll = setInterval(() => void this.grbl?.realtime(REALTIME.status), 200);
            this.build();
        } catch (e) {
            PubSub.default.pub("showToast", "mill.vfd.failed" as never, String(e));
        }
    }

    private dropped() {
        if (this.poll) clearInterval(this.poll);
        this.poll = undefined;
        this.grbl = undefined;
        this.port = undefined;
        this.status = { state: "—" };
        this.build();
    }

    private async disconnect() {
        await this.port?.close().catch(() => {});
        this.dropped();
    }

    private send(...lines: string[]) {
        if (!this.grbl) return;
        for (const l of lines) this.grbl.send(l);
    }

    private rt(byte: string) {
        void this.grbl?.realtime(byte);
    }

    // ---- incoming -----------------------------------------------------------------------------

    private onStatus(s: GrblStatus) {
        this.status = s;
        if (s.overrides) {
            this.overrides = s.overrides;
            this.accessories = s.accessories ?? "";
        } else if (s.accessories !== undefined) this.accessories = s.accessories;
        this.showStatus();
    }

    private onLine(dir: "in" | "out", text: string) {
        const offset = dir === "in" ? parseOffsetLine(text) : undefined;
        if (offset) {
            this.offsets.set(offset.name, offset.values);
            if (this.tab === "offsets") this.renderTab();
        }
        const setting = dir === "in" ? parseSetting(text) : undefined;
        if (setting) {
            this.settings.set(setting.id, setting.value);
            if (this.tab === "settings") this.renderTab();
        }
        this.addLog(dir === "out" ? `> ${text}` : text);
    }

    private addLog(text: string) {
        this.log.push(text);
        if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
        this.console.textContent = this.log.join("\n");
        this.console.scrollTop = this.console.scrollHeight;
    }

    private showStatus() {
        const s = this.status;
        if (s.state === "Idle") this.checkTravel();
        this.stateBadge.textContent = s.state;
        this.stateBadge.style.backgroundColor = stateColor(s.state);
        this.stateBadge.setAttribute("data-state", s.state.split(":")[0].toLowerCase());
        AXES.forEach((a, i) => {
            const d = this.dro.get(a);
            if (!d) return;
            const value = s.wpos ? s.wpos[i].toFixed(3) : "—";
            if (d.work.textContent !== value) {
                d.work.textContent = value;
                d.work.classList.remove(style.changed);
                void d.work.offsetWidth; // restart the glow
                d.work.classList.add(style.changed);
            }
            d.machine.textContent = s.mpos ? `${t("cnc.machineShort")} ${s.mpos[i].toFixed(3)}` : "";
        });
        this.spindleText.textContent =
            s.spindle !== undefined ? `${Math.round(s.spindle)} ${t("cnc.rpm")}` : `— ${t("cnc.rpm")}`;
        this.feedText.textContent = `${t("cnc.feed")}: ${s.feed !== undefined ? Math.round(s.feed) : "—"} ${t("cnc.mmMin")}`;
        this.ovText.feed.textContent = `${this.overrides[0]}%`;
        this.ovText.rapid.textContent = `${this.overrides[1]}%`;
        this.ovText.spindle.textContent = `${this.overrides[2]}%`;
        this.coolantButtons.mist.classList.toggle(style.on, this.accessories.includes("M"));
        this.coolantButtons.flood.classList.toggle(style.on, this.accessories.includes("F"));
        const pins = s.pins ?? "";
        this.pinsText.replaceChildren(
            ...["X", "Y", "Z", "P", "D", "H", "R", "S"].map((p) => {
                const led = el("span", { textContent: p, title: t(`cnc.pin.${p}`) });
                led.className = `${style.led} ${pins.includes(p) ? style.ledOn : ""}`;
                return led;
            }),
        );
    }

    private showProgress() {
        const total = this.running.length;
        const pct = total > 0 ? (this.acked / total) * 100 : 0;
        this.progressBar.style.width = `${pct.toFixed(1)}%`;
        this.progress.title = `${this.acked} / ${total}`;
        if (this.started > 0 && total > 0) {
            const elapsed = (performance.now() - this.started) / 1000;
            const left = timeLeft(this.host.summary().seconds, this.acked, total, elapsed);
            this.timeText.textContent = `${t("cnc.time.elapsed")} ${clock(elapsed)}${left !== undefined ? ` · ${t("cnc.time.left")} ${clock(left)}` : ""} · ${this.acked} / ${total}`;
        }
        if (this.tab === "program") this.showLines();
    }

    /** About 120 lines around the one being run, the current one marked. */
    private showLines() {
        const lines = this.running.length > 0 ? this.running : this.host.programLines();
        const from = Math.max(0, this.acked - 20);
        const to = Math.min(lines.length, from + 120);
        const out: HTMLElement[] = [];
        for (let i = from; i < to; i++) {
            const line = el(
                "div",
                {},
                el("span", { textContent: String(i + 1) }),
                el("code", { textContent: lines[i] }),
            );
            if (i === this.acked && this.running.length > 0) line.className = style.current;
            else if (i < this.acked && this.running.length > 0) line.className = style.done;
            out.push(line);
        }
        this.lines.replaceChildren(...out);
    }

    private async followSpindle() {
        const vfd = this.host.vfd();
        if (!vfd) return;
        while (this.spindleAt < Math.min(this.acked, this.running.length)) {
            await vfd.onLine(this.running[this.spindleAt]);
            this.spindleAt++;
        }
    }

    // ---- actions ------------------------------------------------------------------------------

    private cycleStart() {
        const g = this.grbl;
        if (!g) return;
        if (g.jobState === "paused") {
            g.resume();
            return;
        }
        this.started = 0;
        this.segments = splitAtToolChanges(this.host.programLines());
        this.workflow.current ??= this.host.tools()[0]?.number;
        this.startSegment(this.segments.shift());
    }

    private startSegment(seg: ProgramSegment | undefined) {
        if (!seg || !this.grbl) return;
        const map = this.workflow.heightMap;
        this.running = map && this.workflow.applyMap ? levelProgram(seg.lines, map) : seg.lines;
        this.acked = 0;
        this.spindleAt = 0;
        this.grbl.startJob(this.running);
        if (this.started === 0) this.started = performance.now();
        this.showProgress();
    }

    /** A part of the program finished: change the tool, then run the next part. */
    private async nextSegment() {
        const seg = this.segments.shift();
        if (!seg) return;
        try {
            if (seg.tool !== undefined) await this.workflow.toolChange(seg.tool);
            this.startSegment(seg);
        } catch (e) {
            this.segments = [];
            this.addLog(`[change] ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private workflowChanged() {
        const banner = this.workflow.changeBanner();
        this.bannerHost.replaceChildren(...(banner ? [banner] : []));
        if (this.tab === "probe") this.renderTab();
    }

    /** Trace the part's outline over the stock, at the safe height. */
    private frame() {
        const m = this.host.machine();
        this.send(...frameLines(this.host.summary().bounds, m.heights.safeZ, this.jogFeed));
    }

    /** Run from the chosen line of the current program (its first part with no tool change after). */
    private runFrom() {
        const g = this.grbl;
        if (!g || g.jobActive) return;
        const segs = splitAtToolChanges(this.host.programLines());
        // which part the line is in, counted over all parts
        let n = this.fromLine - 1;
        let i = 0;
        while (i < segs.length - 1 && n >= segs[i].lines.length) {
            n -= segs[i].lines.length;
            i++;
        }
        const seg = segs[i];
        this.segments = segs.slice(i + 1);
        this.started = 0;
        if (seg.tool !== undefined) this.workflow.current = seg.tool;
        this.startSegment({ lines: runFromLine(seg.lines, n, this.host.machine().heights.safeZ) });
    }

    /** Warn when the program, at the current work zero, would leave the machine's travel. */
    private checkTravel() {
        const m = this.host.machine();
        const wco =
            this.status.mpos && this.status.wpos
                ? (this.status.mpos.map((v, i) => v - this.status.wpos![i]) as [number, number, number])
                : undefined;
        const axes = outsideTravel(this.host.summary().bounds, wco, { x: m.width, y: m.depth, z: m.height });
        this.travelText.textContent = axes.length > 0 ? `⚠ ${t("cnc.travel.outside", axes.join(", "))}` : "";
    }

    private stopAll() {
        this.segments = [];
        this.workflow.waiting?.reject(new Error(t("cnc.change.cancelled")));
        this.grbl?.stop();
        void this.host.vfd()?.stop();
    }

    private spindle(kind: "cw" | "ccw" | "stop") {
        const vfd = this.host.vfd();
        if (kind === "stop") {
            this.send("M5");
            void vfd?.stop();
        } else {
            this.send(`${kind === "cw" ? "M3" : "M4"} S${Math.round(this.rpm)}`);
            void vfd?.run(this.rpm, kind === "ccw");
        }
    }

    private coolant(kind: "mist" | "flood" | "off") {
        if (kind === "off") {
            this.send("M9");
            return;
        }
        const on = this.accessories.includes(kind === "mist" ? "M" : "F");
        // during a program the toggles act at once; when idle a plain M7 / M8 / M9 does
        if (this.grbl?.jobActive) this.rt(kind === "mist" ? OVERRIDE.mistToggle : OVERRIDE.floodToggle);
        else this.send(on ? "M9" : kind === "mist" ? "M7" : "M8");
    }

    private jogStep(axis: Axis, dir: 1 | -1) {
        const line = jogLine({ [axis]: dir * this.step }, axis === "Z" ? this.jogFeed / 2 : this.jogFeed);
        if (line) this.send(line);
    }

    /** Continuous: one long jog while held, cancelled on release. */
    private jogHold(moves: Partial<Record<Axis, 1 | -1>>) {
        const m = this.host.machine();
        const far = Math.max(m.width, m.depth, m.height, 100);
        const dist: Partial<Record<Axis, number>> = {};
        for (const a of AXES) if (moves[a]) dist[a] = moves[a]! * far;
        const line = jogLine(dist, moves.Z && !moves.X && !moves.Y ? this.jogFeed / 2 : this.jogFeed);
        if (line) this.send(line);
    }

    private jogRelease() {
        this.rt(REALTIME.jogCancel);
    }

    private jogButton(text: string, moves: Partial<Record<Axis, 1 | -1>>, color: string): HTMLButtonElement {
        const b = btn(text, () => {}, style.jog);
        b.style.borderColor = color;
        b.onpointerdown = (e) => {
            b.setPointerCapture(e.pointerId);
            if (this.step === 0) this.jogHold(moves);
            else {
                const dist: Partial<Record<Axis, number>> = {};
                for (const a of AXES) if (moves[a]) dist[a] = moves[a]! * this.step;
                const z = moves.Z && !moves.X && !moves.Y;
                const line = jogLine(dist, z ? this.jogFeed / 2 : this.jogFeed);
                if (line) this.send(line);
            }
        };
        b.onpointerup = b.onpointercancel = () => {
            if (this.step === 0) this.jogRelease();
        };
        return b;
    }

    private heldKey: string | undefined;
    private readonly onKey = (e: KeyboardEvent) => {
        if (!this.element.isConnected || !this.grbl || e.repeat) return;
        const target = e.target as HTMLElement | null;
        if (
            target &&
            (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
        )
            return;
        const keys: Record<string, Partial<Record<Axis, 1 | -1>>> = {
            ArrowLeft: { X: -1 },
            ArrowRight: { X: 1 },
            ArrowUp: { Y: 1 },
            ArrowDown: { Y: -1 },
            PageUp: { Z: 1 },
            PageDown: { Z: -1 },
        };
        const m = keys[e.key];
        if (m) {
            e.preventDefault();
            this.heldKey = e.key;
            if (this.step === 0) this.jogHold(m);
            else {
                const a = Object.keys(m)[0] as Axis;
                this.jogStep(a, m[a]!);
            }
        } else if (e.key === "Escape") this.stopAll();
    };

    private readonly onKeyUp = (e: KeyboardEvent) => {
        if (e.key === this.heldKey) {
            this.heldKey = undefined;
            if (this.step === 0) this.jogRelease();
        }
    };

    // ---- building -----------------------------------------------------------------------------

    private build() {
        const g = this.grbl;
        this.stateBadge.className = style.state;
        const header = el(
            "div",
            {},
            this.stateBadge,
            g
                ? btn(t("cnc.disconnect"), () => void this.disconnect())
                : btn(t("cnc.connect"), () => void this.connect(), style.primary),
            btn(t("cnc.reset"), () => this.rt(REALTIME.reset), "", t("cnc.reset.hint")),
            btn(t("cnc.unlock"), () => this.send("$X"), "", t("cnc.unlock.hint")),
            btn(t("cnc.homeAll"), () => this.send("$H"), "", t("cnc.home.hint")),
            this.pinsText,
        );
        header.className = style.header;
        if (this.host.machine().post !== "grbl")
            header.append(el("span", { className: style.note, textContent: t("cnc.otherPost") }));

        const grid = el(
            "div",
            {},
            this.droCard(),
            this.jogCard(),
            this.spindleCard(),
            this.cycleCard(),
            this.tabsCard(),
        );
        grid.className = style.grid;
        this.element.replaceChildren(header, this.bannerHost, grid);
        this.showStatus();
        this.showProgress();
        if (!g) {
            const veil = el("div", { textContent: t("cnc.notConnected") });
            veil.className = style.veil;
            grid.append(veil);
        }
    }

    private droCard(): HTMLElement {
        const rows = AXES.map((a, i) => {
            const work = el("div");
            work.className = style.droValue;
            work.title = t("cnc.touchOff.hint");
            work.onclick = () => this.touchOff(a, work);
            const machine = el("div");
            machine.className = style.droMachine;
            this.dro.set(a, { work, machine });
            const letter = el("div", { textContent: a });
            letter.className = style.droAxis;
            letter.style.color = AXIS_COLORS[a];
            const r = el(
                "div",
                {},
                letter,
                el("div", {}, work, machine),
                btn("0", () => this.send(`G10 L20 P0 ${a}0`), style.zero, t("cnc.zeroAxis", a)),
                btn("⌂", () => this.send(`$H${a}`), "", t("cnc.homeAxis.hint", a)),
                btn("½", () => this.half(i, a), "", t("cnc.half.hint")),
            );
            r.className = style.droRow;
            return r;
        });
        const wcs = el(
            "div",
            {},
            ...WCS.map((w) => btn(w, () => this.send(w), style.small)),
            btn(t("cnc.zeroAll"), () => this.send("G10 L20 P0 X0 Y0 Z0"), style.small),
            btn(
                t("cnc.goZero"),
                () => this.send(...goZeroLines(this.host.machine().heights.safeZ, "xy")),
                style.small,
            ),
        );
        wcs.className = style.row;
        return card(t("cnc.position"), ...rows, wcs);
    }

    /** Click on a readout: type the value this point should have. */
    private touchOff(axis: Axis, target: HTMLElement) {
        if (!this.grbl) return;
        const input = el("input", { type: "number", step: "any", value: "0" });
        input.className = style.touch;
        const done = (apply: boolean) => {
            if (apply && Number.isFinite(Number(input.value)))
                this.send(`G10 L20 P0 ${axis}${Number(input.value)}`);
            input.replaceWith(target);
            this.showStatus();
        };
        input.onkeydown = (e) => {
            if (e.key === "Enter") done(true);
            else if (e.key === "Escape") done(false);
        };
        input.onblur = () => done(false);
        target.replaceWith(input);
        input.select();
    }

    /** Edge finding: zero halfway between here and the work zero (centre of a part). */
    private half(i: number, axis: Axis) {
        const w = this.status.wpos?.[i];
        if (w !== undefined) this.send(`G10 L20 P0 ${axis}${(w / 2).toFixed(3)}`);
    }

    private jogCard(): HTMLElement {
        const pad = el(
            "div",
            {},
            this.jogButton("↖", { X: -1, Y: 1 }, "#888"),
            this.jogButton("Y+", { Y: 1 }, AXIS_COLORS.Y),
            this.jogButton("↗", { X: 1, Y: 1 }, "#888"),
            this.jogButton("Z+", { Z: 1 }, AXIS_COLORS.Z),
            this.jogButton("X−", { X: -1 }, AXIS_COLORS.X),
            btn("⏹", () => this.jogRelease(), style.jog, t("cnc.jogStop")),
            this.jogButton("X+", { X: 1 }, AXIS_COLORS.X),
            el("span"),
            this.jogButton("↙", { X: -1, Y: -1 }, "#888"),
            this.jogButton("Y−", { Y: -1 }, AXIS_COLORS.Y),
            this.jogButton("↘", { X: 1, Y: -1 }, "#888"),
            this.jogButton("Z−", { Z: -1 }, AXIS_COLORS.Z),
        );
        pad.className = style.pad;
        const steps = el(
            "div",
            {},
            ...JOG_STEPS.map((s) => {
                const b = btn(s === 0 ? t("cnc.continuous") : String(s), () => {
                    this.step = s;
                    storePref("step", s);
                    for (const c of steps.children) c.classList.remove(style.on);
                    b.classList.add(style.on);
                });
                b.classList.add(style.small);
                if (s === this.step) b.classList.add(style.on);
                return b;
            }),
        );
        steps.className = style.row;
        const feed = el("input", { type: "range", min: "50", max: "5000", step: "50" });
        feed.value = String(this.jogFeed);
        const feedLabel = el("span", { textContent: `${this.jogFeed} ${t("cnc.mmMin")}` });
        feed.onchange = () => storePref("jogFeed", this.jogFeed);
        feed.oninput = () => {
            this.jogFeed = Number(feed.value);
            feedLabel.textContent = `${this.jogFeed} ${t("cnc.mmMin")}`;
        };
        const feedRow = el("label", {}, el("span", { textContent: t("cnc.jogFeed") }), feed, feedLabel);
        feedRow.className = style.slider;
        return card(
            t("cnc.jog"),
            pad,
            el("div", { className: style.caption, textContent: t("cnc.step") }),
            steps,
            feedRow,
            el("div", { className: style.caption, textContent: t("cnc.keys") }),
        );
    }

    private overrideRow(label: string, value: HTMLElement, minus: string, reset: string, plus: string) {
        const r = el(
            "div",
            {},
            el("span", { textContent: label }),
            btn("−10", () => this.rt(minus), style.small),
            value,
            btn("100%", () => this.rt(reset), style.small),
            btn("+10", () => this.rt(plus), style.small),
        );
        r.className = style.override;
        return r;
    }

    private spindleCard(): HTMLElement {
        this.spindleText.className = style.big;
        this.feedText.className = style.caption;
        const rpm = el("input", { type: "number", min: "0", step: "100" });
        rpm.value = String(this.rpm);
        rpm.onchange = () => {
            this.rpm = Math.max(0, Number(rpm.value) || 0);
            storePref("rpm", this.rpm);
        };
        const set = el("label", {}, el("span", { textContent: t("cnc.setRpm") }), rpm);
        set.className = style.slider;
        const spin = el(
            "div",
            {},
            btn(`⟳ ${t("cnc.cw")}`, () => this.spindle("cw"), style.go),
            btn(`⟲ ${t("cnc.ccw")}`, () => this.spindle("ccw"), style.go),
            btn(`■ ${t("cnc.spindleStop")}`, () => this.spindle("stop"), style.halt),
        );
        spin.className = style.row;
        this.coolantButtons.mist = btn(`💨 ${t("cnc.mist")}`, () => this.coolant("mist"));
        this.coolantButtons.flood = btn(`💧 ${t("cnc.flood")}`, () => this.coolant("flood"));
        const cool = el(
            "div",
            {},
            this.coolantButtons.mist,
            this.coolantButtons.flood,
            btn(t("cnc.coolantOff"), () => this.coolant("off")),
        );
        cool.className = style.row;
        const rapid = el(
            "div",
            {},
            el("span", { textContent: t("cnc.ovRapid") }),
            btn("25%", () => this.rt(OVERRIDE.rapid25), style.small),
            btn("50%", () => this.rt(OVERRIDE.rapid50), style.small),
            btn("100%", () => this.rt(OVERRIDE.rapid100), style.small),
            this.ovText.rapid,
        );
        rapid.className = style.override;
        return card(
            t("cnc.spindle"),
            this.spindleText,
            this.feedText,
            set,
            spin,
            el("div", { className: style.caption, textContent: t("cnc.coolant") }),
            cool,
            el("div", { className: style.caption, textContent: t("cnc.overrides") }),
            this.overrideRow(
                t("cnc.ovFeed"),
                this.ovText.feed,
                OVERRIDE.feedMinus10,
                OVERRIDE.feedReset,
                OVERRIDE.feedPlus10,
            ),
            this.overrideRow(
                t("cnc.ovSpindle"),
                this.ovText.spindle,
                OVERRIDE.spindleMinus10,
                OVERRIDE.spindleReset,
                OVERRIDE.spindlePlus10,
            ),
            rapid,
        );
    }

    private cycleCard(): HTMLElement {
        const buttons = el(
            "div",
            {},
            btn(`▶ ${t("cnc.cycleStart")}`, () => this.cycleStart(), `${style.go} ${style.cycle}`),
            btn(`⏸ ${t("cnc.feedHold")}`, () => this.grbl?.pause(), `${style.hold} ${style.cycle}`),
            btn(
                `■ ${t("cnc.stop")}`,
                () => this.stopAll(),
                `${style.halt} ${style.cycle}`,
                t("cnc.stop.hint"),
            ),
        );
        buttons.className = style.row;
        this.progress.className = style.progress;
        this.progressBar.className = style.bar;
        this.progress.replaceChildren(this.progressBar);
        this.timeText.className = style.caption;
        this.travelText.className = style.note;
        const from = el("input", { type: "number", min: "1", step: "1" });
        from.value = String(this.fromLine);
        from.style.width = "80px";
        from.onchange = () => (this.fromLine = Math.max(1, Math.round(Number(from.value) || 1)));
        const check = btn(
            t("cnc.check"),
            () => {
                this.send("$C");
                this.checkMode = !this.checkMode;
                check.classList.toggle(style.on, this.checkMode);
            },
            style.small,
            t("cnc.check.hint"),
        );
        if (this.checkMode) check.classList.add(style.on);
        const extras = el(
            "div",
            {},
            btn(`▭ ${t("cnc.frame")}`, () => this.frame(), style.small, t("cnc.frame.hint")),
            check,
            el("span", { className: style.caption, textContent: t("cnc.fromLine") }),
            from,
            btn(`▶ ${t("cnc.fromLine.run")}`, () => this.runFrom(), style.small, t("cnc.fromLine.hint")),
        );
        extras.className = style.row;
        this.checkTravel();
        return card(t("cnc.program"), buttons, this.progress, this.timeText, extras, this.travelText);
    }

    private tabsCard(): HTMLElement {
        const tabs = el(
            "div",
            {},
            ...(["program", "mdi", "probe", "offsets", "settings"] as const).map((k) => {
                const b = btn(t(`cnc.tab.${k}`), () => {
                    this.tab = k;
                    for (const c of tabs.children) c.classList.remove(style.on);
                    b.classList.add(style.on);
                    this.renderTab();
                });
                if (k === this.tab) b.classList.add(style.on);
                return b;
            }),
        );
        tabs.className = style.tabs;
        this.tabBody.className = style.tabBody;
        this.renderTab();
        const c = el("section", {}, tabs, this.tabBody);
        c.className = `${style.card} ${style.wide}`;
        return c;
    }

    private renderTab() {
        if (this.tab === "program") {
            this.lines.className = style.lines;
            this.tabBody.replaceChildren(this.lines);
            this.showLines();
        } else if (this.tab === "mdi") this.tabBody.replaceChildren(...this.mdi());
        else if (this.tab === "probe")
            this.tabBody.replaceChildren(...this.workflow.tab(this.status.mpos, this.probeTab()));
        else if (this.tab === "offsets") this.tabBody.replaceChildren(...this.offsetsTab());
        else this.tabBody.replaceChildren(...this.settingsTab());
    }

    private mdi(): HTMLElement[] {
        const input = el("input", { type: "text", placeholder: t("cnc.mdi.placeholder") });
        input.className = style.mdi;
        let back = 0;
        const run = () => {
            const v = input.value.trim();
            if (v === "") return;
            this.send(v);
            this.history.unshift(v);
            back = 0;
            input.value = "";
        };
        input.onkeydown = (e) => {
            if (e.key === "Enter") run();
            else if (e.key === "ArrowUp" && back < this.history.length) input.value = this.history[back++];
            else if (e.key === "ArrowDown" && back > 0) input.value = this.history[--back - 1] ?? "";
        };
        const quick = el(
            "div",
            {},
            ...["G0 Z10", "G28", "$#", "$G", "$I", "?"].map((q) =>
                btn(q, () => (q === "?" ? this.rt("?") : this.send(q)), style.small),
            ),
        );
        quick.className = style.row;
        this.console.className = style.console;
        return [
            el("div", { className: style.row }, input, btn(t("cnc.send"), run, style.primary)),
            quick,
            this.console,
        ];
    }

    private probeTab(): HTMLElement[] {
        const field = (key: keyof typeof this.probe, label: string) => {
            const input = el("input", { type: "number", step: "any" });
            input.value = String(this.probe[key]);
            input.onchange = () => {
                this.probe[key] = Number(input.value) || 0;
                storePref("plate", this.probe);
            };
            const l = el("label", {}, el("span", { textContent: label }), input);
            l.className = style.slider;
            return l;
        };
        return [
            el("div", { className: style.caption, textContent: t("cnc.probe.hint") }),
            field("thickness", t("cnc.probe.thickness")),
            field("travel", t("cnc.probe.travel")),
            field("feed", t("cnc.probe.feed")),
            field("retract", t("cnc.probe.retract")),
            el(
                "div",
                { className: style.row },
                btn(`⤓ ${t("cnc.probe.run")}`, () => this.send(...probeLines(this.probe)), style.primary),
            ),
        ];
    }

    /** The work offsets G54…G59, the stored positions G28 / G30, G92 and the tool length offset. */
    private offsetsTab(): HTMLElement[] {
        const rows: HTMLElement[] = [
            el(
                "div",
                { className: style.row },
                btn(t("cnc.offsets.read"), () => this.send("$#"), style.primary),
                el("span", { className: style.caption, textContent: t("cnc.offsets.hint") }),
            ),
        ];
        const table = el("div");
        table.className = style.toolTable;
        const value = (name: string) => {
            const v = this.offsets.get(name);
            return v ? v.map((x) => x.toFixed(3)).join("  ") : "—";
        };
        for (const w of WCS) {
            const p = Number(w.slice(2)) - 53;
            table.append(
                el(
                    "div",
                    {},
                    el("code", { textContent: w }),
                    el("span", { textContent: value(w) }),
                    btn(t("cnc.offsets.use"), () => this.send(w), style.small),
                    btn(t("cnc.offsets.clear"), () => this.send(`G10 L2 P${p} X0 Y0 Z0`, "$#"), style.small),
                ),
            );
        }
        for (const [name, set, go] of [
            ["G28", "G28.1", "G28"],
            ["G30", "G30.1", "G30"],
        ] as const)
            table.append(
                el(
                    "div",
                    {},
                    el("code", { textContent: name }),
                    el("span", { textContent: value(name) }),
                    btn(t("cnc.offsets.store"), () => this.send(set, "$#"), style.small),
                    btn(
                        t("cnc.offsets.go"),
                        () => this.send(`G0 Z${this.host.machine().heights.safeZ}`, go),
                        style.small,
                    ),
                ),
            );
        table.append(
            el(
                "div",
                {},
                el("code", { textContent: "G92" }),
                el("span", { textContent: value("G92") }),
                btn(t("cnc.offsets.clear"), () => this.send("G92.1", "$#"), style.small),
                el("span"),
            ),
            el(
                "div",
                {},
                el("code", { textContent: "TLO" }),
                el("span", { textContent: value("TLO") }),
                el("span"),
                el("span"),
            ),
        );
        rows.push(table);
        return rows;
    }

    /** `$$` to a text file and back. */
    private saveSettings() {
        const text = [...this.settings.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([id, v]) => `$${id}=${v}`)
            .join("\n");
        const a = el("a", {
            href: URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" })),
            download: "grbl-settings.txt",
        });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    private loadSettings() {
        const input = el("input", { type: "file", accept: ".txt,.nc,.gcode" });
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            const lines = (await file.text()).split(/\r?\n/).filter((l) => parseSetting(l) !== undefined);
            if (lines.length === 0) return;
            if (!confirm(t("cnc.settings.confirmLoad", lines.length))) return;
            this.send(...lines, "$$");
        };
        input.click();
    }

    private settingsTab(): HTMLElement[] {
        const rows: HTMLElement[] = [
            el(
                "div",
                { className: style.row },
                btn(t("cnc.settings.read"), () => this.send("$$"), style.primary),
                btn(t("cnc.settings.save"), () => this.saveSettings(), style.small),
                btn(t("cnc.settings.load"), () => this.loadSettings(), style.small),
                el("span", { className: style.caption, textContent: t("cnc.settings.hint") }),
            ),
        ];
        if (this.settings.size === 0) return rows;
        const known = new Set(GRBL_SETTINGS.map((s) => s.id));
        const table = el("div");
        table.className = style.settings;
        for (const group of ["axis", "motion", "limits", "spindle", "other"] as const) {
            table.append(el("h5", { textContent: t(`cnc.group.${group}`) }));
            const ids = [
                ...GRBL_SETTINGS.filter((s) => s.group === group).map((s) => s.id),
                ...(group === "other" ? [...this.settings.keys()].filter((id) => !known.has(id)) : []),
            ].filter((id) => this.settings.has(id));
            for (const id of ids) {
                const input = el("input", { type: "text" });
                input.value = this.settings.get(id)!;
                input.onchange = () => {
                    this.send(`$${id}=${input.value.trim()}`);
                    this.settings.set(id, input.value.trim());
                };
                const name = known.has(id) ? t(`cnc.set.${id}`) : "";
                table.append(
                    el(
                        "label",
                        {},
                        el("code", { textContent: `$${id}` }),
                        el("span", { textContent: name }),
                        input,
                    ),
                );
            }
        }
        rows.push(table);
        return rows;
    }
}
