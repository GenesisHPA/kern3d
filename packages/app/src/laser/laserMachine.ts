// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PubSub } from "@chili3d/core";
import type { Pt } from "./geometry";
import { GrblDriver } from "./grblDriver";
import type { DriverEvent, DriverStatus, LaserDriver, LaserProgram } from "./laserDriver";
import style from "./laserEditor.module.css";
import { button, el, heading, numberField, row, select, t, textField } from "./laserUi";
import { FRAME_MODES, type FrameMode, LASER_CONTROLLERS, type MachineProfile } from "./machineProfile";
import { webSerialAvailable } from "./webSerial";

const CONSOLE_LINES = 400;

/** What the red pointer loops along: the job's box or outline («Красный»), or its toolpath. */
export type FramingKind = "red" | "toolpath";

export interface LaserMachineHost {
    readonly profile: MachineProfile;
    setProfile(edit: (p: MachineProfile) => void): void;
    /** The job as the driver takes it, generated if it is not current; undefined when nothing burns. */
    program(): Promise<LaserProgram | undefined>;
    framePaths(mode: FrameMode | "toolpath"): Pt[][];
    /** Brings the machine tab to the front (to connect). */
    showMachinePanel(): void;
}

/** A job is confirmed once per session; after that «Маркировка» starts at once, as in EzCAD. */
let markConfirmed = false;

/**
 * The machine: the driver of the selected controller, the machine tab (connection, state,
 * pointer settings, jog, the job, a console), and the editor's top-bar controls — «Красный»
 * (F1), «Контур гравировки», «Маркировка» (F2), pause and STOP. The panel is built once and
 * updated in place: status arrives four times a second, and a rebuild would lose what is
 * being typed into the console.
 */
export class LaserMachine {
    readonly element = el("div");
    private driver: LaserDriver | undefined;
    private unsubscribe: (() => void) | undefined;
    private framingKind: FramingKind | undefined;
    private jogStep = 1;
    private jogFeed = 1000;
    private readonly history: string[] = [];
    private historyIndex = 0;

    private readonly connectButton = button("laser.machine.connect", () => void this.toggleConnection());
    private readonly badge = el("span", { className: style.stateBadge });
    private readonly position = el("div", { className: style.muted });
    private readonly lastError = el("div", { className: style.warning });
    private readonly progressBar = el("div");
    private readonly progressText = el("div", { className: style.muted });
    private readonly consoleLog = el("div", { className: style.console });
    private readonly consoleInput = el("input", { type: "text" });
    /** Every button of a kind, in the panel and the top bar alike, updated together. */
    private readonly redButtons: HTMLButtonElement[] = [];
    private readonly toolpathButtons: HTMLButtonElement[] = [];
    private readonly markButtons: HTMLButtonElement[] = [];
    private readonly pauseButtons: HTMLButtonElement[] = [];
    private readonly stopButtons: HTMLButtonElement[] = [];
    /** Buttons that need a connection and nothing running. */
    private readonly idleOnly: HTMLButtonElement[] = [];

    constructor(private readonly host: LaserMachineHost) {
        this.build();
        this.update();
    }

    get connected(): boolean {
        return this.driver?.connected === true;
    }

    // ---- building -------------------------------------------------------------------------

    private redButton(big = false) {
        const b = button("laser.machine.red", () => this.toggleFraming("red"), "laser.machine.red.hint");
        if (big) b.classList.add(style.big);
        this.redButtons.push(b);
        return b;
    }

    private toolpathButton(big = false) {
        const b = button(
            "laser.machine.toolpath",
            () => this.toggleFraming("toolpath"),
            "laser.machine.toolpath.hint",
        );
        if (big) b.classList.add(style.big);
        this.toolpathButtons.push(b);
        return b;
    }

    private markButton(big = false) {
        const b = button("laser.machine.mark", () => void this.mark(), "laser.machine.mark.hint");
        if (big) b.classList.add(style.big, style.mark);
        this.markButtons.push(b);
        return b;
    }

    private pauseButton() {
        const b = button("laser.machine.pause", () => this.pauseOrResume());
        this.pauseButtons.push(b);
        return b;
    }

    private stopButton() {
        const b = button("laser.machine.stop", () => this.stop());
        b.classList.add(style.danger);
        this.stopButtons.push(b);
        return b;
    }

    /** The big controls for the editor's top bar, visible whichever side tab is open. */
    toolbarControls(): HTMLElement[] {
        const controls = [
            this.redButton(true),
            this.toolpathButton(true),
            this.markButton(true),
            this.pauseButton(),
            this.stopButton(),
        ];
        this.update();
        return controls;
    }

    private build() {
        const parts: HTMLElement[] = [heading("laser.machine.connection")];
        parts.push(row("laser.machine.controller", this.controllerSelect()));
        if (!webSerialAvailable()) {
            parts.push(el("div", { className: style.warning, textContent: t("laser.machine.noSerial") }));
        }
        parts.push(
            row(
                "laser.machine.baud",
                select(
                    [9600, 57600, 115200, 230400, 250000].map((b) => ({
                        value: String(b),
                        label: String(b),
                    })),
                    String(this.host.profile.baud),
                    (v) => this.host.setProfile((p) => (p.baud = Number(v))),
                ),
            ),
            el("div", { className: style.buttons }, this.connectButton, this.badge),
            this.position,
            this.lastError,
            el(
                "div",
                { className: style.buttons },
                this.idle(
                    button("laser.machine.unlock", () => this.driver?.unlock(), "laser.machine.unlock.hint"),
                ),
                this.idle(button("laser.machine.home", () => this.driver?.home(), "laser.machine.home.hint")),
                this.idle(button("laser.machine.reset", () => this.driver?.reset())),
            ),
            ...this.pointerSection(),
            ...this.jogSection(),
            ...this.jobSection(),
            ...this.consoleSection(),
        );
        this.element.replaceChildren(...parts);
    }

    /** GRBL works; the JCZ (EzCAD) board is listed, not yet selectable. */
    private controllerSelect(): HTMLSelectElement {
        const s = select(
            LASER_CONTROLLERS.map((c) => ({ value: c, label: t(`laser.machine.controller.${c}`) })),
            this.host.profile.controller === "jcz" ? "grbl" : this.host.profile.controller,
            (v) => this.host.setProfile((p) => (p.controller = v)),
        );
        for (const option of s.options) option.disabled = option.value === "jcz";
        return s;
    }

    private idle(b: HTMLButtonElement): HTMLButtonElement {
        this.idleOnly.push(b);
        return b;
    }

    private pointerSection(): HTMLElement[] {
        const p = this.host.profile;
        const set = (edit: (q: MachineProfile) => void) => this.host.setProfile(edit);
        return [
            heading("laser.machine.pointer"),
            el("div", { className: style.buttons }, this.redButton(), this.toolpathButton()),
            row(
                "laser.machine.frameMode",
                select(
                    FRAME_MODES.map((m) => ({ value: m, label: t(`laser.machine.frameMode.${m}`) })),
                    p.frameMode,
                    (v) => set((q) => (q.frameMode = v)),
                ),
            ),
            row(
                "laser.machine.framePower",
                numberField(p.framePower, (v) => set((q) => (q.framePower = v)), { min: 0, max: 100 }),
            ),
            row(
                "laser.machine.frameSpeed",
                numberField(p.frameSpeed, (v) => set((q) => (q.frameSpeed = v)), { min: 1 }),
            ),
            row(
                "laser.machine.pointerOn",
                textField(p.pointerOn, (v) => set((q) => (q.pointerOn = v.trim()))),
            ),
            row(
                "laser.machine.pointerOff",
                textField(p.pointerOff, (v) => set((q) => (q.pointerOff = v.trim()))),
            ),
        ];
    }

    private jogSection(): HTMLElement[] {
        const jog = (dx: number, dy: number) => () =>
            this.driver?.jog(dx * this.jogStep, dy * this.jogStep, this.jogFeed);
        const arrow = (text: string, action: () => void) =>
            this.idle(el("button", { textContent: text, onclick: action }));
        const blank = () => el("div");
        return [
            heading("laser.machine.jog"),
            el(
                "div",
                { className: style.jog },
                blank(),
                arrow("Y+", jog(0, 1)),
                blank(),
                arrow("X−", jog(-1, 0)),
                arrow("0", () => this.driver?.goToOrigin()),
                arrow("X+", jog(1, 0)),
                blank(),
                arrow("Y−", jog(0, -1)),
                blank(),
            ),
            row(
                "laser.machine.jogStep",
                select(
                    ["0.1", "1", "10", "50"].map((v) => ({ value: v, label: v })),
                    String(this.jogStep),
                    (v) => (this.jogStep = Number(v)),
                ),
            ),
            row(
                "laser.machine.jogFeed",
                numberField(this.jogFeed, (v) => (this.jogFeed = v), { min: 1 }),
            ),
            el(
                "div",
                { className: style.buttons },
                this.idle(
                    button(
                        "laser.machine.setZero",
                        () => this.driver?.setZero(),
                        "laser.machine.setZero.hint",
                    ),
                ),
            ),
        ];
    }

    private jobSection(): HTMLElement[] {
        return [
            heading("laser.machine.job"),
            el("div", { className: style.buttons }, this.markButton(), this.pauseButton(), this.stopButton()),
            el("div", { className: style.progress }, this.progressBar),
            this.progressText,
        ];
    }

    private consoleSection(): HTMLElement[] {
        this.consoleInput.placeholder = t("laser.machine.console.placeholder");
        this.consoleInput.onkeydown = (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                this.sendTyped();
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                if (this.history.length === 0) return;
                const step = e.key === "ArrowUp" ? -1 : 1;
                this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + step));
                this.consoleInput.value = this.history[this.historyIndex] ?? "";
            }
        };
        return [
            heading("laser.machine.console"),
            this.consoleLog,
            el(
                "div",
                { className: style.row },
                this.consoleInput,
                button("laser.machine.send", () => this.sendTyped()),
            ),
        ];
    }

    // ---- state shown ----------------------------------------------------------------------

    private update() {
        const d = this.driver;
        const connected = d?.connected === true;
        const job = d?.jobState ?? "none";
        const running = job === "running" || job === "paused" || job === "stopping";
        const framing = d?.framing === true;
        this.connectButton.textContent = t(connected ? "laser.machine.disconnect" : "laser.machine.connect");
        this.connectButton.disabled = !webSerialAvailable();
        this.updateBadge(connected ? d?.status : undefined);
        const status = d?.status;
        this.position.textContent =
            status?.position === undefined
                ? ""
                : t(
                      "laser.machine.position",
                      fmtPos(status.position),
                      fmtPos(status.machinePosition ?? status.position),
                      status.feed ?? 0,
                      status.power ?? 0,
                  );
        for (const b of this.idleOnly) b.disabled = !connected || running || framing;
        for (const b of this.redButtons) {
            b.disabled = running;
            b.classList.toggle(style.active, framing && this.framingKind === "red");
        }
        for (const b of this.toolpathButtons) {
            b.disabled = running;
            b.classList.toggle(style.active, framing && this.framingKind === "toolpath");
        }
        for (const b of this.markButtons) b.disabled = running;
        for (const b of this.pauseButtons) {
            b.disabled = !(job === "running" || job === "paused");
            b.textContent = t(job === "paused" ? "laser.machine.resume" : "laser.machine.pause");
        }
        // stop is never greyed out while there is a machine to stop
        for (const b of this.stopButtons) b.disabled = !connected;
        const { done, total } = d?.progress ?? { done: 0, total: 0 };
        const percent = total > 0 ? (100 * done) / total : 0;
        this.progressBar.style.width = `${percent.toFixed(1)}%`;
        this.progressText.textContent =
            total > 0 ? t("laser.machine.progress", percent.toFixed(1), t(`laser.job.${job}`)) : "";
    }

    private updateBadge(status: DriverStatus | undefined) {
        this.badge.textContent = status === undefined ? t("laser.machine.offline") : status.label;
        const kinds: Record<string, string> = {
            idle: style.stateIdle,
            run: style.stateRun,
            hold: style.stateHold,
            alarm: style.stateAlarm,
        };
        this.badge.className = `${style.stateBadge} ${kinds[status?.state ?? ""] ?? ""}`;
    }

    private log(text: string, kind: "in" | "out" | "err" = "in") {
        const line = el("div", { textContent: text });
        if (kind === "out") line.className = style.out;
        if (kind === "err") line.className = style.err;
        this.consoleLog.append(line);
        while (this.consoleLog.childElementCount > CONSOLE_LINES) this.consoleLog.firstElementChild?.remove();
        this.consoleLog.scrollTop = this.consoleLog.scrollHeight;
        if (kind === "err") this.lastError.textContent = text;
    }

    private readonly onEvent = (e: DriverEvent) => {
        switch (e.type) {
            case "log":
                this.log(e.text, e.kind);
                break;
            case "alert":
                PubSub.default.pub("showToast", "laser.machine.alertToast", e.text);
                break;
            case "connection":
                this.log(
                    t(e.connected ? "laser.machine.connected" : "laser.machine.disconnected"),
                    e.connected ? "out" : "err",
                );
                if (!e.connected) this.framingKind = undefined;
                break;
            case "framing":
                if (!e.active) this.framingKind = undefined;
                break;
            case "job":
                if (e.state === "running") this.lastError.textContent = "";
                if (e.state === "done") PubSub.default.pub("showToast", "laser.machine.done");
                if (e.state === "error" || e.state === "stopped") this.log(t(`laser.job.${e.state}`), "err");
                break;
        }
        this.update();
    };

    // ---- actions --------------------------------------------------------------------------

    private createDriver(): LaserDriver {
        // only GRBL is wired up; the JCZ board gets its driver behind the same interface
        return new GrblDriver(() => this.host.profile);
    }

    async toggleConnection() {
        if (this.driver?.connected) {
            await this.disconnect();
            return;
        }
        const driver = this.createDriver();
        this.unsubscribe?.();
        this.unsubscribe = driver.on(this.onEvent);
        this.driver = driver;
        try {
            await driver.connect();
        } catch (error) {
            // the user closed the port chooser, or the port is busy
            if ((error as Error)?.name !== "NotFoundError")
                this.log(String((error as Error)?.message ?? error), "err");
        }
        this.update();
    }

    /** Laser off before letting go. */
    async disconnect() {
        await this.driver?.disconnect();
        this.update();
    }

    /** Nothing to do without a machine: say so and show where to connect. */
    private requireConnection(): LaserDriver | undefined {
        if (this.driver?.connected) return this.driver;
        PubSub.default.pub("showToast", "laser.machine.connectFirst");
        this.host.showMachinePanel();
        return undefined;
    }

    get framing(): boolean {
        return this.driver?.framing === true;
    }

    /** «Красный» / «Контур гравировки»: starts the loop, or stops it when it runs. */
    toggleFraming(kind: FramingKind) {
        const d = this.requireConnection();
        if (d === undefined) return;
        if (d.framing) {
            const same = this.framingKind === kind;
            this.stopFraming();
            if (same) return;
        }
        const paths = this.host.framePaths(kind === "red" ? this.host.profile.frameMode : "toolpath");
        if (paths.length === 0) {
            PubSub.default.pub("showToast", "toast.laser.nothingToEngrave");
            return;
        }
        if (d.startFraming(paths)) this.framingKind = kind;
        this.update();
    }

    stopFraming() {
        this.driver?.stopFraming();
        this.framingKind = undefined;
        this.update();
    }

    /** «Маркировка»: the job on the machine, confirmed once per session. */
    async mark() {
        const d = this.requireConnection();
        if (d === undefined || d.jobState === "running" || d.jobState === "paused") return;
        const program = await this.host.program();
        if (program === undefined) {
            PubSub.default.pub("showToast", "toast.laser.nothingToEngrave");
            return;
        }
        if (!markConfirmed) {
            const minutes = Math.max(1, Math.round(program.seconds / 60));
            if (!window.confirm(t("laser.machine.confirmStart", program.gcode.length, minutes))) return;
            markConfirmed = true;
        }
        this.lastError.textContent = "";
        d.run(program);
        this.update();
    }

    private pauseOrResume() {
        const d = this.driver;
        if (d?.jobState === "paused") d.resume();
        else d?.pause();
        this.update();
    }

    stop() {
        this.driver?.stop();
        this.framingKind = undefined;
        this.update();
    }

    private sendTyped() {
        const text = this.consoleInput.value.trim();
        if (text === "" || this.driver === undefined) return;
        this.history.push(text);
        this.historyIndex = this.history.length;
        this.consoleInput.value = "";
        if (!this.driver.command(text)) this.log(t("laser.machine.busy"), "err");
    }
}

function fmtPos(p: Pt): string {
    return `X${p.x.toFixed(2)} Y${p.y.toFixed(2)}`;
}
