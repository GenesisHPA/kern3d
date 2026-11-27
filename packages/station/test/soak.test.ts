// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Many random programs through the station against a GRBL-like controller model: a 128-byte
 * receive buffer, «ok» after each line with a random delay, feed hold («!»), resume («~»), soft
 * reset (Ctrl-X → the welcome line), status reports. Each program is run whole, paused and resumed,
 * stopped part way and carried on from the line it got to, and started from random lines — checking
 * that every line is sent exactly as written, in order, that progress ends at 100 %, and that a start
 * from a line never plunges before it is over its start point.
 */

import { programLines } from "../src/gcodePath";
import { StationMachine } from "../src/stationMachine";
import { jobProgram } from "../src/toolJob";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A small seeded random generator (mulberry32), so a failure can be replayed. */
/** SOAK_SEED shifts every seed: the long runs try new programs each round. */
const SHIFT = Number(
    (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.["SOAK_SEED"] ?? 0,
);

function rng(seed: number) {
    let a = (seed + SHIFT) >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A random but plausible milling program: header, spindle, cuts at a few depths, arcs, footer. */
function randomProgram(r: () => number): string {
    const n = (lo: number, hi: number, d = 3) => (lo + r() * (hi - lo)).toFixed(d);
    const out = [
        "(random part)",
        "G21 G90 G54",
        `S${Math.round(8000 + r() * 10000)} M3`,
        "G0 Z5",
        `G0 X${n(0, 60)} Y${n(0, 40)}`,
    ];
    const passes = 1 + Math.floor(r() * 4);
    for (let p = 1; p <= passes; p++) {
        out.push(`G1 Z${(-p * (0.5 + r())).toFixed(2)} F${Math.round(100 + r() * 300)}`);
        const moves = 3 + Math.floor(r() * 25);
        for (let m = 0; m < moves; m++) {
            const k = r();
            if (k < 0.6) out.push(`G1 X${n(0, 60)} Y${n(0, 40)} F${Math.round(400 + r() * 1600)}`);
            else if (k < 0.8) out.push(`G2 X${n(0, 60)} Y${n(0, 40)} I${n(-5, 5)} J${n(-5, 5)}`);
            else if (k < 0.9) out.push(`X${n(0, 60)}`);
            else out.push(`; comment ${m}`);
        }
        out.push("G0 Z5");
    }
    out.push("M5", "G0 X0 Y0", "M30");
    return out.join("\n");
}

/** The controller model. */
function controller(r: () => number) {
    let feed: (t: string) => void = () => {};
    const received: string[] = []; // job lines as GRBL got them, in order
    const overruns: string[] = [];
    let buffer = 0;
    let state = "Idle";
    let held = false;
    const pending: string[] = [];
    const say = (t: string) => feed(`${t}\r\n`);
    // one line at a time, in order, as GRBL's planner takes them
    let busy = false;
    let gen = 0;
    const pump = () => {
        if (busy || held || pending.length === 0) return;
        busy = true;
        const mine = gen;
        setTimeout(
            () => {
                if (gen !== mine) return; // a reset came in between: this line is gone
                busy = false;
                if (held || pending.length === 0) return;
                const line = pending.shift()!;
                if (line !== "$$") received.push(line);
                buffer -= line.length + 1;
                state = pending.length > 0 ? "Run" : "Idle";
                say("ok");
                pump();
            },
            Math.floor(r() * 3),
        );
    };
    const machine = new StationMachine(async (onData) => {
        feed = onData;
        // opening the port resets the board (a Nano's DTR): whatever came before the welcome is lost
        setTimeout(() => {
            pending.length = 0;
            buffer = 0;
            busy = false;
            gen++;
            say("Grbl 1.1h ['$' for help]");
        }, 0);
        return {
            write: async (data: string) => {
                if (data !== "?" && !data.endsWith("\n")) events.push(`rt:${JSON.stringify(data)}`);
                if (data === "?") {
                    setTimeout(
                        () =>
                            say(
                                `<${held ? "Hold:0" : state}|MPos:-100.000,-50.000,-20.000|FS:0,0|WCO:-100.000,-50.000,-20.000>`,
                            ),
                        0,
                    );
                    return;
                }
                if (data === "!") {
                    held = true;
                    return;
                }
                if (data === "~") {
                    held = false;
                    pump();
                    return;
                }
                if (data === "\x18") {
                    pending.length = 0;
                    buffer = 0;
                    busy = false;
                    gen++;
                    held = false;
                    state = "Idle";
                    setTimeout(() => say("Grbl 1.1h ['$' for help]"), 1);
                    return;
                }
                if (!data.endsWith("\n")) return; // other realtime bytes
                const line = data.trim();
                buffer += line.length + 1;
                if (buffer > 128) overruns.push(`${buffer} bytes at «${line}»`);
                pending.push(line);
                pump();
            },
            close: async () => {},
        };
    });
    debugModel = () =>
        JSON.stringify({ received: received.length, pending: pending.length, buffer, held, state, overruns });
    return { machine, received, overruns };
}
let debugModel = () => "";
let lastSeed = 0;
const events: string[] = [];

let lastMachine: StationMachine | undefined;
async function until(ok: () => boolean, ms = 20000) {
    const end = Date.now() + ms;
    while (!ok()) {
        if (Date.now() > end) {
            const s = lastMachine?.snapshot();
            throw new Error(
                `timed out (seed ${lastSeed}, events ${events.slice(-14).join(" ")}): ${debugModel()} ${JSON.stringify({ state: s?.status.state, job: s?.jobState, acked: s?.acked, total: s?.total, queue: s?.queue.length, err: s?.lastError, alarm: s?.alarm })}`,
            );
        }
        await wait(2);
    }
}

describe("soak: random programs through the station", () => {
    const RUNS = 120;

    test(`${RUNS} programs run whole: every line sent once, in order, the job done`, async () => {
        for (let seed = 1; seed <= RUNS; seed++) {
            const r = rng(seed);
            const text = randomProgram(r);
            const { machine, received } = controller(r);
            lastMachine = machine;
            await machine.connect();
            await wait(3);
            machine.addJob(`p${seed}`, text, "file");
            expect(machine.start()).toBe(true);
            await until(() => machine.snapshot().queue.length === 0);
            const code = jobProgram(programLines(text)).code.map((l) => machine.withSpinUp(l));
            if (received.join("|") !== code.join("|"))
                throw new Error(
                    `seed ${seed}: got ${received.slice(0, 4).join(" ")} … (${received.length}) want ${code.slice(0, 4).join(" ")} … (${code.length}); ${debugModel()}`,
                );
            await machine.disconnect();
        }
    }, 120_000);

    test(`${RUNS / 2} programs paused and resumed at random moments: nothing lost, nothing doubled`, async () => {
        for (let seed = 1001; seed <= 1000 + RUNS / 2; seed++) {
            lastSeed = seed;
            events.length = 0;
            const r = rng(seed);
            const text = randomProgram(r);
            const { machine, received } = controller(r);
            lastMachine = machine;
            await machine.connect();
            await wait(3);
            machine.addJob(`p${seed}`, text, "file");
            machine.start();
            for (let k = 0; k < 3; k++) {
                await wait(Math.floor(r() * 15));
                if (machine.snapshot().jobState !== "running") break;
                machine.pause();
                await wait(Math.floor(r() * 10));
                expect(machine.start()).toBe(true); // «Старт» on a paused job resumes it
            }
            await until(() => machine.snapshot().queue.length === 0);
            expect(received).toEqual(jobProgram(programLines(text)).code.map((l) => machine.withSpinUp(l)));
            await machine.disconnect();
        }
    }, 120_000);

    test(`${RUNS / 2} programs stopped part way and carried on from where they got to`, async () => {
        let carried = 0;
        for (let seed = 2001; seed <= 2000 + RUNS / 2; seed++) {
            lastSeed = seed;
            events.length = 0;
            const r = rng(seed);
            const text = randomProgram(r);
            const { machine, received } = controller(r);
            lastMachine = machine;
            await machine.connect();
            await wait(3);
            const job = machine.addJob(`p${seed}`, text, "file");
            machine.start();
            await wait(2 + Math.floor(r() * 20));
            if (machine.snapshot().jobState !== "running") {
                await machine.disconnect();
                continue;
            }
            machine.stop();
            await until(
                () => machine.snapshot().jobState !== "running" && machine.snapshot().jobState !== "stopping",
            );
            const stopped = machine.interrupted;
            if (stopped === undefined) {
                // stopped before a single line was done: nothing to carry on from, a start is a start
                expect(machine.snapshot().doneLine).toBe(-1);
                await machine.disconnect();
                continue;
            }
            expect(stopped.jobId).toBe(job.id);
            const line = stopped!.line;
            // as the screen does: «Продолжить» is refused until the controller is back from its reset
            await until(() => machine.whyNotStart() === undefined);
            const before = received.length;
            expect(machine.startFrom(line)).toBe(true);
            await until(() => machine.snapshot().queue.length === 0);
            const program = jobProgram(programLines(text));
            const from = program.src.findIndex((s) => s >= line);
            // the rest, exactly, follows the restoring preamble
            const after = received.slice(before);
            expect(after.slice(after.length - (program.code.length - from))).toEqual(
                program.code.slice(from).map((l) => machine.withSpinUp(l)),
            );
            expect(machine.interrupted).toBeUndefined();
            carried++;
            await machine.disconnect();
        }
        expect(carried).toBeGreaterThan(10);
    }, 120_000);

    test(`${RUNS} starts from random lines: never down before over the start point`, async () => {
        for (let seed = 3001; seed <= 3000 + RUNS; seed++) {
            const r = rng(seed);
            const text = randomProgram(r);
            const lines = programLines(text);
            const program = jobProgram(lines);
            const { machine, received } = controller(r);
            lastMachine = machine;
            await machine.connect();
            await wait(3);
            machine.addJob(`p${seed}`, text, "file");
            const line = Math.floor(r() * lines.length);
            const from = program.src.findIndex((s) => s >= line);
            if (from < 0) {
                await machine.disconnect();
                continue;
            }
            expect(machine.startFrom(line)).toBe(true);
            await until(() => machine.snapshot().queue.length === 0);
            const pre = received.slice(0, received.length - (program.code.length - from));
            expect(received.slice(pre.length)).toEqual(
                program.code.slice(from).map((l) => machine.withSpinUp(l)),
            );
            // the preamble: up to a clear height first; any move down comes after the XY move
            const zMoves = pre.map((l, i) => ({ l, i })).filter(({ l }) => /Z-?[\d.]/.test(l));
            if (zMoves.length > 0) {
                expect(zMoves[0].l).toMatch(/^G0Z/);
                const xy = pre.findIndex((l) => /^G0X|^G0Y/.test(l));
                const down = zMoves.find(({ l }) => /^G1Z/.test(l));
                if (down) expect(xy).toBeGreaterThanOrEqual(0);
                if (down) expect(down.i).toBeGreaterThan(xy);
            }
            await machine.disconnect();
        }
    }, 120_000);
});
