// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type Axis, jogLine, OVERRIDE } from "@chili3d/app/src/cam/machineControl";
import {
    cleanLine,
    GrblController,
    type GrblEvent,
    type GrblStatus,
    type GrblTransport,
    type JobState,
    REALTIME,
} from "@chili3d/app/src/laser/grblController";
import { estimateSeconds, type ProgramPath, programLines, programPath } from "./gcodePath";

/** A program waiting to run (or running): its text, path and rough time. */
export interface StationJob {
    id: number;
    name: string;
    /** Where it came from: a file opened here, or the network (the laptop). */
    source: "file" | "network";
    lines: string[];
    path: ProgramPath;
    estimate: number;
}

export interface StationSnapshot {
    connected: boolean;
    status: GrblStatus;
    job?: StationJob;
    jobState: JobState;
    acked: number;
    total: number;
    /** Seconds since the job started (0 when none). */
    elapsed: number;
    alarm?: number;
    lastError?: string;
    queue: readonly StationJob[];
}

/** How the station reaches the controller: USB (Web Serial) by default; a fake in tests. */
export type Connect = (
    onData: (text: string) => void,
    onClose: () => void,
) => Promise<(GrblTransport & { close(): Promise<void> }) | undefined>;

/**
 * The machine as the station sees it: one controller, one job at a time and a queue behind it.
 * No DOM here — the screen (`stationUi.ts`) reads snapshots and calls these methods.
 */
export class StationMachine {
    private grbl?: GrblController;
    private port?: GrblTransport & { close(): Promise<void> };
    private poll?: ReturnType<typeof setInterval>;
    private started = 0;
    private nextId = 1;
    private alarm?: number;
    private lastError?: string;
    private current?: StationJob;
    private readonly jobs: StationJob[] = [];
    private readonly listeners = new Set<() => void>();
    /** Feed for jogging, mm/min. */
    jogFeed = 1500;

    constructor(
        private readonly connectWith: Connect,
        private readonly now: () => number = () => Date.now(),
    ) {}

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private changed() {
        for (const l of this.listeners) l();
    }

    get connected(): boolean {
        return this.grbl !== undefined;
    }

    snapshot(): StationSnapshot {
        const progress = this.grbl?.progress ?? { acked: 0, total: 0 };
        return {
            connected: this.connected,
            status: this.grbl?.status ?? { state: "Offline" },
            job: this.current,
            jobState: this.grbl?.jobState ?? "none",
            acked: progress.acked,
            total: progress.total,
            elapsed: this.started > 0 ? (this.now() - this.started) / 1000 : 0,
            alarm: this.alarm,
            lastError: this.lastError,
            queue: this.jobs,
        };
    }

    /** Opens the controller (false when there is none to open). */
    async connect(): Promise<boolean> {
        if (this.grbl) return true;
        let controller: GrblController | undefined;
        const port = await this.connectWith(
            (text) => controller?.receive(text),
            () => this.dropped(),
        );
        if (port === undefined) return false;
        controller = new GrblController(port);
        controller.on((e) => this.onEvent(e));
        this.grbl = controller;
        this.port = port;
        this.poll = setInterval(() => void this.grbl?.realtime(REALTIME.status), 200);
        this.changed();
        return true;
    }

    async disconnect() {
        await this.port?.close();
        this.dropped();
    }

    private dropped() {
        if (this.poll) clearInterval(this.poll);
        this.poll = undefined;
        this.grbl = undefined;
        this.port = undefined;
        this.changed();
    }

    private onEvent(e: GrblEvent) {
        if (e.type === "alarm") this.alarm = e.code;
        else if (e.type === "error") this.lastError = `error:${e.code} ${e.line}`;
        else if (e.type === "welcome") this.alarm = undefined;
        else if (e.type === "job" && (e.state === "done" || e.state === "stopped" || e.state === "error"))
            this.finishJob(e.state);
        this.changed();
    }

    private finishJob(state: JobState) {
        if (state === "done" && this.current) {
            const i = this.jobs.findIndex((j) => j.id === this.current!.id);
            if (i >= 0) this.jobs.splice(i, 1);
        }
        this.started = 0;
    }

    // ---- jobs ----------------------------------------------------------------------------------

    /** A program into the queue (from a file here, or from the laptop over the network). */
    addJob(name: string, text: string, source: StationJob["source"]): StationJob {
        const lines = programLines(text);
        const job: StationJob = {
            id: this.nextId++,
            name,
            source,
            lines,
            path: programPath(lines),
            estimate: estimateSeconds(lines),
        };
        this.jobs.push(job);
        // a job that arrives is queued; it is selected only when nothing is
        if (this.current === undefined) this.current = job;
        this.changed();
        return job;
    }

    select(id: number) {
        if (this.grbl?.jobActive) return;
        this.current = this.jobs.find((j) => j.id === id) ?? this.current;
        this.changed();
    }

    remove(id: number) {
        if (this.grbl?.jobActive && this.current?.id === id) return;
        const i = this.jobs.findIndex((j) => j.id === id);
        if (i >= 0) this.jobs.splice(i, 1);
        if (this.current?.id === id) this.current = this.jobs[0];
        this.changed();
    }

    /** Runs the selected job, or resumes a paused one. Refused in alarm or without a job. */
    start(): boolean {
        const grbl = this.grbl;
        if (!grbl) return false;
        if (grbl.jobState === "paused") {
            grbl.resume();
            return true;
        }
        if (this.alarm !== undefined || grbl.status.state === "Alarm" || !this.current) return false;
        const program = this.current.lines.map(cleanLine).filter((l) => l !== "");
        if (!grbl.startJob(program)) return false;
        this.started = this.now();
        this.lastError = undefined;
        this.changed();
        return true;
    }

    pause() {
        this.grbl?.pause();
    }

    /** Stops whatever runs: the job, a jog, the spindle (a soft reset). */
    stop() {
        if (!this.grbl) return;
        if (this.grbl.jobActive) this.grbl.stop();
        else void this.grbl.realtime(REALTIME.reset);
    }

    // ---- by hand -------------------------------------------------------------------------------

    /** A jog of `step` mm on one axis; step 0 = until `jogStop` (continuous). */
    jog(axis: Axis, direction: 1 | -1, step: number): boolean {
        if (!this.grbl || this.grbl.jobActive) return false;
        const distance = step > 0 ? step : 1000;
        const line = jogLine({ [axis]: direction * distance }, this.jogFeed);
        return line !== undefined && this.grbl.send(line);
    }

    /**
     * A ready jog line from the gamepad (a stream of short jogs while a stick is held). Refused
     * while a job runs, or while earlier jogs are still queued — the stick must not run ahead.
     */
    jogLine(line: string): boolean {
        if (!this.grbl || this.grbl.jobActive || this.grbl.pending > 2) return false;
        return this.grbl.send(line, true);
    }

    jogStop() {
        void this.grbl?.realtime(REALTIME.jogCancel);
    }

    /** Work zero on one axis (or all) at the tool's position: G10 L20 P1. */
    zero(axes: readonly Axis[]): boolean {
        if (!this.grbl || this.grbl.jobActive) return false;
        return this.grbl.send(`G10 L20 P1 ${axes.map((a) => `${a}0`).join(" ")}`);
    }

    home(): boolean {
        return this.grbl?.send("$H") ?? false;
    }

    /** Clears an alarm ($X) once the cause is dealt with. */
    unlock(): boolean {
        if (!this.grbl) return false;
        this.alarm = undefined;
        this.changed();
        return this.grbl.send("$X");
    }

    override(kind: "feed" | "spindle", delta: 10 | -10 | 0) {
        const bytes =
            kind === "feed"
                ? { 10: OVERRIDE.feedPlus10, [-10]: OVERRIDE.feedMinus10, 0: OVERRIDE.feedReset }
                : { 10: OVERRIDE.spindlePlus10, [-10]: OVERRIDE.spindleMinus10, 0: OVERRIDE.spindleReset };
        void this.grbl?.realtime(bytes[delta]);
    }
}
