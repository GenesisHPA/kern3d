// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PubSub } from "@chili3d/core";
import { frameGcode } from "./gcode";
import { type Bounds, isEmpty } from "./geometry";
import {
    GRBL_ALARM_CODES,
    GRBL_ERROR_CODES,
    GrblController,
    type GrblEvent,
    type GrblStatus,
    type JobState,
    REALTIME,
} from "./grblController";
import style from "./laserEditor.module.css";
import { button, el, heading, numberField, row, select, t } from "./laserUi";
import type { MachineProfile } from "./machineProfile";
import { WebSerialConnection, webSerialAvailable } from "./webSerial";

const POLL_MS = 250;
const CONSOLE_LINES = 400;

export interface LaserMachineHost {
    readonly profile: MachineProfile;
    setProfile(edit: (p: MachineProfile) => void): void;
    /** The job's G-code, generated if it is not current; undefined when there is nothing to burn. */
    program(): Promise<{ lines: string[]; seconds: number } | undefined>;
    jobBounds(): Bounds;
}

/** GRBL 1.1's own explanation of an error number, in the user's language. */
export function grblErrorText(code: number): string {
    return (GRBL_ERROR_CODES as readonly number[]).includes(code)
        ? t(`laser.grbl.error.${code}`)
        : t("laser.grbl.error.unknown");
}

export function grblAlarmText(code: number): string {
    return (GRBL_ALARM_CODES as readonly number[]).includes(code)
        ? t(`laser.grbl.alarm.${code}`)
        : t("laser.grbl.error.unknown");
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The machine tab: a GRBL controller on a serial port (Web Serial), its state and position,
 * jogging, zero and framing, the job's start / pause / stop with progress, and a console. The
 * panel is built once and updated in place — status arrives four times a second, and a
 * rebuild would lose what is being typed into the console.
 */
export class LaserMachine {
    readonly element = el("div");
    private connection: WebSerialConnection | undefined;
    private controller: GrblController | undefined;
    private poll: ReturnType<typeof setInterval> | undefined;
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
    private readonly startButton = button("laser.machine.start", () => void this.start());
    private readonly pauseButton = button("laser.machine.pause", () => this.pauseOrResume());
    private readonly stopButton = button("laser.machine.stop", () => this.stop());
    private readonly consoleLog = el("div", { className: style.console });
    private readonly consoleInput = el("input", { type: "text" });
    /** Buttons that need a connection and no job running. */
    private readonly idleOnly: HTMLButtonElement[] = [];

    constructor(private readonly host: LaserMachineHost) {
        this.stopButton.classList.add(style.danger);
        this.build();
        this.update();
    }

    get connected(): boolean {
        return this.controller !== undefined;
    }

    // ---- building -------------------------------------------------------------------------

    private build() {
        const parts: HTMLElement[] = [heading("laser.machine.connection")];
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
                    button("laser.machine.unlock", () => this.command("$X"), "laser.machine.unlock.hint"),
                ),
                this.idle(button("laser.machine.home", () => this.command("$H"), "laser.machine.home.hint")),
                this.idle(
                    button("laser.machine.reset", () => void this.controller?.realtime(REALTIME.reset)),
                ),
            ),
            ...this.jogSection(),
            ...this.jobSection(),
            ...this.consoleSection(),
        );
        this.element.replaceChildren(...parts);
    }

    private idle(b: HTMLButtonElement): HTMLButtonElement {
        this.idleOnly.push(b);
        return b;
    }

    private jogSection(): HTMLElement[] {
        const jog = (dx: number, dy: number) => () => this.jog(dx, dy);
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
                arrow("0", () => this.command("G90 G0 X0 Y0")),
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
            row(
                "laser.machine.framePower",
                numberField(
                    this.host.profile.framePower,
                    (v) => this.host.setProfile((p) => (p.framePower = v)),
                    {
                        min: 0,
                        max: 100,
                    },
                ),
            ),
            el(
                "div",
                { className: style.buttons },
                this.idle(
                    button(
                        "laser.machine.setZero",
                        () => this.command("G10 L20 P1 X0 Y0"),
                        "laser.machine.setZero.hint",
                    ),
                ),
                this.idle(button("laser.machine.frame", () => this.frame(), "laser.machine.frame.hint")),
            ),
        ];
    }

    private jobSection(): HTMLElement[] {
        return [
            heading("laser.machine.job"),
            el("div", { className: style.buttons }, this.startButton, this.pauseButton, this.stopButton),
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
        const c = this.controller;
        const status = c?.status;
        const job = c?.jobState ?? "none";
        const active = c?.jobActive === true;
        this.connectButton.textContent = t(
            c === undefined ? "laser.machine.connect" : "laser.machine.disconnect",
        );
        this.connectButton.disabled = !webSerialAvailable();
        this.updateBadge(c === undefined ? undefined : status);
        this.position.textContent =
            status?.mpos === undefined
                ? ""
                : t(
                      "laser.machine.position",
                      fmtPos(status.wpos ?? status.mpos),
                      fmtPos(status.mpos),
                      status.feed ?? 0,
                      status.spindle ?? 0,
                  );
        for (const b of this.idleOnly) b.disabled = c === undefined || active;
        this.startButton.disabled = c === undefined || active;
        this.pauseButton.disabled = !(job === "running" || job === "paused");
        this.pauseButton.textContent = t(job === "paused" ? "laser.machine.resume" : "laser.machine.pause");
        // stop is never greyed out while there is a machine to stop
        this.stopButton.disabled = c === undefined;
        const { acked, total } = c?.progress ?? { acked: 0, total: 0 };
        const percent = total > 0 ? (100 * acked) / total : 0;
        this.progressBar.style.width = `${percent.toFixed(1)}%`;
        this.progressText.textContent =
            total > 0 ? t("laser.machine.progress", percent.toFixed(1), t(`laser.job.${job}`)) : "";
    }

    private updateBadge(status: GrblStatus | undefined) {
        const state = status?.state ?? "";
        this.badge.textContent = status === undefined ? t("laser.machine.offline") : state;
        const kind =
            state === "Idle"
                ? style.stateIdle
                : state === "Run" || state === "Jog" || state === "Home"
                  ? style.stateRun
                  : state === "Hold" || state === "Door"
                    ? style.stateHold
                    : state === "Alarm"
                      ? style.stateAlarm
                      : "";
        this.badge.className = `${style.stateBadge} ${kind}`;
    }

    private log(text: string, kind: "in" | "out" | "err" = "in") {
        const line = el("div", { textContent: text });
        if (kind === "out") line.className = style.out;
        if (kind === "err") line.className = style.err;
        this.consoleLog.append(line);
        while (this.consoleLog.childElementCount > CONSOLE_LINES) this.consoleLog.firstElementChild?.remove();
        this.consoleLog.scrollTop = this.consoleLog.scrollHeight;
    }

    private readonly onEvent = (e: GrblEvent) => {
        switch (e.type) {
            case "in":
                if (!e.text.startsWith("ok") || this.controller?.jobActive !== true) this.log(e.text);
                break;
            case "out":
                this.log(`> ${e.text}`, "out");
                break;
            case "error": {
                const text = `error:${e.code} — ${grblErrorText(e.code)}${e.line ? ` (${e.line})` : ""}`;
                this.log(text, "err");
                this.lastError.textContent = text;
                break;
            }
            case "alarm": {
                const text = `ALARM:${e.code} — ${grblAlarmText(e.code)}`;
                this.log(text, "err");
                this.lastError.textContent = text;
                PubSub.default.pub("showToast", "laser.machine.alarmToast", e.code);
                break;
            }
            case "welcome":
                this.lastError.textContent = "";
                break;
            case "job":
                this.onJobState(e.state);
                break;
        }
        this.update();
    };

    private onJobState(state: JobState) {
        if (state === "done") PubSub.default.pub("showToast", "laser.machine.done");
        if (state === "error" || state === "stopped") this.log(t(`laser.job.${state}`), "err");
    }

    // ---- actions --------------------------------------------------------------------------

    async toggleConnection() {
        if (this.controller !== undefined) {
            await this.disconnect();
            return;
        }
        try {
            const connection = await WebSerialConnection.request(
                this.host.profile.baud,
                (text) => this.controller?.receive(text),
                () => this.lost(),
            );
            this.connection = connection;
            this.controller = new GrblController(connection);
            this.controller.on(this.onEvent);
            this.poll = setInterval(() => void this.controller?.realtime(REALTIME.status), POLL_MS);
            this.log(t("laser.machine.connected"), "out");
            // wake the controller: an empty line is answered with ok, the status with a report
            void connection.write("\n");
        } catch (error) {
            // the user closed the port chooser, or the port is busy
            if ((error as Error)?.name !== "NotFoundError")
                this.log(String((error as Error)?.message ?? error), "err");
        }
        this.update();
    }

    /** Laser off before letting go: a running job is held and reset, an idle machine gets M5. */
    async disconnect() {
        const c = this.controller;
        if (c !== undefined) {
            if (c.jobActive) {
                await c.realtime(REALTIME.hold);
                await delay(300);
                await c.realtime(REALTIME.reset);
            } else {
                c.send("M5");
                await delay(100);
            }
        }
        await this.connection?.close();
        this.lost();
    }

    /** The port is gone (closed here or unplugged). */
    private lost() {
        if (this.poll !== undefined) clearInterval(this.poll);
        this.poll = undefined;
        if (this.controller !== undefined) this.log(t("laser.machine.disconnected"), "err");
        this.controller = undefined;
        this.connection = undefined;
        this.update();
    }

    private command(line: string) {
        if (this.controller?.send(line) === false) this.log(t("laser.machine.busy"), "err");
    }

    private sendTyped() {
        const text = this.consoleInput.value.trim();
        if (text === "" || this.controller === undefined) return;
        this.history.push(text);
        this.historyIndex = this.history.length;
        this.consoleInput.value = "";
        if (text === "?" || text === "!" || text === "~") void this.controller.realtime(text);
        else this.command(text);
    }

    private jog(dx: number, dy: number) {
        const s = this.jogStep;
        this.command(`$J=G91 G21 X${dx * s} Y${dy * s} F${this.jogFeed}`);
    }

    private frame() {
        const bounds = this.host.jobBounds();
        if (isEmpty(bounds)) {
            PubSub.default.pub("showToast", "toast.laser.nothingToEngrave");
            return;
        }
        for (const line of frameGcode(bounds, this.host.profile)) this.command(line);
    }

    async start() {
        const c = this.controller;
        if (c === undefined || c.jobActive) return;
        const program = await this.host.program();
        if (program === undefined) {
            PubSub.default.pub("showToast", "toast.laser.nothingToEngrave");
            return;
        }
        const minutes = Math.max(1, Math.round(program.seconds / 60));
        if (!window.confirm(t("laser.machine.confirmStart", program.lines.length, minutes))) return;
        this.lastError.textContent = "";
        c.startJob(program.lines);
        this.update();
    }

    private pauseOrResume() {
        const c = this.controller;
        if (c?.jobState === "paused") c.resume();
        else c?.pause();
        this.update();
    }

    stop() {
        this.controller?.stop();
        this.update();
    }
}

function fmtPos(p: [number, number, number]): string {
    return `X${p[0].toFixed(2)} Y${p[1].toFixed(2)}`;
}
