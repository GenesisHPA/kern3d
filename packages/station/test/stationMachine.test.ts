// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { StationMachine } from "../src/stationMachine";

/** Writes reach the fake port through a promise chain: let it run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A controller on the other end of a fake cable: what was written, and a way to answer. */
function rig() {
    const written: string[] = [];
    let feed: (text: string) => void = () => {};
    let clock = 1000;
    const machine = new StationMachine(
        async (onData) => {
            feed = onData;
            return {
                write: async (data: string) => {
                    written.push(data);
                },
                close: async () => {},
            };
        },
        () => clock,
    );
    return {
        machine,
        written,
        lines: () => written.filter((w) => w.endsWith("\n")).map((w) => w.trim()),
        answer: (text: string) => feed(`${text}\r\n`),
        advance: (ms: number) => {
            clock += ms;
        },
    };
}

describe("StationMachine", () => {
    test("a queued job runs line by line, its progress follows the oks, and leaves the queue when done", async () => {
        const r = rig();
        expect(await r.machine.connect()).toBe(true);
        const job = r.machine.addJob("plate", "%\nG21 G90\n(comment)\nG1 X10 F300\n%", "file");
        expect(r.machine.snapshot().job?.id).toBe(job.id);
        expect(r.machine.start()).toBe(true);
        await tick();
        expect(r.lines()).toEqual(["G21G90", "G1X10F300"]);
        r.advance(5000);
        r.answer("ok");
        expect(r.machine.snapshot()).toMatchObject({ acked: 1, total: 2, jobState: "running", elapsed: 5 });
        r.answer("ok");
        const done = r.machine.snapshot();
        expect(done.jobState).toBe("done");
        expect(done.queue).toHaveLength(0);
        await r.machine.disconnect();
    });

    test("an alarm blocks the start until it is unlocked with $X", async () => {
        const r = rig();
        await r.machine.connect();
        r.machine.addJob("a", "G1 X1", "network");
        r.answer("ALARM:1");
        expect(r.machine.snapshot().alarm).toBe(1);
        expect(r.machine.start()).toBe(false);
        expect(r.machine.unlock()).toBe(true);
        await tick();
        expect(r.lines()).toContain("$X");
        expect(r.machine.snapshot().alarm).toBeUndefined();
        await r.machine.disconnect();
    });

    test("jogging, zeroing and homing send their commands; jogs are refused while a job runs", async () => {
        const r = rig();
        await r.machine.connect();
        r.machine.jogFeed = 1200;
        expect(r.machine.jog("X", -1, 0.1)).toBe(true);
        expect(r.machine.zero(["X", "Y"])).toBe(true);
        expect(r.machine.home()).toBe(true);
        r.answer("ok");
        r.answer("ok");
        r.answer("ok");
        await tick();
        expect(r.lines()).toEqual(["$J=G91 G21 X-0.1 F1200", "G10 L20 P1 X0 Y0", "$H"]);
        r.machine.addJob("j", "G1 X1\nG1 X2", "file");
        r.machine.start();
        expect(r.machine.jog("Y", 1, 1)).toBe(false);
        await r.machine.disconnect();
    });

    test("a continuous jog goes far and is cut short by the jog-cancel byte", async () => {
        const r = rig();
        await r.machine.connect();
        r.machine.jog("Z", 1, 0);
        r.machine.jogStop();
        await tick();
        expect(r.lines()[0]).toBe("$J=G91 G21 Z1000 F1500");
        await tick();
        expect(r.written).toContain("\x85");
        await r.machine.disconnect();
    });

    test("pause then start resumes the job instead of starting it again", async () => {
        const r = rig();
        await r.machine.connect();
        r.machine.addJob("p", "G1 X1\nG1 X2\nG1 X3", "file");
        r.machine.start();
        r.machine.pause();
        expect(r.machine.snapshot().jobState).toBe("paused");
        expect(r.machine.start()).toBe(true);
        expect(r.machine.snapshot().jobState).toBe("running");
        await tick();
        expect(r.written).toContain("~");
        await r.machine.disconnect();
    });

    test("without a controller to open, connect reports false", async () => {
        const machine = new StationMachine(async () => undefined);
        expect(await machine.connect()).toBe(false);
        expect(machine.snapshot().status.state).toBe("Offline");
    });
});
