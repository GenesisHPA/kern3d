// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.
//
// A JCZ (EzCAD) galvo board behind the driver interface. The command sequences — the board's
// initialisation, program and light modes, list streaming with wait-for-ready, execute after
// the third packet, abort — follow the MIT-licensed MeerK40t balor controller and
// galvoplotter (see THIRD_PARTY_NOTICES.md).

import { I18n } from "@chili3d/core";
import type { Pt } from "./geometry";
import type { JobState } from "./grblController";
import { GalvoMapper, jczLightHeader, jczLightRound, jczProgram } from "./jczProgram";
import type { DriverEvent, DriverStatus, LaserDriver, LaserProgram } from "./laserDriver";
import { t } from "./laserUi";
import {
    Cmd,
    type CorrectionTable,
    correctionCommands,
    decodeReply,
    encodeCommand,
    GALVO_CENTER,
    List,
    LMC_LIST_COMMANDS,
    type LmcCommand,
    packLists,
    STATUS_BUSY,
    STATUS_READY,
} from "./lmc";
import type { MachineProfile } from "./machineProfile";
import { anglePulses, type RotaryStep } from "./rotary";

/** The board's USB pipe: 12-byte commands and 0xC00-byte lists out, 8-byte replies in. */
export interface LmcTransport {
    write(bytes: Uint8Array): Promise<void>;
    read(): Promise<Uint8Array>;
    close(): Promise<void>;
    /**
     * Reads away replies left in the board from a session that ended between a command and
     * its reply; without it every reply of this session would belong to the command before.
     */
    drain?(): Promise<number>;
}

export type LmcOpener = () => Promise<LmcTransport>;

export interface JczDriverOptions {
    sleep?: (ms: number) => Promise<void>;
    /** Starts the status poll; returns its stop. */
    every?: (fn: () => void, ms: number) => () => void;
}

const POLL_MS = 250;

/** The table a stored correction holds (base64 of 65 × 65 little-endian word pairs). */
export function decodeCorrection(base64: string): CorrectionTable | undefined {
    if (base64 === "") return undefined;
    try {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        if (bytes.length !== 65 * 65 * 4) return undefined;
        const table: CorrectionTable = [];
        for (let i = 0; i < bytes.length; i += 4)
            table.push([bytes[i] | (bytes[i + 1] << 8), bytes[i + 2] | (bytes[i + 3] << 8)]);
        return table;
    } catch {
        return undefined;
    }
}

export function encodeCorrection(table: CorrectionTable): string {
    let s = "";
    for (const [dx, dy] of table) s += String.fromCharCode(dx & 0xff, dx >> 8, dy & 0xff, dy >> 8);
    return btoa(s);
}

export class JczDriver implements LaserDriver {
    readonly kind = "jcz" as const;
    readonly capabilities = { console: false, homing: false };
    private readonly listeners = new Set<(e: DriverEvent) => void>();
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly every: (fn: () => void, ms: number) => () => void;
    private transport: LmcTransport | undefined;
    private stopPoll: (() => void) | undefined;
    /** USB transfers one at a time: a reply belongs to the command before it. */
    private queue: Promise<unknown> = Promise.resolve();
    private statusWord = -1;
    private state: JobState = "none";
    private done = 0;
    private total = 0;
    private framingActive = false;
    private paused = false;
    private aborting = false;
    private portBits = 0;
    /** The loop that streams a job or the light, so a stop can wait for it to end. */
    private streaming: Promise<void> | undefined;
    serial = "";
    version = "";

    constructor(
        private readonly profile: () => MachineProfile,
        private readonly open: LmcOpener,
        options: JczDriverOptions = {},
    ) {
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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

    private log(text: string, kind: "in" | "out" | "err" = "in") {
        this.emit({ type: "log", text, kind });
    }

    get connected(): boolean {
        return this.transport !== undefined;
    }

    get status(): DriverStatus {
        if (this.transport === undefined) return { state: "offline", label: "" };
        if (this.paused) return { state: "hold", label: t("laser.jcz.state.paused") };
        if (this.statusWord >= 0 && this.statusWord & STATUS_BUSY)
            return { state: "run", label: t("laser.jcz.state.busy") };
        if (this.framingActive) return { state: "run", label: t("laser.jcz.state.light") };
        return { state: "idle", label: t("laser.jcz.state.ready") };
    }

    get jobState(): JobState {
        return this.state;
    }

    get progress() {
        return { done: this.done, total: this.total };
    }

    get framing(): boolean {
        return this.framingActive;
    }

    // ---- transfers ------------------------------------------------------------------------

    private exclusive<T>(fn: (transport: LmcTransport) => Promise<T>): Promise<T> {
        const run = this.queue.then(() => {
            const transport = this.transport;
            if (transport === undefined) throw new Error(I18n.translate("error.app.notConnected"));
            return fn(transport);
        });
        this.queue = run.catch(() => {});
        return run;
    }

    /** A single command and its reply (four words, the status last). */
    send(c: LmcCommand): Promise<[number, number, number, number]> {
        return this.exclusive(async (usb) => {
            await usb.write(encodeCommand(c));
            const reply = decodeReply(await usb.read());
            if (c[0] === Cmd.GetVersion) this.statusWord = reply[3];
            return reply;
        });
    }

    /** The console's free-form commands are GRBL's; a galvo board takes none. */
    command(_line: string): boolean {
        return false;
    }

    /** A command the board does not answer (a correction line). */
    private post(c: LmcCommand): Promise<void> {
        return this.exclusive((usb) => usb.write(encodeCommand(c)));
    }

    private async readStatus(): Promise<number> {
        const reply = await this.send([Cmd.GetVersion]);
        return reply[3];
    }

    private async waitReady() {
        while (!this.aborting && !((await this.readStatus()) & STATUS_READY)) await this.sleep(10);
    }

    private async waitIdle() {
        while (!this.aborting && (await this.readStatus()) & STATUS_BUSY) await this.sleep(10);
    }

    // ---- connection -----------------------------------------------------------------------

    async connect(): Promise<void> {
        if (this.transport !== undefined) return;
        this.transport = await this.open();
        try {
            const stale = (await this.transport.drain?.()) ?? 0;
            if (stale > 0) this.log(`USB: ${stale} stale repl${stale === 1 ? "y" : "ies"} read away`, "in");
            await this.init();
        } catch (error) {
            await this.transport?.close().catch(() => {});
            this.transport = undefined;
            throw error;
        }
        this.stopPoll = this.every(() => {
            if (this.streaming === undefined)
                void this.readStatus().then(
                    () => this.emit({ type: "status", status: this.status }),
                    () => this.lost(),
                );
        }, POLL_MS);
        this.emit({ type: "connection", connected: true });
        this.emit({ type: "status", status: this.status });
    }

    /** The board's start-up sequence of the reference's init_laser, fiber source. */
    private async init() {
        const j = this.profile().jcz;
        const serial = await this.send([Cmd.GetSerialNo]);
        this.serial = serial.map((w) => w.toString(16).padStart(4, "0")).join("");
        const version = await this.send([Cmd.GetVersion]);
        this.version = version.map((w) => w.toString(16)).join(".");
        this.log(t("laser.jcz.connected", this.serial, this.version), "out");
        await this.send([Cmd.Reset]);
        const correction = correctionCommands(decodeCorrection(j.correction));
        for (const c of correction) {
            if (c[0] === Cmd.WriteCorLine) await this.post(c);
            else await this.send(c);
        }
        const sequence: LmcCommand[] = [
            [Cmd.EnableLaser],
            [Cmd.SetControlMode, 0],
            [Cmd.SetLaserMode, 1],
            [Cmd.SetDelayMode, 1],
            [Cmd.SetTiming, 1],
            [Cmd.SetStandby, j.standby1, j.standby2],
            [Cmd.SetFirstPulseKiller, j.firstPulseKiller],
            [Cmd.SetPwmHalfPeriod, j.pwmHalfPeriod],
            [Cmd.SetPwmPulseWidth, j.pwmPulseWidth],
            [Cmd.FiberSetMo, 0],
            [Cmd.SetFpkParam2, 0xffb, 1, 409, 100],
            [0x0032, 0, 99, 1000, 25],
            [Cmd.EnableZ],
            [Cmd.WriteAnalogPort1, 0x7ff],
            [Cmd.EnableZ],
        ];
        for (const c of sequence) await this.send(c);
        this.portBits = 0;
    }

    async disconnect(): Promise<void> {
        if (this.transport === undefined) return;
        // no status poll may slip in between the last commands and the close: its reply
        // would be left in the board for the next session
        this.stopPoll?.();
        this.stopPoll = undefined;
        try {
            await this.stopping;
            if (this.framingActive || this.state === "running" || this.state === "paused") await this.abort();
            this.portBits = 0;
            await this.send([Cmd.WritePort, 0]);
        } catch {
            // the board may already be gone; let go of it anyway
        }
        await this.queue;
        await this.transport?.close().catch(() => {});
        this.lost();
    }

    private lost() {
        if (this.transport === undefined) return;
        this.stopPoll?.();
        this.stopPoll = undefined;
        this.transport = undefined;
        this.framingActive = false;
        this.paused = false;
        if (this.state === "running" || this.state === "paused") this.setJob("error");
        this.emit({ type: "connection", connected: false });
    }

    private setJob(state: JobState) {
        this.state = state;
        this.emit({ type: "job", state });
    }

    // ---- lists ----------------------------------------------------------------------------

    /**
     * Streams list packets as the reference does: each waits for the board to be ready, is
     * followed by "end of list 0", and the list starts executing after the third packet (or at
     * the end, for a short one).
     */
    private async streamLists(packets: Iterable<Uint8Array>, onSent?: (count: number) => void) {
        let count = 0;
        let executing = false;
        for (const packet of packets) {
            if (this.aborting) return;
            await this.waitReady();
            while (this.paused && !this.aborting) await this.sleep(100);
            if (this.aborting) return;
            await this.exclusive((usb) => usb.write(packet));
            await this.send([Cmd.SetEndOfList, 0]);
            count++;
            onSent?.(count);
            // a board that never reports a full buffer would otherwise keep an endless
            // light loop in microtasks: the page (and stop) would never get a turn
            await this.sleep(0);
            if (count > 2 && !executing) {
                await this.send([Cmd.ExecuteList]);
                executing = true;
            }
        }
        if (!executing && count > 0 && !this.aborting) await this.send([Cmd.ExecuteList]);
    }

    run(program: LaserProgram): boolean {
        if (this.transport === undefined || this.state === "running" || this.state === "paused") return false;
        const profile = this.profile();
        // flat: one program; rotary: one per stop of the chuck (a band, or the objects at an angle)
        const stops: (RotaryStep | undefined)[] = program.rotary?.steps.length
            ? program.rotary.steps
            : [undefined];
        const plans = stops.map((step) => ({
            step,
            job: jczProgram(program.job, profile, program.images, step),
        }));
        const warnings = new Set(plans.flatMap((p) => p.job.warnings));
        for (const w of warnings) this.log(t(w), "err");
        const start = async () => {
            await this.stopping;
            if (this.framingActive) await this.stopFramingNow();
            const lists = plans.map((p) => packLists(p.job.commands));
            const total = lists.reduce((n, l) => n + l.length, 0);
            this.total = total;
            this.done = 0;
            this.aborting = false;
            this.setJob("running");
            const j = profile.jcz;
            // the job starts where the chuck stands now
            const base = this.axisAngle;
            let sent = 0;
            for (const [index, packets] of lists.entries()) {
                if (this.aborting) return;
                const step = plans[index].step;
                if (step !== undefined) {
                    // the chuck turns with the laser off
                    await this.turnTo(base + step.angle);
                    while (this.paused && !this.aborting) await this.sleep(100);
                    if (this.aborting) return;
                }
                if (packets.length === 0) continue;
                // program mode: a fresh list, the laser enable bit, the fiber MO open
                await this.send([Cmd.ResetList]);
                this.portBits = 1 << j.laserPin;
                await this.send([Cmd.WritePort, this.portBits]);
                await this.send([Cmd.FiberSetMo, 1]);
                await this.streamLists(packets, (count) => {
                    this.done = sent + count;
                    this.emit({ type: "progress", done: this.done, total });
                });
                sent += packets.length;
                await this.waitIdle();
                if (this.aborting) return;
                await this.send([Cmd.FiberSetMo, 0]);
            }
            this.portBits = 0;
            await this.send([Cmd.WritePort, 0]);
            if (program.rotary !== undefined && j.rotary.returnToStart) await this.turnTo(base);
            await this.park();
            this.setJob("done");
        };
        this.streaming = start()
            .catch((error) => {
                this.log(String((error as Error)?.message ?? error), "err");
                if (this.state === "running" || this.state === "paused") this.setJob("error");
            })
            .finally(() => {
                this.streaming = undefined;
            });
        return true;
    }

    /** The chuck's angle from the job's start, degrees (the axis's own zero is where the job began). */
    private axisAngle = 0;
    /** The board's axis position (pulses) taken as 0° — «Ноль здесь». */
    private axisZero = 0;

    /** Turns the rotary chuck to `angle` and waits until it is there (or a timeout) and settled. */
    private async turnTo(angle: number) {
        const axis = this.profile().jcz.rotary;
        const target = this.axisZero + anglePulses(angle, axis);
        // the position as two 16-bit words, low first (to be checked on a board with a chuck)
        await this.send([Cmd.MoveAxisTo, axis.axis, target & 0xffff, (target >>> 16) & 0xffff]);
        const deadline = Date.now() + 30_000;
        while (!this.aborting && Date.now() < deadline) {
            const r = await this.send([Cmd.GetAxisPos, axis.axis]);
            const pos = (r[1] & 0xffff) | ((r[2] & 0xffff) << 16) | 0;
            if (pos === (target | 0)) break;
            await this.sleep(50);
        }
        if (Date.now() >= deadline) this.log(t("laser.rotary.timeout"), "err");
        this.axisAngle = angle;
        if (axis.settleMs > 0) await this.sleep(axis.settleMs);
    }

    async axisToZero(): Promise<void> {
        if (this.transport === undefined || this.state === "running" || this.state === "paused") return;
        this.aborting = false;
        await this.turnTo(0);
    }

    async setAxisZero(): Promise<void> {
        if (this.transport === undefined || this.state === "running" || this.state === "paused") return;
        const axis = this.profile().jcz.rotary;
        const r = await this.send([Cmd.GetAxisPos, axis.axis]);
        this.axisZero = (r[1] & 0xffff) | ((r[2] & 0xffff) << 16) | 0;
        this.axisAngle = 0;
        this.log(t("laser.rotary.zeroSet"), "out");
    }

    async turnAxis(degrees: number): Promise<void> {
        if (this.transport === undefined || this.state === "running" || this.state === "paused") return;
        this.aborting = false;
        await this.turnTo(this.axisAngle + degrees);
    }

    pause() {
        if (this.state !== "running") return;
        this.paused = true;
        this.setJob("paused");
        void this.send([Cmd.StopList]);
    }

    resume() {
        if (this.state !== "paused") return;
        void this.send([Cmd.RestartList]).then(() => {
            this.paused = false;
            this.setJob("running");
        });
    }

    /**
     * The reference's abort: stop execution, close the MO, reset the list, run an empty list
     * so the board settles, and the laser port off.
     */
    private async abort() {
        this.aborting = true;
        this.paused = false;
        await this.streaming?.catch(() => {});
        await this.send([Cmd.StopExecute]);
        await this.send([Cmd.FiberSetMo, 0]);
        await this.send([Cmd.ResetList]);
        const [empty] = packLists([[List.EndOfList]]);
        await this.exclusive((usb) => usb.write(empty));
        await this.send([Cmd.SetEndOfList, 0]);
        await this.send([Cmd.ExecuteList]);
        await this.send([Cmd.FiberSetMo, 0]);
        this.portBits = 0;
        await this.send([Cmd.WritePort, 0]);
        this.aborting = false;
        await this.park();
    }

    /**
     * The galvo back on the job's zero, light and laser off: the board otherwise leaves the
     * mirrors wherever the last list ended.
     */
    private async park() {
        const [x, y] = new GalvoMapper(this.profile()).zero();
        this.galvoX = x;
        this.galvoY = y;
        // a board still finishing the list it was stopped in ignores a jump sent meanwhile
        await this.waitIdle();
        await this.send([Cmd.GotoXY, x, y, 0, 0xffff]);
    }

    stop() {
        if (this.framingActive) {
            this.stopFraming();
            return;
        }
        const wasRunning = this.state === "running" || this.state === "paused";
        void this.abort().then(
            () => {
                if (wasRunning) this.setJob("stopped");
            },
            (error) => this.log(String((error as Error)?.message ?? error), "err"),
        );
    }

    // ---- red pointer ----------------------------------------------------------------------

    startFraming(paths: Pt[][]): boolean {
        if (this.transport === undefined || this.framingActive || this.state === "running") return false;
        const profile = this.profile();
        const round = jczLightRound(paths, profile);
        if (round.length === 0) return false;
        this.framingActive = true;
        this.aborting = false;
        this.emit({ type: "framing", active: true });
        const header = jczLightHeader(profile);
        const lights = this;
        // rounds appended one after another, packed into packets as they fill
        function* packets(): Generator<Uint8Array> {
            let pending: LmcCommand[] = [...header];
            while (lights.framingActive) {
                while (pending.length < LMC_LIST_COMMANDS) pending.push(...round);
                const [packet] = packLists(pending.slice(0, LMC_LIST_COMMANDS));
                pending = pending.slice(LMC_LIST_COMMANDS);
                yield packet;
            }
        }
        const loop = async () => {
            // a stop still settling the board (and parking it) goes first, whole
            await this.stopping;
            await this.send([Cmd.ResetList]);
            this.portBits = 1 << profile.jcz.lightPin;
            await this.streamLists(packets());
        };
        this.streaming = loop()
            .catch((error) => this.log(String((error as Error)?.message ?? error), "err"))
            .finally(() => {
                this.streaming = undefined;
            });
        return true;
    }

    private async stopFramingNow() {
        this.framingActive = false;
        await this.abort();
        this.emit({ type: "framing", active: false });
    }

    /** A stop of the light still settling the board, which a disconnect must wait for. */
    private stopping: Promise<void> | undefined;

    stopFraming() {
        if (!this.framingActive) return;
        this.stopping = this.stopFramingNow()
            .catch((error) => this.log(String((error as Error)?.message ?? error), "err"))
            .finally(() => {
                this.stopping = undefined;
            });
    }

    // ---- manual ---------------------------------------------------------------------------

    /** A galvo has no axes to jog: the pointer's position is moved instead (GotoXY), for checking a spot. */
    private galvoX = GALVO_CENTER;
    private galvoY = GALVO_CENTER;

    jog(dx: number, dy: number) {
        const k = 0xffff / this.profile().jcz.field;
        this.galvoX = Math.max(0, Math.min(0xffff, Math.round(this.galvoX + dx * k)));
        this.galvoY = Math.max(0, Math.min(0xffff, Math.round(this.galvoY + dy * k)));
        void this.send([Cmd.GotoXY, this.galvoX, this.galvoY, 0, 0xffff]);
    }

    goToOrigin() {
        void this.park().catch((error) => this.log(String((error as Error)?.message ?? error), "err"));
    }

    /** The field centre is the zero of a galvo; shifting it is the field offset in the settings. */
    setZero() {
        this.log(t("laser.jcz.noZero"), "err");
    }

    unlock() {}

    home() {}

    reset() {
        this.stop();
    }
}
