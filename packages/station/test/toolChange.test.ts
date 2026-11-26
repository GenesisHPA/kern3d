// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { programLines, programPath } from "../src/gcodePath";
import { StationMachine } from "../src/stationMachine";
import { jobProgram, resumeLine } from "../src/toolJob";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `ok`, letting timers and promise chains run (up to 3 s). */
/** Answers every line until the change waits for the person (the moves come in several batches). */
async function toWaiting(r: { okAll: () => Promise<void>; machine: StationMachine }) {
    for (let i = 0; i < 30 && r.machine.snapshot().change?.stage !== "waiting"; i++) {
        await r.okAll();
        await wait(10);
    }
    expect(r.machine.snapshot().change?.stage).toBe("waiting");
}

async function until(ok: () => boolean) {
    for (let i = 0; i < 300 && !ok(); i++) await wait(10);
    expect(ok()).toBe(true);
}

function rig() {
    const written: string[] = [];
    let feed: (text: string) => void = () => {};
    const machine = new StationMachine(async (onData) => {
        feed = onData;
        return {
            write: async (data: string) => {
                written.push(data);
            },
            close: async () => {},
        };
    });
    let answered = 0;
    const lines = () => written.filter((w) => w.endsWith("\n")).map((w) => w.trim());
    return {
        machine,
        written,
        lines,
        answer: (text: string) => feed(`${text}\r\n`),
        /** An ok for every line written and not yet answered (PRB first for probing lines). */
        okAll: async (touchZ?: number) => {
            await tick();
            const all = lines();
            for (; answered < all.length; answered++) {
                if (all[answered].startsWith("G38.2") && touchZ !== undefined)
                    feed(`[PRB:0.000,0.000,${touchZ}:1]\r\n`);
                feed("ok\r\n");
            }
            await tick();
        },
        skip: () => {
            answered = lines().length;
        },
    };
}

const PROGRAM = [
    "G21 G90",
    "S10000 M3",
    "G1 Z-1 F300",
    "G1 X10 F800",
    "(change to T2 Фреза 3 мм, set Z0)",
    "M0",
    "S12000 M3",
    "G1 X20",
    "G1 X30",
].join("\n");

describe("jobProgram", () => {
    test("drops comments and the change lines, keeps where each code line came from", () => {
        const p = jobProgram(programLines(PROGRAM));
        expect(p.code).toEqual([
            "G21G90",
            "S10000M3",
            "G1Z-1F300",
            "G1X10F800",
            "S12000M3",
            "G1X20",
            "G1X30",
        ]);
        expect(p.src).toEqual([0, 1, 2, 3, 6, 7, 8]);
        expect(p.changes).toEqual([{ at: 4, tool: 2, name: "Фреза 3 мм" }]);
    });

    test("the tools in order: the first from Kern3D's operation comment, then each change's", () => {
        const p = jobProgram([
            "(Карман — T1 Фреза 6 мм Ø6)",
            "G1 X1",
            "(change to T2 Фреза 3 мм, set Z0)",
            "M0",
            "G1 X2",
        ]);
        expect(p.tools).toEqual([
            { tool: 1, name: "Фреза 6 мм Ø6" },
            { tool: 2, name: "Фреза 3 мм" },
        ]);
    });

    test("T M6 is a change too; an M0 with no change before it stays in the program", () => {
        const p = jobProgram(["G1 X1", "T3 M6", "G1 X2", "M0", "G1 X3"]);
        expect(p.changes).toEqual([{ at: 1, tool: 3, name: undefined }]);
        expect(p.code).toEqual(["G1X1", "G1X2", "M0", "G1X3"]);
    });
});

describe("resumeLine", () => {
    test("the line whose path passes nearest to where the tool stopped", () => {
        const lines = ["G0 X0 Y0 Z1", "G1 Z-1 F100", "G1 X10", "G1 Y10", "G1 X0"];
        const path = programPath(lines);
        expect(resumeLine(path, [10, 4, -1], 0, 4)).toBe(3);
        expect(resumeLine(path, [5, 0.2, -1], 0, 4)).toBe(2);
        // only lines in the window count
        expect(resumeLine(path, [5, 0.2, -1], 3, 4)).toBe(3);
    });
});

describe("tool changes on the station", () => {
    test("planned change without a sensor: to the change place, swap, Z zeroed by hand, then the rest", async () => {
        const r = rig();
        await r.machine.connect();
        r.machine.addJob("two tools", PROGRAM, "file");
        expect(r.machine.snapshot().toolChanges).toBe(1);
        expect(r.machine.start()).toBe(true);
        await r.okAll(); // first part done
        await until(() => r.machine.snapshot().change?.stage === "moving");
        expect(r.machine.snapshot().change).toMatchObject({ kind: "planned", tool: 2, name: "Фреза 3 мм" });
        await toWaiting(r); // up, then home
        expect(r.lines()).toContain("M5");
        // up, then home by the limit switches
        expect(r.lines()).toContain("$H");
        expect(r.machine.snapshot().change?.at).toBe("home");
        expect(r.machine.changeDone()).toBe(true);
        await until(() => r.machine.snapshot().change?.stage === "zero");
        expect(r.machine.zero(["Z"])).toBe(true);
        r.skip();
        expect(r.machine.changeDone()).toBe(true);
        await until(() => r.machine.snapshot().change === undefined);
        await tick();
        const sent = r.lines();
        expect(sent.at(-1)).toBe("G1X30");
        expect(sent).toContain("S12000M3");
        expect(r.machine.snapshot().jobState).toBe("running");
        expect(r.machine.snapshot().tool).toEqual({ tool: 2, name: "Фреза 3 мм" });
        await r.okAll();
        await until(() => r.machine.snapshot().queue.length === 0);
        await r.machine.disconnect();
    });

    test("with the sensor on: the first tool is measured before the job, the next one gets its offset", async () => {
        const r = rig();
        await r.machine.connect();
        r.machine.probe = { ...r.machine.probe, setter: { enabled: true, x: -5, y: -5, z: -10 } };
        r.machine.addJob("two tools", PROGRAM, "file");
        expect(r.machine.start()).toBe(true);
        for (let i = 0; i < 20 && r.machine.snapshot().reference === undefined; i++) await r.okAll(-42);
        expect(r.machine.snapshot().reference).toBe(-42);
        await until(() => r.lines().includes("G1X10F800"));
        await r.okAll(); // first part
        await until(() => r.machine.snapshot().change?.stage === "moving");
        await toWaiting(r);
        r.machine.changeDone();
        await until(() => r.machine.snapshot().change?.stage === "measuring");
        // the new cutter is 1.5 mm longer: it touches the sensor 1.5 mm higher
        for (let i = 0; i < 10 && r.machine.snapshot().change; i++) await r.okAll(-40.5);
        await until(() => r.machine.snapshot().change === undefined);
        expect(r.machine.snapshot().offset).toBe(1.5);
        expect(r.lines()).toContain("G43.1 Z1.5");
        await r.machine.disconnect();
    });

    test("without homing in the controller (error:5) the change goes to the change place", async () => {
        const r = rig();
        await r.machine.connect();
        r.machine.addJob("two tools", PROGRAM, "file");
        r.machine.start();
        await r.okAll(); // first part done
        await until(() => r.machine.snapshot().change?.stage === "moving");
        // answer line by line: «$H» is refused as a controller without homing does
        for (let i = 0; i < 30 && r.machine.snapshot().change?.stage !== "waiting"; i++) {
            await tick();
            const all = r.lines();
            const last = all.at(-1);
            if (last === "$H" && !r.written.includes("error-sent")) {
                r.written.push("error-sent");
                r.answer("error:5");
            } else await r.okAll();
            await wait(10);
        }
        expect(r.machine.snapshot().change).toMatchObject({ stage: "waiting", at: "place" });
        expect(r.lines().some((l) => /^G53 G0 X/.test(l))).toBe(true);
        await r.machine.disconnect();
    });

    test("an emergency change needs the sensor and a measured tool", async () => {
        const r = rig();
        await r.machine.connect();
        r.machine.addJob("j", "G1 X1 F100\nG1 X2\nG1 X3", "file");
        expect(r.machine.emergencyChange()).toBe("Сейчас нет работающего задания");
        r.machine.start();
        expect(r.machine.emergencyChange()).toContain("датчик");
        await r.machine.disconnect();
    });

    test("an emergency change stops the job, changes and measures the cutter, carries on where it stopped", async () => {
        const r = rig();
        await r.machine.connect();
        r.machine.probe = { ...r.machine.probe, setter: { enabled: true, x: -5, y: -5, z: -10 } };
        r.machine.reference = -42;
        const program = [
            "G21 G90",
            "S9000 M3",
            "G0 Z2",
            "G1 Z-1 F300",
            "G1 X10 F800",
            "G1 Y10",
            "G1 X0",
            "G1 Y0",
        ];
        r.machine.addJob("pocket", program.join("\n"), "file");
        r.machine.start();
        await tick();
        for (let i = 0; i < 6; i++) r.answer("ok"); // GRBL has taken six lines, two still to go
        r.skip();
        // the tool is on the third side when the cutter breaks
        r.answer("<Run|WPos:4.000,10.000,-1.000|FS:800,9000>");
        expect(r.machine.emergencyChange()).toBeUndefined();
        expect(r.machine.snapshot().change).toMatchObject({ kind: "emergency", stage: "moving" });
        r.answer("<Hold:0|WPos:4.000,10.000,-1.000|FS:0,0>");
        await until(() => r.written.includes("\x18"));
        r.answer("Grbl 1.1h ['$' for help]");
        r.answer("<Idle|WPos:4.000,10.000,-1.000|FS:0,0>");
        r.skip();
        await until(() => r.lines().includes("M5"));
        await toWaiting(r);
        r.machine.changeDone();
        await until(() => r.machine.snapshot().change?.stage === "measuring");
        for (let i = 0; i < 10 && r.machine.snapshot().change; i++) await r.okAll(-41);
        await until(() => r.machine.snapshot().change === undefined);
        expect(r.machine.snapshot().offset).toBe(1);
        const sent = r.lines();
        const resumed = sent.slice(sent.lastIndexOf("G43.1 Z1") + 1);
        // back over the stop point with the spindle on, then the side it was cutting, and the rest
        expect(resumed).toContain("S9000M3");
        expect(resumed.slice(-2)).toEqual(["G1X0", "G1Y0"]);
        expect(r.machine.snapshot().jobState).toBe("running");
        await r.machine.disconnect();
    });
});
