// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    cleanLine,
    GrblController,
    type GrblEvent,
    type GrblTransport,
    parseStatus,
    REALTIME,
} from "../../src/laser/grblController";
import { toBytes } from "../../src/laser/webSerial";

/** A port that records what is written and lets the test answer as GRBL would. */
class FakePort implements GrblTransport {
    readonly written: string[] = [];
    async write(data: string) {
        this.written.push(data);
    }
    /** Lines (with their \n) the controller has sent, realtime bytes left out. */
    get lines(): string[] {
        return this.written.filter((w) => w.endsWith("\n")).map((w) => w.slice(0, -1));
    }
}

function setup(rxBuffer = 128) {
    const port = new FakePort();
    const timers: (() => void)[] = [];
    const controller = new GrblController(port, { rxBuffer, schedule: (fn) => timers.push(fn) });
    const events: GrblEvent[] = [];
    controller.on((e) => events.push(e));
    return { port, controller, events, timers };
}

/** Lets the queued writes reach the port. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("status reports", () => {
    test("state, positions and feed; WPos from MPos and the last WCO", () => {
        const s = parseStatus("<Run|MPos:10.000,5.000,0.000|FS:1000,500|WCO:2.000,1.000,0.000>");
        expect(s).toEqual({
            state: "Run",
            mpos: [10, 5, 0],
            wpos: [8, 4, 0],
            feed: 1000,
            spindle: 500,
        });
        const later = parseStatus("<Hold:0|MPos:1,1,0|Bf:15,128>", [1, 1, 0]);
        expect(later?.state).toBe("Hold");
        expect(later?.sub).toBe(0);
        expect(later?.wpos).toEqual([0, 0, 0]);
        expect(later?.bufferBytes).toBe(128);
    });

    test("lines are sent without comments and spaces", () => {
        expect(cleanLine("G1 X10 Y0 ; edge")).toBe("G1X10Y0");
        expect(cleanLine("(header)")).toBe("");
    });

    test("realtime bytes stay single bytes on the wire", () => {
        expect(Array.from(toBytes("\x85!"))).toEqual([0x85, 0x21]);
    });
});

describe("character-counting streaming", () => {
    test("never more unanswered bytes than the receive buffer; each ok lets the next line go", async () => {
        // 10-byte lines ("G1X1234567" + \n = 11 bytes) into a 32-byte buffer: two fit, the third waits
        const { port, controller } = setup(32);
        const program = Array.from({ length: 5 }, (_, i) => `G1X12345${i}0`);
        controller.startJob(program);
        await settle();
        expect(port.lines).toEqual(program.slice(0, 2));
        expect(controller.bufferUsed).toBe(22);
        controller.receive("ok\n");
        await settle();
        expect(port.lines).toEqual(program.slice(0, 3));
        controller.receive("ok\r\nok\n");
        await settle();
        expect(port.lines).toEqual(program);
        expect(controller.bufferUsed).toBeLessThanOrEqual(32);
        controller.receive("ok\nok\n");
        expect(controller.jobState).toBe("done");
        expect(controller.progress).toEqual({ acked: 5, total: 5 });
    });

    test("replies split across chunks are put back together", () => {
        const { controller } = setup();
        controller.startJob(["G0X1", "G0X2"]);
        controller.receive("o");
        expect(controller.progress.acked).toBe(0);
        controller.receive("k\no");
        expect(controller.progress.acked).toBe(1);
        controller.receive("k\n");
        expect(controller.jobState).toBe("done");
    });

    test("error:N stops the job, drops the rest and switches the laser off", async () => {
        const { port, controller, events } = setup(16);
        controller.startJob(["G1X1", "G1X2", "G1X3", "G1X4", "G1X5"]);
        await settle();
        expect(port.lines).toEqual(["G1X1", "G1X2", "G1X3"]);
        controller.receive("error:20\n");
        await settle();
        expect(controller.jobState).toBe("error");
        expect(events).toContainEqual({ type: "error", code: 20, line: "G1X1" });
        // the lines already in GRBL's buffer still answer; nothing else of the job is sent
        expect(port.lines).toEqual(["G1X1", "G1X2", "G1X3", "M5"]);
    });

    test("pause is a feed hold and resume carries on", async () => {
        const { port, controller } = setup(12);
        controller.startJob(["G1X1", "G1X2", "G1X3"]);
        controller.pause();
        expect(controller.jobState).toBe("paused");
        controller.receive("ok\n");
        await settle();
        expect(port.written).toContain(REALTIME.hold);
        // held: nothing new is streamed
        expect(port.lines).toEqual(["G1X1", "G1X2"]);
        controller.resume();
        await settle();
        expect(port.written).toContain(REALTIME.resume);
        expect(port.lines).toEqual(["G1X1", "G1X2", "G1X3"]);
    });

    test("stop holds, waits for the hold to settle, then resets", async () => {
        const { port, controller, timers } = setup();
        controller.startJob(["G1X1", "G1X2"]);
        controller.stop();
        await settle();
        expect(controller.jobState).toBe("stopping");
        expect(port.written).toContain(REALTIME.hold);
        expect(port.written).not.toContain(REALTIME.reset);
        controller.receive("<Hold:1|MPos:0,0,0>\n");
        await settle();
        expect(port.written).not.toContain(REALTIME.reset);
        controller.receive("<Hold:0|MPos:0,0,0>\n");
        await settle();
        expect(port.written).toContain(REALTIME.reset);
        expect(controller.jobState).toBe("stopped");
        expect(controller.bufferUsed).toBe(0);
        // the fallback timer does nothing once reset
        timers.forEach((fn) => fn());
        await settle();
        expect(port.written.filter((w) => w === REALTIME.reset)).toHaveLength(1);
    });

    test("a stop whose hold never reports still resets on the timer", async () => {
        const { port, controller, timers } = setup();
        controller.startJob(["G1X1"]);
        controller.stop();
        expect(timers).toHaveLength(1);
        timers[0]();
        await settle();
        expect(port.written).toContain(REALTIME.reset);
        expect(controller.jobState).toBe("stopped");
    });

    test("commands are refused while a job runs and accepted after", () => {
        const { controller } = setup();
        controller.startJob(["G1X1"]);
        expect(controller.send("$H")).toBe(false);
        controller.receive("ok\n");
        expect(controller.send("$H")).toBe(true);
    });

    test("an alarm ends the job and forgets the buffer", () => {
        const { controller, events } = setup();
        controller.startJob(["G1X1", "G1X2"]);
        controller.receive("ALARM:1\n");
        expect(controller.jobState).toBe("error");
        expect(controller.bufferUsed).toBe(0);
        expect(controller.status.state).toBe("Alarm");
        expect(events).toContainEqual({ type: "alarm", code: 1 });
    });

    test("the greeting after a reset clears what was in flight", () => {
        const { controller, events } = setup();
        controller.send("G0X1");
        expect(controller.bufferUsed).toBe(5);
        controller.receive("Grbl 1.1h ['$' for help]\n");
        expect(controller.bufferUsed).toBe(0);
        expect(events).toContainEqual({ type: "welcome", version: "Grbl 1.1h ['$' for help]" });
    });
});
