// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { frameEndGcode, framePassGcode, frameSetupGcode } from "./gcode";
import type { Pt } from "./geometry";
import {
    GRBL_ALARM_CODES,
    GRBL_ERROR_CODES,
    GrblController,
    type GrblEvent,
    type GrblStatus,
    type GrblTransport,
    type JobState,
    REALTIME,
} from "./grblController";
import type { DriverEvent, DriverState, DriverStatus, LaserDriver, LaserProgram } from "./laserDriver";
import { t } from "./laserUi";
import type { MachineProfile } from "./machineProfile";
import { WebSerialConnection } from "./webSerial";

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

/** An open port: the controller writes to it, the driver closes it. */
export interface GrblPort extends GrblTransport {
    close(): Promise<void>;
}

export type GrblPortOpener = (
    baud: number,
    onData: (text: string) => void,
    onClose: () => void,
) => Promise<GrblPort>;

export interface GrblDriverOptions {
    open?: GrblPortOpener;
    schedule?: (fn: () => void, ms: number) => void;
    /** Starts the status poll; returns its stop. */
    every?: (fn: () => void, ms: number) => () => void;
}

const POLL_MS = 250;

function stateOf(status: GrblStatus): DriverState {
    switch (status.state) {
        case "Idle":
            return "idle";
        case "Run":
        case "Jog":
        case "Home":
            return "run";
        case "Hold":
        case "Door":
            return "hold";
        case "Alarm":
            return "alarm";
        default:
            return "busy";
    }
}

/**
 * GRBL 1.1 behind the driver interface: a serial port (Web Serial), the character-counting
 * streamer (`GrblController`), a status poll, and the red pointer as an endless loop — one round
 * of the frame's G-code queued after another, two rounds ahead, until it is stopped with a feed
 * hold and a reset (laser off, position kept), after which the pointer's off code is sent.
 */
export class GrblDriver implements LaserDriver {
    readonly kind = "grbl" as const;
    readonly capabilities = { console: true, homing: true };
    private readonly listeners = new Set<(e: DriverEvent) => void>();
    private readonly open: GrblPortOpener;
    private readonly schedule: (fn: () => void, ms: number) => void;
    private readonly every: (fn: () => void, ms: number) => () => void;
    private port: GrblPort | undefined;
    private controller: GrblController | undefined;
    private stopPoll: (() => void) | undefined;
    private framePass: string[] = [];
    private framingActive = false;
    /** After the reset that ends a loop: the pointer's off code, then a job waiting to start. */
    private afterReset: { frameEnd: boolean; run?: LaserProgram } | undefined;

    constructor(
        private readonly profile: () => MachineProfile,
        options: GrblDriverOptions = {},
    ) {
        this.open =
            options.open ?? ((baud, onData, onClose) => WebSerialConnection.request(baud, onData, onClose));
        this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
        this.every =
            options.every ??
            ((fn, ms) => {
                const id = setInterval(fn, ms);
                return () => clearInterval(id);
            });
    }

    on(listener: (e: DriverEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(e: DriverEvent) {
        for (const listener of this.listeners) listener(e);
    }

    get connected(): boolean {
        return this.controller !== undefined;
    }

    get status(): DriverStatus {
        const s = this.controller?.status;
        if (s === undefined) return { state: "offline", label: "" };
        const pos = (p: [number, number, number] | undefined) =>
            p === undefined ? undefined : { x: p[0], y: p[1] };
        return {
            state: stateOf(s),
            label: s.sub === undefined ? s.state : `${s.state}:${s.sub}`,
            position: pos(s.wpos ?? s.mpos),
            machinePosition: pos(s.mpos),
            feed: s.feed,
            power: s.spindle,
        };
    }

    get jobState(): JobState {
        return this.controller?.jobState ?? "none";
    }

    get progress() {
        const p = this.controller?.progress ?? { acked: 0, total: 0 };
        return { done: p.acked, total: p.total };
    }

    get framing(): boolean {
        return this.framingActive;
    }

    // ---- connection -----------------------------------------------------------------------

    async connect(): Promise<void> {
        if (this.controller !== undefined) return;
        const port = await this.open(
            this.profile().baud,
            (text) => this.controller?.receive(text),
            () => this.lost(),
        );
        this.port = port;
        this.controller = new GrblController(port, { schedule: this.schedule });
        this.controller.on(this.onEvent);
        this.stopPoll = this.every(() => void this.controller?.realtime(REALTIME.status), POLL_MS);
        this.emit({ type: "connection", connected: true });
        // wake the controller: an empty line is answered with ok, the poll with a report
        void port.write("\n");
    }

    async disconnect(): Promise<void> {
        const c = this.controller;
        if (c !== undefined) {
            this.framingActive = false;
            if (c.jobActive || c.pending > 0) {
                await c.realtime(REALTIME.hold);
                await new Promise((resolve) => this.schedule(() => resolve(undefined), 300));
                await c.realtime(REALTIME.reset);
            } else {
                c.send("M5");
            }
            for (const line of frameEndGcode(this.profile()).slice(1)) c.send(line);
            await new Promise((resolve) => this.schedule(() => resolve(undefined), 100));
        }
        await this.port?.close();
        this.lost();
    }

    private lost() {
        if (this.controller === undefined) return;
        this.stopPoll?.();
        this.stopPoll = undefined;
        this.controller = undefined;
        this.port = undefined;
        this.framingActive = false;
        this.afterReset = undefined;
        this.emit({ type: "connection", connected: false });
    }

    // ---- what GRBL says -------------------------------------------------------------------

    private readonly onEvent = (e: GrblEvent) => {
        const c = this.controller;
        switch (e.type) {
            case "in":
                // a job's or a loop's stream of ok's would bury everything else
                if (e.text !== "ok" || !(c?.jobActive || this.framingActive)) this.log(e.text, "in");
                break;
            case "out":
                this.log(`> ${e.text}`, "out");
                break;
            case "status":
                this.emit({ type: "status", status: this.status });
                break;
            case "error":
                this.log(`error:${e.code} — ${grblErrorText(e.code)}${e.line ? ` (${e.line})` : ""}`, "err");
                break;
            case "alarm": {
                const text = `ALARM:${e.code} — ${grblAlarmText(e.code)}`;
                this.log(text, "err");
                this.framingActive = false;
                this.emit({ type: "framing", active: false });
                this.emit({ type: "alert", text });
                break;
            }
            case "welcome":
                this.afterResetDone();
                break;
            case "job":
                this.emit({ type: "job", state: e.state });
                break;
            case "progress":
                this.emit({ type: "progress", done: e.acked, total: e.total });
                break;
        }
        this.refill();
    };

    private log(text: string, kind: "in" | "out" | "err") {
        this.emit({ type: "log", text, kind });
    }

    // ---- red pointer ----------------------------------------------------------------------

    startFraming(paths: Pt[][]): boolean {
        const c = this.controller;
        if (c === undefined || c.jobActive || this.framingActive) return false;
        const profile = this.profile();
        this.framePass = framePassGcode(paths, profile);
        if (this.framePass.length === 0) return false;
        this.framingActive = true;
        for (const line of frameSetupGcode(profile)) c.send(line, true);
        this.refill();
        this.emit({ type: "framing", active: true });
        return true;
    }

    /** Keeps two rounds of the loop queued ahead of the head. */
    private refill() {
        const c = this.controller;
        if (!this.framingActive || c === undefined) return;
        while (c.pending < this.framePass.length * 2) {
            for (const line of this.framePass) c.send(line, true);
        }
    }

    stopFraming() {
        const c = this.controller;
        if (!this.framingActive || c === undefined) return;
        this.framingActive = false;
        this.afterReset = { ...this.afterReset, frameEnd: true };
        // hold, then reset once the head has stopped: the queued rounds are gone, the laser is off
        c.stop();
        this.emit({ type: "framing", active: false });
    }

    /** GRBL greeted after the reset that ended a loop: laser and pointer off, then a waiting job. */
    private afterResetDone() {
        const pending = this.afterReset;
        this.afterReset = undefined;
        const c = this.controller;
        if (pending === undefined || c === undefined) return;
        if (pending.frameEnd) for (const line of frameEndGcode(this.profile())) c.send(line);
        if (pending.run !== undefined) this.run(pending.run);
    }

    // ---- the job --------------------------------------------------------------------------

    run(program: LaserProgram): boolean {
        const c = this.controller;
        if (c === undefined || c.jobActive) return false;
        if (this.framingActive) {
            // the loop ends with a reset; the job starts once GRBL is back
            this.stopFraming();
            this.afterReset = { frameEnd: true, run: program };
            return true;
        }
        if (this.afterReset !== undefined) {
            this.afterReset.run = program;
            return true;
        }
        return c.startJob(program.gcode);
    }

    pause() {
        this.controller?.pause();
    }

    resume() {
        this.controller?.resume();
    }

    stop() {
        if (this.framingActive) {
            this.stopFraming();
            return;
        }
        if (this.afterReset !== undefined) this.afterReset.run = undefined;
        this.controller?.stop();
    }

    // ---- manual ---------------------------------------------------------------------------

    command(line: string): boolean {
        if (this.framingActive) return false;
        const text = line.trim();
        if (text === "?" || text === "!" || text === "~") {
            void this.controller?.realtime(text);
            return this.controller !== undefined;
        }
        return this.controller?.send(text) ?? false;
    }

    jog(dx: number, dy: number, feed: number) {
        this.command(`$J=G91 G21 X${dx} Y${dy} F${feed}`);
    }

    goToOrigin() {
        this.command("G90 G0 X0 Y0");
    }

    setZero() {
        this.command("G10 L20 P1 X0 Y0");
    }

    unlock() {
        this.command("$X");
    }

    home() {
        this.command("$H");
    }

    reset() {
        void this.controller?.realtime(REALTIME.reset);
    }
}
