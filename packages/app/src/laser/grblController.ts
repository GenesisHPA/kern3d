// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Talking to a GRBL 1.1 controller over a byte stream, after its published interface: lines are
 * streamed with the character-counting protocol (never more unacknowledged bytes in flight than
 * GRBL's 128-byte receive buffer holds, each `ok`/`error:N` freeing its line), realtime bytes
 * (`?` `!` `~` 0x18 0x85) go straight out, and the replies — `ok`, `error:N`, `ALARM:N`,
 * `<status|…>`, the `Grbl 1.1x` greeting after a reset — drive the state. No DOM: the serial
 * port is behind `GrblTransport`, the clock behind `schedule`, so tests run it on a fake port.
 */

export interface GrblTransport {
    write(data: string): Promise<void>;
}

export interface GrblStatus {
    /** Idle, Run, Hold, Jog, Alarm, Door, Check, Home, Sleep. */
    state: string;
    /** Hold:0 = held, Hold:1 = still slowing down; Door:n likewise. */
    sub?: number;
    mpos?: [number, number, number];
    wpos?: [number, number, number];
    feed?: number;
    spindle?: number;
    /** Planner blocks and receive-buffer bytes free (`Bf:`), when reported. */
    bufferBlocks?: number;
    bufferBytes?: number;
}

export type JobState = "none" | "running" | "paused" | "stopping" | "done" | "stopped" | "error";

export type GrblEvent =
    | { type: "out"; text: string }
    | { type: "in"; text: string }
    | { type: "status"; status: GrblStatus }
    | { type: "job"; state: JobState }
    | { type: "progress"; acked: number; total: number }
    | { type: "error"; code: number; line: string }
    | { type: "alarm"; code: number }
    | { type: "welcome"; version: string };

export const GRBL_RX_BUFFER = 128;

export const REALTIME = {
    status: "?",
    hold: "!",
    resume: "~",
    reset: "\x18",
    jogCancel: "\x85",
} as const;

/** A `<…>` status report; the work coordinate offset (`WCO`) carried from earlier reports fills the other position. */
export function parseStatus(line: string, lastWco?: [number, number, number]): GrblStatus | undefined {
    const m = /^<([^>]*)>$/.exec(line.trim());
    if (m === null) return undefined;
    const [head, ...fields] = m[1].split("|");
    const [state, sub] = head.split(":");
    const status: GrblStatus = { state };
    if (sub !== undefined && sub !== "") status.sub = Number(sub);
    let wco = lastWco;
    const triple = (text: string) => {
        const v = text.split(",").map(Number);
        return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0] as [number, number, number];
    };
    for (const field of fields) {
        const colon = field.indexOf(":");
        if (colon < 0) continue;
        const key = field.slice(0, colon);
        const value = field.slice(colon + 1);
        if (key === "MPos") status.mpos = triple(value);
        else if (key === "WPos") status.wpos = triple(value);
        else if (key === "WCO") wco = triple(value);
        else if (key === "FS" || key === "F") {
            const [feed, spindle] = value.split(",").map(Number);
            status.feed = feed;
            if (spindle !== undefined) status.spindle = spindle;
        } else if (key === "Bf") {
            const [blocks, bytes] = value.split(",").map(Number);
            status.bufferBlocks = blocks;
            status.bufferBytes = bytes;
        }
    }
    if (wco !== undefined) {
        if (status.mpos !== undefined && status.wpos === undefined)
            status.wpos = status.mpos.map((v, i) => v - wco![i]) as [number, number, number];
        if (status.wpos !== undefined && status.mpos === undefined)
            status.mpos = status.wpos.map((v, i) => v + wco![i]) as [number, number, number];
    }
    return status;
}

/** A program line as sent: comments and blanks gone, spaces squeezed out (they cost buffer bytes). */
export function cleanLine(line: string): string {
    return line
        .replace(/\([^)]*\)/g, "")
        .replace(/;.*$/, "")
        .replace(/\s+/g, "")
        .trim();
}

interface Pending {
    text: string;
    job: boolean;
    /** Not echoed to the console (a framing loop's lines). */
    quiet?: boolean;
}

export interface GrblControllerOptions {
    rxBuffer?: number;
    /** A timer, injectable for tests; defaults to `setTimeout`. */
    schedule?: (fn: () => void, ms: number) => void;
    /** How long a stop waits for the feed hold to settle before resetting, ms. */
    stopTimeout?: number;
}

export class GrblController {
    private readonly rxBuffer: number;
    private readonly schedule: (fn: () => void, ms: number) => void;
    private readonly stopTimeout: number;
    private readonly listeners = new Set<(e: GrblEvent) => void>();
    private readonly queue: Pending[] = [];
    private readonly inflight: Pending[] = [];
    private used = 0;
    private incoming = "";
    private writes: Promise<void> = Promise.resolve();
    private wco: [number, number, number] | undefined;
    private resetPending = false;
    private total = 0;
    private acked = 0;
    status: GrblStatus = { state: "Unknown" };
    jobState: JobState = "none";

    constructor(
        private readonly transport: GrblTransport,
        options: GrblControllerOptions = {},
    ) {
        this.rxBuffer = options.rxBuffer ?? GRBL_RX_BUFFER;
        this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
        this.stopTimeout = options.stopTimeout ?? 1500;
    }

    on(listener: (e: GrblEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(e: GrblEvent) {
        for (const listener of this.listeners) listener(e);
    }

    get jobActive(): boolean {
        return this.jobState === "running" || this.jobState === "paused" || this.jobState === "stopping";
    }

    /** Bytes GRBL holds that it has not answered. */
    /** Lines sent or waiting that GRBL has not answered yet. */
    get pending(): number {
        return this.queue.length + this.inflight.length;
    }

    get bufferUsed(): number {
        return this.used;
    }

    get progress(): { acked: number; total: number } {
        return { acked: this.acked, total: this.total };
    }

    // ---- sending ------------------------------------------------------------------------------

    private write(data: string): Promise<void> {
        this.writes = this.writes.then(() => this.transport.write(data)).catch(() => {});
        return this.writes;
    }

    /** A realtime byte: not counted, not queued, not answered with `ok`. */
    realtime(byte: string): Promise<void> {
        if (byte !== REALTIME.status) this.emit({ type: "out", text: describeRealtime(byte) });
        return this.write(byte);
    }

    /** A command typed by the user or sent by a button; refused (false) while a job runs. */
    send(line: string, quiet = false): boolean {
        if (this.jobActive) return false;
        const text = line.trim();
        if (text === "") return false;
        this.queue.push({ text, job: false, quiet });
        this.pump();
        return true;
    }

    /** Fills GRBL's receive buffer as far as the next line fits. */
    private pump() {
        while (this.queue.length > 0 && this.jobState !== "paused") {
            const next = this.queue[0];
            const size = next.text.length + 1;
            // a line longer than the whole buffer goes alone once the buffer is empty
            if (this.used + size > this.rxBuffer && this.inflight.length > 0) break;
            this.queue.shift();
            this.inflight.push(next);
            this.used += size;
            if (!next.job && !next.quiet) this.emit({ type: "out", text: next.text });
            void this.write(`${next.text}\n`);
        }
    }

    // ---- the job ------------------------------------------------------------------------------

    startJob(program: readonly string[]): boolean {
        if (this.jobActive) return false;
        const lines = program.map(cleanLine).filter((l) => l !== "");
        if (lines.length === 0) return false;
        this.total = lines.length;
        this.acked = 0;
        for (const text of lines) this.queue.push({ text, job: true });
        this.setJob("running");
        this.emit({ type: "progress", acked: 0, total: this.total });
        this.pump();
        return true;
    }

    /** Feed hold: the head slows to a stop on the path; `resume` carries on. */
    pause() {
        if (this.jobState !== "running") return;
        this.setJob("paused");
        void this.realtime(REALTIME.hold);
    }

    resume() {
        if (this.jobState !== "paused") return;
        this.setJob("running");
        void this.realtime(REALTIME.resume);
        this.pump();
    }

    /**
     * Stops at once and for good: the rest of the job is dropped, a feed hold brings the head to
     * rest (so position is kept), then a soft reset clears GRBL's buffers and turns the laser off.
     */
    stop() {
        this.queue.length = 0;
        if (!this.jobActive) {
            void this.realtime(REALTIME.hold);
            this.resetPending = true;
            this.schedule(() => this.resetNow(), 200);
            return;
        }
        this.setJob("stopping");
        this.resetPending = true;
        void this.realtime(REALTIME.hold);
        this.schedule(() => this.resetNow(), this.stopTimeout);
    }

    private resetNow() {
        if (!this.resetPending) return;
        this.resetPending = false;
        void this.realtime(REALTIME.reset);
        this.flush();
        if (this.jobState === "stopping") this.setJob("stopped");
    }

    /** GRBL forgot every line it held (reset or alarm): nothing is in flight any more. */
    private flush() {
        this.queue.length = 0;
        this.inflight.length = 0;
        this.used = 0;
    }

    private setJob(state: JobState) {
        if (this.jobState === state) return;
        this.jobState = state;
        this.emit({ type: "job", state });
    }

    private abortJob(state: "error" | "stopped") {
        for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i].job) this.queue.splice(i, 1);
        this.setJob(state);
    }

    private checkDone() {
        if (this.jobState !== "running") return;
        if (this.queue.some((p) => p.job) || this.inflight.some((p) => p.job)) return;
        this.setJob("done");
    }

    // ---- receiving ----------------------------------------------------------------------------

    /** Bytes from the port, in whatever pieces they arrive. */
    receive(chunk: string) {
        this.incoming += chunk;
        let nl = this.incoming.search(/\r?\n/);
        while (nl >= 0) {
            const line = this.incoming.slice(0, nl).trim();
            this.incoming = this.incoming.slice(this.incoming[nl] === "\r" ? nl + 2 : nl + 1);
            if (line !== "") this.handleLine(line);
            nl = this.incoming.search(/\r?\n/);
        }
    }

    private handleLine(line: string) {
        if (line.startsWith("<")) {
            this.handleStatus(line);
            return;
        }
        this.emit({ type: "in", text: line });
        if (line === "ok") this.acknowledge();
        else if (line.startsWith("error:")) this.handleError(Number(line.slice(6)));
        else if (line.startsWith("ALARM:")) this.handleAlarm(Number(line.slice(6)));
        else if (/^Grbl\s/i.test(line)) this.handleWelcome(line);
    }

    private handleStatus(line: string) {
        const status = parseStatus(line, this.wco);
        if (status === undefined) return;
        const wco = /WCO:([^|>]*)/.exec(line);
        if (wco !== null) this.wco = wco[1].split(",").map(Number) as [number, number, number];
        this.status = status;
        this.emit({ type: "status", status });
        // the hold has settled: safe to reset without losing position
        const settled = (status.state === "Hold" && status.sub === 0) || status.state === "Idle";
        if (this.resetPending && settled) this.resetNow();
    }

    private acknowledge(): Pending | undefined {
        const done = this.inflight.shift();
        if (done === undefined) return undefined;
        this.used -= done.text.length + 1;
        if (done.job) {
            this.acked++;
            this.emit({ type: "progress", acked: this.acked, total: this.total });
        }
        this.pump();
        this.checkDone();
        return done;
    }

    /** A rejected line stops the job: what follows may depend on it. The laser is switched off. */
    private handleError(code: number) {
        const failed = this.inflight[0];
        this.emit({ type: "error", code, line: failed?.text ?? "" });
        const wasJob = failed?.job === true && this.jobActive;
        if (wasJob) this.abortJob("error");
        this.acknowledge();
        if (wasJob) {
            this.queue.push({ text: "M5", job: false });
            this.pump();
        }
    }

    private handleAlarm(code: number) {
        this.emit({ type: "alarm", code });
        this.status = { ...this.status, state: "Alarm" };
        this.flush();
        if (this.jobActive) this.setJob("error");
    }

    private handleWelcome(line: string) {
        this.flush();
        this.resetPending = false;
        if (this.jobActive) this.setJob(this.jobState === "stopping" ? "stopped" : "error");
        this.emit({ type: "welcome", version: line });
    }
}

function describeRealtime(byte: string): string {
    switch (byte) {
        case REALTIME.hold:
            return "!";
        case REALTIME.resume:
            return "~";
        case REALTIME.reset:
            return "[Ctrl-X]";
        case REALTIME.jogCancel:
            return "[jog cancel]";
        default:
            return byte;
    }
}

/** GRBL 1.1's error and alarm numbers that have a description. */
export const GRBL_ERROR_CODES = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
    32, 33, 34, 35, 36, 37, 38,
] as const;
export const GRBL_ALARM_CODES = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
