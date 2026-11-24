// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PubSub } from "@chili3d/core";
import { GrblController, type GrblStatus, REALTIME } from "../laser/grblController";
import { el, t } from "../laser/laserUi";
import { WebSerialConnection } from "../laser/webSerial";
import style from "./camControl.module.css";
import type { MillMachine } from "./camGcode";
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
    /** The program to run, lines without comments. */
    programLines(): string[];
    /** The inverter when it is on and connected. */
    vfd(): VfdSpindle | undefined;
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
    private step = 1;
    private jogFeed = 1000;
    private rpm = 12000;
    private running: string[] = [];
    private acked = 0;
    private spindleAt = 0;
    private readonly log: string[] = [];
    private readonly history: string[] = [];
    private settings = new Map<number, string>();
    private probe = { thickness: 20, travel: 30, feed: 100, retract: 5 };
    private tab: "program" | "mdi" | "probe" | "settings" = "program";

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
        this.build();
        document.addEventListener("keydown", this.onKey);
        document.addEventListener("keyup", this.onKeyUp);
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
                } else if (e.type === "job") this.addLog(`— ${t(`laser.job.${e.state}`)}`);
                else if (e.type === "alarm") this.addLog(`ALARM:${e.code}`);
                else if (e.type === "error") this.addLog(`error:${e.code} ← ${e.line}`);
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
        this.stateBadge.textContent = s.state;
        this.stateBadge.style.backgroundColor = stateColor(s.state);
        AXES.forEach((a, i) => {
            const d = this.dro.get(a);
            if (!d) return;
            d.work.textContent = s.wpos ? s.wpos[i].toFixed(3) : "—";
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
        this.running = this.host.programLines();
        this.acked = 0;
        this.spindleAt = 0;
        g.startJob(this.running);
        this.showProgress();
    }

    private stopAll() {
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
        this.element.replaceChildren(header, grid);
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
        rpm.onchange = () => (this.rpm = Math.max(0, Number(rpm.value) || 0));
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
        return card(t("cnc.program"), buttons, this.progress);
    }

    private tabsCard(): HTMLElement {
        const tabs = el(
            "div",
            {},
            ...(["program", "mdi", "probe", "settings"] as const).map((k) => {
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
        else if (this.tab === "probe") this.tabBody.replaceChildren(...this.probeTab());
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
            input.onchange = () => (this.probe[key] = Number(input.value) || 0);
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

    private settingsTab(): HTMLElement[] {
        const rows: HTMLElement[] = [
            el(
                "div",
                { className: style.row },
                btn(t("cnc.settings.read"), () => this.send("$$"), style.primary),
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
