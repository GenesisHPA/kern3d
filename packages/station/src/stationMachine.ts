// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    applyOffsetLines,
    type Corner,
    defaultProbeSettings,
    lengthOffset,
    measureTool,
    type ProbeIO,
    type ProbeSettings,
    parsePrb,
    probeBoss,
    probeCorner,
    probeHole,
    probeTop,
    toChangeLines,
    type Vec3,
} from "@chili3d/app/src/cam/camProbe";
import { runFromLine } from "@chili3d/app/src/cam/camRun";
import { type Axis, jogLine, OVERRIDE, probeLines } from "@chili3d/app/src/cam/machineControl";
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
import {
    type MachineSettings,
    machineSettings,
    overrunText,
    readSetting,
    travelOverruns,
} from "./machineMap";
import { jobProgram, type PlannedChange, resumeLine, type ToolRef } from "./toolJob";

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

/**
 * A tool change under way. Planned: the program asks for the next tool. Emergency: the cutter
 * broke or went blunt mid-job — the job is stopped where it is, the cutter changed and measured
 * on the length sensor, and the job carries on from that place.
 */
export interface ToolChange {
    kind: "planned" | "emergency";
    tool?: number;
    name?: string;
    /** reference: the tool measured before the job; zero: no sensor — Z to be zeroed by hand. */
    stage: "reference" | "moving" | "waiting" | "measuring" | "zero" | "failed";
    error?: string;
    /** Where the machine went for the change: home by the limit switches, or the change place. */
    at?: "home" | "place";
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
    /** Program line (0-based) up to which the job is done; −1 before it starts. */
    doneLine: number;
    /** The tool changes the selected job asks for, and its tools in order. */
    toolChanges: number;
    jobTools: ToolRef[];
    /** The tool in the spindle, as far as the station knows (from the programs it ran). */
    tool?: ToolRef;
    /** The controller's welcome line («Grbl 1.1h …», «Grbl 3.7 [FluidNC …]»). */
    firmware?: string;
    /** What the controller says about the machine ($$), and whether it has found its zero since. */
    machine: MachineSettings;
    homed: boolean;
    change?: ToolChange;
    /** The tool length offset applied now (G43.1), mm; the reference tool's machine Z on the sensor. */
    offset: number;
    reference?: number;
}

/** A job running: its code lines (see `jobProgram`) and the part of them GRBL has now. */
interface Run {
    job: StationJob;
    code: string[];
    src: number[];
    changes: PlannedChange[];
    /** This send: code lines from..end; for each line sent, the code line it stands for. */
    from: number;
    end: number;
    sentCode: number[];
}

/** Probing and moves over the controller, one batch at a time, waiting for every ok. */
class StationProbeIO implements ProbeIO {
    constructor(private readonly grbl: GrblController) {}

    /** Until every line sent before is answered: an ok counted here must be for a line of ours. */
    private async drained(): Promise<void> {
        for (let i = 0; i < 200 && this.grbl.pending > 0; i++) await new Promise((r) => setTimeout(r, 25));
    }

    private async run(lines: string[]): Promise<Vec3[]> {
        await this.drained();
        return new Promise((resolve, reject) => {
            let left = lines.length;
            const touches: Vec3[] = [];
            if (left === 0) {
                resolve(touches);
                return;
            }
            const done = (error?: Error) => {
                off();
                clearTimeout(timer);
                if (error) reject(error);
                else resolve(touches);
            };
            const timer = setTimeout(() => done(new Error("Контроллер не ответил вовремя")), 180000);
            const off = this.grbl.on((e) => {
                if (e.type === "in") {
                    const prb = parsePrb(e.text);
                    if (prb) {
                        if (!prb.ok) done(new Error("Датчик не сработал — фреза не дошла до него"));
                        else touches.push(prb.pos);
                    } else if (e.text === "ok" && --left === 0) done();
                    else if (e.text.startsWith("error:")) done(new Error(`Контроллер: ${e.text}`));
                } else if (e.type === "alarm") {
                    done(
                        new Error(
                            e.code === 4 || e.code === 5
                                ? "Датчик не сработал — фреза не дошла до него"
                                : `Тревога ${e.code}`,
                        ),
                    );
                }
            });
            for (const l of lines) {
                if (!this.grbl.send(l, true)) {
                    done(new Error("Станок занят"));
                    return;
                }
            }
        });
    }

    async send(lines: string[]): Promise<void> {
        await this.run(lines);
    }

    async probe(line: string): Promise<Vec3> {
        const [p] = await this.run([line]);
        if (p === undefined) throw new Error("Датчик не сработал");
        return p;
    }
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
    private run?: Run;
    private change?: ToolChange;
    private changeWait?: { resolve: () => void; reject: (e: Error) => void };
    /** Feed for jogging, mm/min. */
    jogFeed = 1500;
    /** The length sensor, the change place, safe heights (⚙ → Инструмент). */
    probe: ProbeSettings = defaultProbeSettings();
    /** Machine Z the tool the work Z zero was set with touched the sensor at. */
    reference?: number;
    /** The tool length offset applied now, mm (G43.1); put back after a reset. */
    offset = 0;
    /** The tool in the spindle: the program's first at its start, each change's after it. */
    tool?: ToolRef;
    private firmware?: string;
    private readonly settings = new Map<number, number>();
    /** The machine has found its zero by the limit switches since it was switched on (or unlocked). */
    private homed = false;
    private sawHoming = false;
    private checkLock = false;

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
        const run = this.run;
        let doneCode = -1;
        if (run) {
            const a = progress.acked;
            doneCode = a > 0 ? (run.sentCode[a - 1] ?? run.from - 1) : run.from - 1;
        }
        return {
            connected: this.connected,
            status: this.grbl?.status ?? { state: "Offline" },
            job: this.current,
            jobState: this.grbl?.jobState ?? "none",
            acked: run ? doneCode + 1 : progress.acked,
            total: run ? run.code.length : progress.total,
            elapsed: this.started > 0 ? (this.now() - this.started) / 1000 : 0,
            alarm: this.alarm,
            lastError: this.lastError,
            queue: this.jobs,
            doneLine: run && doneCode >= 0 ? run.src[doneCode] : -1,
            ...this.jobTools(),
            tool: this.tool,
            firmware: this.firmware,
            machine: machineSettings(this.settings),
            homed: this.homed,
            change: this.change,
            offset: this.offset,
            reference: this.reference,
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
        this.homed = false;
        // what the machine is: travel, homing, limits ($$; again after every reset)
        controller.send("$$", true);
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
        if (e.type === "in") {
            if (readSetting(this.settings, e.text)) this.changed();
            return;
        }
        if (e.type === "alarm") this.alarm = e.code;
        else if (e.type === "error") this.lastError = `error:${e.code} ${e.line}`;
        else if (e.type === "welcome") {
            this.alarm = undefined;
            this.firmware = e.version;
            this.grbl?.send("$$", true);
            // a reset with homing on locks the machine until $H: then its zero is lost
            this.checkLock = true;
            // a reset drops the tool length offset; the tool in the spindle still needs it
            if (this.offset !== 0) this.grbl?.send(applyOffsetLines(this.offset)[0], true);
        } else if (e.type === "status") {
            const state = e.status.state;
            if (this.checkLock) {
                this.checkLock = false;
                if (state === "Alarm") this.homed = false;
            }
            if (state === "Home") this.sawHoming = true;
            else if (this.sawHoming) {
                this.sawHoming = false;
                this.homed = state !== "Alarm";
            }
            // an M0 left in the program holds GRBL: show it as a pause, so «Старт» carries on
            if (this.grbl?.jobState === "running" && e.status.state === "Hold" && !this.change)
                this.grbl.pause();
            return this.changed();
        } else if (e.type === "job" && (e.state === "done" || e.state === "stopped" || e.state === "error"))
            this.finishJob(e.state);
        this.changed();
    }

    private finishJob(state: JobState) {
        const run = this.run;
        if (state === "done" && run && run.end < run.code.length) {
            // a part of the program done: the next tool goes in, then the next part
            const next = run.changes.find((c) => c.at === run.end);
            void this.toolChange(
                { kind: "planned", tool: next?.tool, name: next?.name, stage: "moving" },
                run.end,
            );
            return;
        }
        // our own stop for an emergency change: the change carries on
        if (state !== "done" && this.change?.kind === "emergency" && this.change.stage === "moving") return;
        if (state === "done" && this.current) {
            const i = this.jobs.findIndex((j) => j.id === this.current!.id);
            if (i >= 0) this.jobs.splice(i, 1);
            if (this.current === run?.job) this.current = this.jobs[0];
        }
        this.run = undefined;
        this.started = 0;
    }

    // ---- tool changes ------------------------------------------------------------------------

    /** Busy with a change or a measurement: the machine is moving by itself, hands off. */
    private toolsOf?: { job: StationJob; changes: number; tools: ToolRef[] };

    private jobTools(): { toolChanges: number; jobTools: ToolRef[] } {
        const job = this.current;
        if (!job) return { toolChanges: 0, jobTools: [] };
        if (this.toolsOf?.job !== job) {
            const p = jobProgram(job.lines);
            this.toolsOf = { job, changes: p.changes.length, tools: p.tools };
        }
        return { toolChanges: this.toolsOf.changes, jobTools: this.toolsOf.tools };
    }

    private get busy(): boolean {
        const stage = this.change?.stage;
        return stage !== undefined && stage !== "waiting" && stage !== "zero" && stage !== "failed";
    }

    private stage(stage: ToolChange["stage"], error?: string) {
        if (!this.change) return;
        this.change = { ...this.change, stage, error };
        this.changed();
    }

    private waitFor(ok: () => boolean, ms: number): Promise<void> {
        const until = this.now() + ms;
        return new Promise((resolve, reject) => {
            const loop = () => {
                if (ok()) resolve();
                else if (this.now() > until) reject(new Error("Контроллер не ответил"));
                else setTimeout(loop, 50);
            };
            loop();
        });
    }

    // ---- the travel measured between the limit switches ----------------------------------------

    /** A travel measurement under way (the screen shows its stage). */
    measuring?: { axis: Axis; stage: string };

    /**
     * The travel of one axis between its two limit switches: home ($H — the machine zero at one
     * switch, `pull-off` ($27) away from it), then a slow jog to the far end until the other switch
     * trips (ALARM 1, hard limit); where it tripped is the far end. Then a reset, the lock lifted,
     * soft limits put back, and home again. Needs hard limits on ($21=1) and both switches wired.
     * Returns the far switch's machine position and the travel to set ($13x): from the home
     * position to `pull-off` short of the far switch.
     */
    async measureTravel(
        axis: Axis,
        feed = 300,
    ): Promise<{ trippedAt: number; pullOff: number; travel: number }> {
        const grbl = this.grbl;
        if (!grbl || grbl.jobActive || this.busy || this.measuring) throw new Error("Станок занят");
        const i = "XYZ".indexOf(axis);
        const soft = this.settings.get(20) === 1;
        if (this.settings.get(21) !== 1)
            throw new Error("Концевики выключены в контроллере ($21=0) — включите их");
        if (this.settings.get(22) !== 1) throw new Error("Поиск нуля выключен в контроллере ($22=0)");
        const pullOff = this.settings.get(27) ?? 1;
        const guess = this.settings.get(130 + i) ?? 300;
        const io = new StationProbeIO(grbl);
        const stage = (text: string) => {
            this.measuring = { axis, stage: text };
            this.changed();
        };
        try {
            stage("поиск нуля по упорам");
            if (grbl.status.state === "Alarm") await io.send(["$X"]);
            await io.send(["$H"]);
            if (soft) await io.send(["$20=0"]); // a jog past the set travel would be refused
            stage(`едет до дальнего концевика ${axis}`);
            // far more than the travel: it stops at the switch (or, with none, at the end of the jog)
            const distance = Math.round(guess * 1.5 + 50);
            let tripped: number | undefined;
            const off = grbl.on((e) => {
                if (e.type === "alarm" && tripped === undefined)
                    tripped = grbl.status.mpos?.[i] ?? Number.NaN;
            });
            grbl.send(`$J=G91 G21 ${axis}-${distance} F${Math.round(feed)}`);
            try {
                await this.waitFor(
                    () => tripped !== undefined || (grbl.status.state === "Idle" && grbl.pending === 0),
                    ((distance / feed) * 60 + 20) * 1000,
                );
            } finally {
                off();
            }
            if (tripped === undefined)
                throw new Error(`Концевик ${axis} не сработал за ${distance} мм — проверьте проводку`);
            // the position the controller reported when the switch tripped (it stops at once)
            await this.waitFor(() => grbl.status.state === "Alarm", 3000).catch(() => {});
            const at = grbl.status.mpos?.[i] ?? tripped;
            stage("сброс и снова поиск нуля");
            void grbl.realtime(REALTIME.reset);
            await this.waitFor(() => this.firmware !== undefined && grbl.status.state !== "Run", 5000).catch(
                () => {},
            );
            await new Promise((r) => setTimeout(r, 1500));
            await io.send(["$X"]);
            if (soft) await io.send(["$20=1"]);
            await io.send(["$H"]);
            this.alarm = undefined;
            const trippedAt = Math.round(at * 1000) / 1000;
            const travel = Math.round((Math.abs(trippedAt) - pullOff) * 10) / 10;
            return { trippedAt, pullOff, travel };
        } finally {
            this.measuring = undefined;
            this.changed();
        }
    }

    /**
     * The tool length sensor checked: to its place at the safe height, a touch (fast, then slow),
     * back up. The machine Z it touched at, for the screen: it shows the sensor is where the
     * settings say and is wired (a touch that never comes is reported).
     */
    async checkSetter(): Promise<number> {
        const grbl = this.grbl;
        if (!grbl || grbl.jobActive || this.busy || this.measuring) throw new Error("Станок занят");
        if (!this.probe.setter.enabled) throw new Error("Датчик длины выключен: ⚙ → Инструмент");
        const m = machineSettings(this.settings);
        if (m.homing && !this.homed)
            throw new Error("Сначала «Домой»: место датчика задано в координатах станка");
        this.measuring = { axis: "Z", stage: "касание датчика длины" };
        this.changed();
        try {
            return await measureTool(new StationProbeIO(grbl), this.probe);
        } finally {
            this.measuring = undefined;
            this.changed();
        }
    }

    /**
     * Work zero by probing (3D probe in the spindle, or the cutter on a touch plate), with the
     * station's probe settings: the top, a corner, the centre of a hole or a boss, Z by a plate.
     * Returns what was found, in words. G10 L2 P0 sets the active work system (G54 by default).
     */
    async probeRun(
        kind: "top" | "corner" | "hole" | "boss" | "plate",
        o: { corner: Corner; withZ: boolean; boss: number; plate: number },
    ): Promise<string> {
        const grbl = this.grbl;
        if (!grbl || grbl.jobActive || this.busy || this.measuring) throw new Error("Станок занят");
        if (grbl.status.state === "Alarm" || this.alarm !== undefined)
            throw new Error("Станок в тревоге — разблокируйте");
        if (grbl.status.pins?.includes("P"))
            throw new Error("Щуп уже замкнут — проверьте провод или отведите его");
        const io = new StationProbeIO(grbl);
        const s = this.probe;
        const f = (v: number) => v.toFixed(3);
        const names = { top: "верх", corner: "угол", hole: "отверстие", boss: "бобышка", plate: "пластина" };
        this.measuring = { axis: "Z", stage: `щуп: ${names[kind]}` };
        this.changed();
        try {
            switch (kind) {
                case "top": {
                    const z = await probeTop(io, s, this.offset);
                    return `Z = 0 по верху (касание на ${f(z)} машинных)`;
                }
                case "corner": {
                    const r = await probeCorner(io, s, o.corner, o.withZ, this.offset);
                    return `X и Y = 0 в углу${r.z !== undefined ? ", Z = 0 по верху" : ""}`;
                }
                case "hole": {
                    const r = await probeHole(io, s, true);
                    return `X и Y = 0 в центре отверстия Ø${r.d.toFixed(3)}`;
                }
                case "boss": {
                    const r = await probeBoss(io, s, o.boss, true);
                    return `X и Y = 0 в центре бобышки Ø${r.d.toFixed(3)}`;
                }
                case "plate": {
                    await io.send(
                        probeLines({
                            thickness: o.plate,
                            travel: s.travel,
                            feed: s.latchFeed * 2,
                            retract: s.retract + 3,
                        }),
                    );
                    return `Z = 0 по верху заготовки (пластина ${o.plate} мм)`;
                }
            }
        } finally {
            this.measuring = undefined;
            this.changed();
        }
    }

    /** Sets an axis's travel in the controller ($130–$132). */
    async setTravel(axis: Axis, travel: number): Promise<void> {
        await this.sendLines([`$${130 + "XYZ".indexOf(axis)}=${travel.toFixed(1)}`, "$$"]);
    }

    private waitForUser(): Promise<void> {
        return new Promise((resolve, reject) => (this.changeWait = { resolve, reject }));
    }

    /**
     * The change itself: spindle off, to the change place; the person swaps the cutter and says
     * «Готово»; the new one is measured on the sensor and its offset applied (with no sensor,
     * Z is zeroed by hand); then the job carries on from code line `from`.
     */
    private async toolChange(change: ToolChange, from: number) {
        const grbl = this.grbl;
        if (!grbl) return;
        this.change = change;
        this.changed();
        try {
            const io = new StationProbeIO(grbl);
            const at = await this.toChangePosition(io);
            this.change = { ...this.change, at };
            this.stage("waiting");
            await this.waitForUser();
            if (change.kind === "planned" && change.tool !== undefined)
                this.tool = { tool: change.tool, name: change.name };
            if (this.probe.setter.enabled && this.reference !== undefined) {
                this.stage("measuring");
                const z = await measureTool(io, this.probe);
                this.offset = lengthOffset(z, this.reference);
                await io.send(applyOffsetLines(this.offset));
            } else {
                this.stage("zero");
                await this.waitForUser();
            }
            this.change = undefined;
            if (this.run) this.sendFrom(from);
            this.changed();
        } catch (e) {
            if (this.change) this.stage("failed", e instanceof Error ? e.message : String(e));
        }
    }

    /**
     * To where the cutter is changed: spindle and coolant off, the spindle up to the safe height,
     * then home by the limit switches ($H — machine zero, so nothing in the way of the hands). A
     * controller without homing (error:5, no switches) goes to the change place instead.
     */
    private async toChangePosition(io: StationProbeIO): Promise<"home" | "place"> {
        const grbl = this.grbl!;
        // a reset with homing on leaves GRBL locked until $H or $X
        if (grbl.status.state === "Alarm") await io.send(["$X"]);
        this.alarm = undefined;
        await io.send(["M5", "M9", "G21 G90", `G53 G0 Z${this.probe.safeZ}`]);
        try {
            await io.send(["$H"]);
            return "home";
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (!/error:5\b/.test(message)) throw e;
            await io.send(toChangeLines(this.probe));
            return "place";
        }
    }

    /** The cutter is in («Готово»), or Z is zeroed with it («Продолжить»). */
    changeDone(): boolean {
        const wait = this.changeWait;
        if (!wait) return false;
        this.changeWait = undefined;
        wait.resolve();
        return true;
    }

    /**
     * Emergency change mid-job (a broken or blunt cutter), through the length sensor: the job
     * stops where it is (feed hold, then a reset — the position is kept), the cutter is changed
     * and measured, and the job carries on from the line it was cutting. Returns why it cannot
     * be done, or undefined when it has begun.
     */
    emergencyChange(): string | undefined {
        const grbl = this.grbl;
        const run = this.run;
        if (!grbl || !run || !grbl.jobActive || this.change) return "Сейчас нет работающего задания";
        if (!this.probe.setter.enabled) return "Нужен датчик длины инструмента: ⚙ → Инструмент";
        if (this.reference === undefined) return "Фреза не была замерена на датчике до начала работы";
        const acked = grbl.progress.acked;
        const lo = run.sentCode[Math.max(0, acked - 40)] ?? run.from;
        const hi = run.sentCode[Math.max(0, acked - 1)] ?? run.from;
        const at = grbl.status.wpos;
        const line = at
            ? resumeLine(run.job.path, at, run.src[Math.max(0, lo)], run.src[Math.max(0, hi)])
            : -1;
        const found = run.src.indexOf(line);
        const from = Math.max(run.from, found >= 0 ? found : Math.max(0, lo));
        this.change = { kind: "emergency", stage: "moving" };
        this.changed();
        grbl.stop();
        void (async () => {
            try {
                await this.waitFor(() => grbl.jobState !== "stopping", 20000);
                await this.waitFor(() => grbl.status.state === "Idle" || grbl.status.state === "Alarm", 8000);
                await this.toolChange({ kind: "emergency", stage: "moving" }, from);
            } catch (e) {
                this.stage("failed", e instanceof Error ? e.message : String(e));
            }
        })();
        return undefined;
    }

    /** Measures the tool in the spindle as the reference: the one the work Z zero was set with. */
    async measureReference(): Promise<number> {
        const grbl = this.grbl;
        if (!grbl || grbl.jobActive || this.busy) throw new Error("Станок занят");
        if (!this.probe.setter.enabled) throw new Error("Датчик длины выключен: ⚙ → Инструмент");
        const keep = this.change;
        this.change = { kind: "planned", stage: "reference" };
        this.changed();
        try {
            const z = await measureTool(new StationProbeIO(grbl), this.probe);
            this.reference = z;
            this.offset = 0;
            return z;
        } finally {
            this.change = keep;
            this.changed();
        }
    }

    /** Sends code lines from `from` to the next tool change (all the program when there is none). */
    private sendFrom(from: number): boolean {
        const run = this.run;
        const grbl = this.grbl;
        if (!run || !grbl) return false;
        const next = run.changes.find((c) => c.at > from);
        const end = next ? next.at : run.code.length;
        let lines: string[];
        let sentCode: number[];
        if (from === 0) {
            lines = run.code.slice(0, end);
            sentCode = lines.map((_, i) => i);
        } else {
            // the state the lines before set up, the tool over the start point, then the rest
            const clear = Math.max(run.job.path.max[2], 3);
            lines = runFromLine(run.code.slice(0, end), from, clear)
                .map(cleanLine)
                .filter((l) => l !== "");
            const pre = lines.length - (end - from);
            sentCode = [
                ...Array<number>(pre).fill(from - 1),
                ...run.code.slice(from, end).map((_, i) => from + i),
            ];
        }
        run.from = from;
        run.end = end;
        run.sentCode = sentCode;
        if (lines.length === 0) {
            this.finishJob("done");
            return true;
        }
        return grbl.startJob(lines);
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

    /**
     * Why the selected job cannot start now, in words, or undefined when it can: no job, busy,
     * alarm, the machine has not found its zero (homing on), or the program at the current work
     * zero leaves the travel.
     */
    whyNotStart(): string | undefined {
        const grbl = this.grbl;
        if (!grbl) return "Контроллер не подключён";
        if (grbl.jobState === "paused") return undefined;
        if (!this.current) return "Нет задания";
        if (this.change || grbl.jobActive) return "Станок занят";
        if (this.alarm !== undefined || grbl.status.state === "Alarm")
            return "Станок в тревоге — разблокируйте";
        const m = machineSettings(this.settings);
        if (m.homing && !this.homed) return "Станок не инициализирован — нажмите «Домой» (ноль по упорам)";
        const st = grbl.status;
        if (m.travel && st.mpos && st.wpos) {
            const wco = st.mpos.map((v, i) => v - st.wpos![i]) as [number, number, number];
            const out = travelOverruns(this.current.path, wco, m.travel);
            if (out.length > 0) return `Программа не помещается в ход станка: ${overrunText(out)}`;
        }
        return undefined;
    }

    /** Runs the selected job, or resumes a paused one. Refused in alarm or without a job. */
    start(): boolean {
        const grbl = this.grbl;
        if (!grbl) return false;
        if (grbl.jobState === "paused") {
            grbl.resume();
            return true;
        }
        if (this.change || grbl.jobActive) return false;
        if (this.alarm !== undefined || grbl.status.state === "Alarm" || !this.current) return false;
        if (this.whyNotStart() !== undefined) return false;
        const program = jobProgram(this.current.lines);
        if (program.code.length === 0) return false;
        this.run = { job: this.current, ...program, from: 0, end: 0, sentCode: [] };
        // the program's first tool is the one in the spindle (it is what the work was set up with)
        if (program.tools[0] && program.changes[0]?.at !== 0) this.tool = program.tools[0];
        this.started = this.now();
        this.lastError = undefined;
        if (this.probe.setter.enabled && this.reference === undefined) {
            // the length sensor is on: the tool that set Z is measured first, so a later tool
            // (planned or emergency) lands on the same Z
            void this.measureReference()
                .then(() => this.sendFrom(0))
                .catch((e) => {
                    this.change = {
                        kind: "planned",
                        stage: "failed",
                        error: `Замер фрезы: ${e instanceof Error ? e.message : String(e)}`,
                    };
                    this.changed();
                });
        } else if (!this.sendFrom(0)) {
            this.run = undefined;
            return false;
        }
        this.changed();
        return true;
    }

    pause() {
        this.grbl?.pause();
    }

    /** Stops whatever runs: the job, a jog, the spindle (a soft reset). */
    stop() {
        if (this.change) {
            const wait = this.changeWait;
            this.changeWait = undefined;
            this.change = undefined;
            this.run = undefined;
            this.started = 0;
            wait?.reject(new Error("Отменено"));
            this.changed();
        }
        if (!this.grbl) return;
        if (this.grbl.jobActive) this.grbl.stop();
        else void this.grbl.realtime(REALTIME.reset);
    }

    // ---- by hand -------------------------------------------------------------------------------

    /** A jog of `step` mm on one axis; step 0 = until `jogStop` (continuous). */
    jog(axis: Axis, direction: 1 | -1, step: number): boolean {
        if (!this.grbl || this.grbl.jobActive || this.busy) return false;
        const distance = step > 0 ? step : 1000;
        const line = jogLine({ [axis]: direction * distance }, this.jogFeed);
        return line !== undefined && this.grbl.send(line);
    }

    /**
     * A ready jog line from the gamepad (a stream of short jogs while a stick is held). Refused
     * while a job runs, or while earlier jogs are still queued — the stick must not run ahead.
     */
    jogLine(line: string): boolean {
        if (!this.grbl || this.grbl.jobActive || this.busy || this.grbl.pending > 2) return false;
        return this.grbl.send(line, true);
    }

    jogStop() {
        void this.grbl?.realtime(REALTIME.jogCancel);
    }

    /** Work zero on one axis (or all) at the tool's position: G10 L20 P1. */
    zero(axes: readonly Axis[]): boolean {
        if (!this.grbl || this.grbl.jobActive || this.busy) return false;
        if (axes.includes("Z")) {
            // a new Z zero is set with the tool as it is: no length offset, and the reference
            // (measured with the old zero) no longer holds — it is measured again before a job
            if (this.offset !== 0) this.grbl.send("G49");
            this.offset = 0;
            this.reference = undefined;
            this.changed();
        }
        return this.grbl.send(`G10 L20 P1 ${axes.map((a) => `${a}0`).join(" ")}`);
    }

    /** The rotary axis by `step` degrees (0 = until `jogStop`), at `feed` degrees a minute. */
    jogA(direction: 1 | -1, step: number, feed: number): boolean {
        if (!this.grbl || this.grbl.jobActive || this.busy) return false;
        const distance = step > 0 ? step : 3600;
        return this.grbl.send(`$J=G91 A${direction * distance} F${Math.round(feed)}`);
    }

    /** Work zero of the rotary axis where it stands. */
    zeroA(): boolean {
        if (!this.grbl || this.grbl.jobActive || this.busy) return false;
        return this.grbl.send("G10 L20 P1 A0");
    }

    /** Sends setting lines one by one, each waiting for its ok (rejects on an error). */
    async sendLines(lines: string[]): Promise<void> {
        const grbl = this.grbl;
        if (!grbl) throw new Error("Контроллер не подключён");
        if (grbl.jobActive || this.busy) throw new Error("Станок занят");
        await new StationProbeIO(grbl).send(lines);
    }

    home(): boolean {
        if (this.busy || this.grbl?.jobActive) return false;
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
