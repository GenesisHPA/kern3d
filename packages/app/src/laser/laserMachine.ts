// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PubSub } from "@chili3d/core";
import { type BoardDriverStatus, desktopUsbDriver } from "./desktopUsbDriver";
import { importMarkcfg, importMarkParam } from "./ezcadImport";
import type { Pt } from "./geometry";
import { GrblDriver } from "./grblDriver";
import { JczDriver } from "./jczDriver";
import type { DriverEvent, DriverStatus, LaserDriver, LaserProgram } from "./laserDriver";
import style from "./laserEditor.module.css";
import { button, checkbox, el, heading, numberField, row, select, t, textField } from "./laserUi";
import { FRAME_MODES, type FrameMode, LASER_CONTROLLERS, type MachineProfile } from "./machineProfile";
import { webSerialAvailable } from "./webSerial";
import { openLmcUsb, UsbOpenError, webUsbAvailable } from "./webUsb";

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

    /** The panel's own buttons, dropped from the shared lists when the panel is rebuilt. */
    private panelButtons = new Set<HTMLButtonElement>();

    private buttonLists(): HTMLButtonElement[][] {
        return [
            this.redButtons,
            this.toolpathButtons,
            this.markButtons,
            this.pauseButtons,
            this.stopButtons,
            this.idleOnly,
        ];
    }

    private build() {
        const lists = this.buttonLists();
        for (const list of lists) {
            const keep = list.filter((b) => !this.panelButtons.has(b));
            list.splice(0, list.length, ...keep);
        }
        const before = new Set(lists.flat());
        const jcz = this.host.profile.controller === "jcz";
        const parts: HTMLElement[] = [heading("laser.machine.connection")];
        parts.push(row("laser.machine.controller", this.controllerSelect()));
        if (jcz) {
            if (!webUsbAvailable()) {
                parts.push(el("div", { className: style.warning, textContent: t("laser.machine.noUsb") }));
            }
            if (desktopUsbDriver() !== undefined) {
                // the button on its own line: its label is long and the panel narrow
                parts.push(
                    row("laser.machine.jcz.driver", this.boardDriverText),
                    el("div", { className: style.buttons }, this.boardDriverButton),
                );
                void this.refreshBoardDriver();
            } else {
                parts.push(
                    el("div", { className: style.muted, textContent: t("laser.machine.jcz.driverHint") }),
                );
            }
        } else {
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
            );
        }
        parts.push(
            el("div", { className: style.buttons }, this.connectButton, this.badge),
            this.position,
            this.lastError,
        );
        if (jcz) {
            parts.push(...this.jczSection());
        } else {
            parts.push(
                el(
                    "div",
                    { className: style.buttons },
                    this.idle(
                        button(
                            "laser.machine.unlock",
                            () => this.driver?.unlock(),
                            "laser.machine.unlock.hint",
                        ),
                    ),
                    this.idle(
                        button("laser.machine.home", () => this.driver?.home(), "laser.machine.home.hint"),
                    ),
                    this.idle(button("laser.machine.reset", () => this.driver?.reset())),
                ),
            );
        }
        parts.push(...this.pointerSection(), ...this.jogSection(), ...this.jobSection());
        // the galvo board takes no typed commands
        if (!jcz) parts.push(...this.consoleSection());
        this.element.replaceChildren(...parts);
        this.panelButtons = new Set(lists.flat().filter((b) => !before.has(b)));
    }

    /** The panel again (another controller, imported settings). */
    private rebuild() {
        this.build();
        this.update();
    }

    // ---- the board's Windows driver (desktop app) -------------------------------------------

    private readonly boardDriverText = el("div", { className: style.muted });
    private readonly boardDriverButton = button(
        "laser.machine.jcz.toKern3d",
        () => void this.switchBoardDriver(),
    );
    private boardDriver: BoardDriverStatus | undefined;
    private switchingDriver = false;

    private async refreshBoardDriver() {
        const api = desktopUsbDriver();
        if (api === undefined) return;
        this.boardDriver = await api.status().catch(() => undefined);
        this.showBoardDriver();
    }

    private showBoardDriver() {
        const s = this.boardDriver;
        const b = this.boardDriverButton;
        if (this.switchingDriver) {
            this.boardDriverText.textContent = t("laser.machine.jcz.switching");
            b.disabled = true;
            return;
        }
        this.boardDriverText.textContent = t(
            s?.found ? `laser.machine.jcz.driver.${s.driver}` : "laser.machine.jcz.driver.notFound",
        );
        const toEzcad = s?.driver === "winusb";
        b.textContent = t(toEzcad ? "laser.machine.jcz.toEzcad" : "laser.machine.jcz.toKern3d");
        b.title = t(toEzcad ? "laser.machine.jcz.toEzcad.hint" : "laser.machine.jcz.toKern3d.hint");
        b.disabled = s?.found !== true || (toEzcad && s.ezcadAvailable === false);
    }

    /**
     * Switches the board's driver (Windows asks for administrator rights): to WinUSB for Kern3D,
     * or back to EzCAD's own. A connected board is let go first. True when it took.
     */
    private async switchBoardDriver(to?: "winusb" | "ezcad"): Promise<boolean> {
        const api = desktopUsbDriver();
        if (api === undefined || this.switchingDriver) return false;
        const target = to ?? (this.boardDriver?.driver === "winusb" ? "ezcad" : "winusb");
        if (this.driver?.connected) await this.disconnect();
        this.switchingDriver = true;
        this.showBoardDriver();
        let result: BoardDriverStatus | undefined;
        try {
            result = await api.install(target);
        } catch (error) {
            result = {
                found: false,
                driver: "none",
                ok: false,
                error: String((error as Error)?.message ?? error),
            };
        }
        this.switchingDriver = false;
        const ok = result.ok === true;
        if (ok) {
            this.log(
                t(target === "winusb" ? "laser.machine.jcz.nowKern3d" : "laser.machine.jcz.nowEzcad"),
                "out",
            );
            PubSub.default.pub(
                "showToast",
                target === "winusb" ? "laser.machine.jcz.nowKern3d" : "laser.machine.jcz.nowEzcad",
            );
        } else if (result.error === "cancelled") {
            this.log(t("laser.machine.jcz.switchCancelled"), "err");
        } else {
            this.log(`${t("laser.machine.jcz.switchFailed")}: ${result.error ?? result.driver}`, "err");
            PubSub.default.pub("showToast", "laser.machine.jcz.switchFailed");
        }
        await this.refreshBoardDriver();
        return ok;
    }

    /** The galvo board's field and red-pointer alignment, and the import of EzCAD's own files. */
    private jczSection(): HTMLElement[] {
        const j = this.host.profile.jcz;
        const set = (edit: (q: MachineProfile["jcz"]) => void) => this.host.setProfile((p) => edit(p.jcz));
        const file = el("input", { type: "file" });
        file.multiple = true;
        file.style.display = "none";
        file.onchange = () => {
            const files = Array.from(file.files ?? []);
            file.value = "";
            void this.importEzcad(files);
        };
        return [
            heading("laser.machine.jcz"),
            el(
                "div",
                { className: style.buttons },
                button("laser.machine.jcz.import", () => file.click(), "laser.machine.jcz.import.hint"),
                file,
            ),
            row(
                "laser.machine.jcz.field",
                numberField(j.field, (v) => set((q) => (q.field = v)), { min: 1, max: 1000 }),
            ),
            row(
                "laser.machine.jcz.offset",
                numberField(j.offsetX, (v) => set((q) => (q.offsetX = v))),
                numberField(j.offsetY, (v) => set((q) => (q.offsetY = v))),
            ),
            row(
                "laser.machine.jcz.angle",
                numberField(j.angle, (v) => set((q) => (q.angle = v))),
            ),
            row(
                "laser.machine.jcz.swapXY",
                checkbox(j.swapXY, (v) => set((q) => (q.swapXY = v))),
            ),
            row(
                "laser.machine.jcz.lightOffset",
                numberField(j.lightOffsetX, (v) => set((q) => (q.lightOffsetX = v))),
                numberField(j.lightOffsetY, (v) => set((q) => (q.lightOffsetY = v))),
            ),
        ];
    }

    /** EzCAD's `plug/markcfgN` and `PARAM/MarkParam.lib`, whichever were picked. */
    private async importEzcad(files: File[]) {
        let jcz = this.host.profile.jcz;
        const applied: string[] = [];
        for (const f of files) {
            const text = await f.text();
            const result = /\[LMC_CFG\]/i.test(text) ? importMarkcfg(text, jcz) : importMarkParam(text, jcz);
            if (result.applied.length === 0) {
                this.log(t("laser.machine.jcz.importNothing", f.name), "err");
                continue;
            }
            jcz = result.jcz;
            applied.push(...result.applied);
            if (result.correctionFile)
                this.log(t("laser.machine.jcz.correction", result.correctionFile), "err");
            if (result.notApplied.length > 0)
                this.log(t("laser.machine.jcz.notApplied", result.notApplied.join(", ")), "err");
        }
        if (applied.length === 0) return;
        this.host.setProfile((p) => (p.jcz = jcz));
        this.rebuild();
        this.log(`${t("laser.machine.jcz.imported", applied.length)}: ${applied.join(", ")}`);
        PubSub.default.pub("showToast", "laser.machine.jcz.imported", applied.length);
    }

    /** GRBL over a serial port or a JCZ (EzCAD) galvo board over USB. */
    private controllerSelect(): HTMLSelectElement {
        return select(
            LASER_CONTROLLERS.map((c) => ({ value: c, label: t(`laser.machine.controller.${c}`) })),
            this.host.profile.controller,
            (v) => void this.switchController(v),
        );
    }

    /** Another board: the connected one is let go (laser off) before its driver is dropped. */
    private async switchController(controller: MachineProfile["controller"]) {
        if (controller === this.host.profile.controller) return;
        if (this.driver?.connected) await this.disconnect();
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.driver = undefined;
        this.host.setProfile((p) => (p.controller = controller));
        this.rebuild();
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
        if (this.host.profile.controller === "jcz") return new JczDriver(() => this.host.profile, openLmcUsb);
        return new GrblDriver(() => this.host.profile);
    }

    async toggleConnection() {
        if (this.driver?.connected) {
            await this.disconnect();
            return;
        }
        if (this.host.profile.controller === "jcz" && desktopUsbDriver() !== undefined) {
            // the board on EzCAD's driver: switch it over first (Windows' rights prompt is the confirmation)
            await this.refreshBoardDriver();
            const s = this.boardDriver;
            if (s?.found && s.driver !== "winusb") {
                this.log(t("laser.machine.jcz.needsSwitch"), "out");
                if (!(await this.switchBoardDriver("winusb"))) return;
                // the board comes back on its new driver
                await new Promise((resolve) => setTimeout(resolve, 1500));
            }
        }
        const driver = this.createDriver();
        this.unsubscribe?.();
        this.unsubscribe = driver.on(this.onEvent);
        this.driver = driver;
        try {
            await driver.connect();
        } catch (error) {
            // the user closed the port chooser, or the port is busy
            if (error instanceof UsbOpenError) {
                // worded for the help it needs: no WebUSB, EzCAD's driver holds the board, or busy
                this.log(`${t(`laser.machine.usb.${error.failure}`)} (${error.message})`, "err");
                PubSub.default.pub("showToast", `laser.machine.usb.${error.failure}`);
            } else if ((error as Error)?.name !== "NotFoundError")
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
