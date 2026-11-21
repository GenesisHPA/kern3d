// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { REALTIME } from "../../src/laser/grblController";
import { GrblDriver, type GrblPort } from "../../src/laser/grblDriver";
import { defaultLaserJob } from "../../src/laser/laserData";
import type { DriverEvent, LaserProgram } from "../../src/laser/laserDriver";
import { defaultMachineProfile, type MachineProfile } from "../../src/laser/machineProfile";

class FakePort implements GrblPort {
    readonly written: string[] = [];
    closed = false;
    async write(data: string) {
        this.written.push(data);
    }
    async close() {
        this.closed = true;
    }
    get lines(): string[] {
        return this.written.filter((w) => w.endsWith("\n") && w !== "\n").map((w) => w.slice(0, -1));
    }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const square = [
    [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 0 },
    ],
];

async function connected(profile: Partial<MachineProfile> = {}) {
    const port = new FakePort();
    let receive: (text: string) => void = () => {};
    const timers: (() => void)[] = [];
    let polls = 0;
    const p = { ...defaultMachineProfile(), ...profile };
    const driver = new GrblDriver(() => p, {
        open: async (_baud, onData) => {
            receive = onData;
            return port;
        },
        schedule: (fn) => timers.push(fn),
        every: () => {
            polls++;
            return () => polls--;
        },
    });
    const events: DriverEvent[] = [];
    driver.on((e) => events.push(e));
    await driver.connect();
    await settle();
    return { port, driver, events, timers, receive: (text: string) => receive(text), polls: () => polls };
}

function program(lines: string[]): LaserProgram {
    return {
        job: defaultLaserJob(),
        profile: defaultMachineProfile(),
        images: new Map(),
        gcode: lines,
        seconds: 1,
    };
}

describe("GRBL driver", () => {
    test("connecting opens the port, starts the status poll and reports it", async () => {
        const { driver, events, polls } = await connected();
        expect(driver.connected).toBe(true);
        expect(polls()).toBe(1);
        expect(events).toContainEqual({ type: "connection", connected: true });
    });

    test("the red pointer loops: setup once, then rounds refilled as GRBL answers", async () => {
        const { port, driver, receive } = await connected();
        expect(driver.startFraming(square)).toBe(true);
        await settle();
        // G21, G90, M5 and the first round (4 lines) fit the buffer; the second round waits
        expect(port.lines.slice(0, 3)).toEqual(["G21", "G90", "M5"]);
        expect(port.lines.slice(3, 7)).toEqual(["G0 X0 Y0", "G1 X10 S0 F3000", "G1 Y10", "G1 X0 Y0"]);
        const before = port.lines.length;
        for (let i = 0; i < 12; i++) receive("ok\n");
        await settle();
        // more rounds went out after the acknowledgements: the loop keeps going
        expect(port.lines.length).toBeGreaterThan(before + 4);
        expect(port.lines.filter((l) => l === "G0 X0 Y0").length).toBeGreaterThanOrEqual(3);
        expect(driver.framing).toBe(true);
    });

    test("stopping the loop holds, resets once the head stops, then laser and pointer off", async () => {
        const { port, driver, receive } = await connected({ pointerOn: "M7", pointerOff: "M9" });
        driver.startFraming(square);
        driver.stopFraming();
        await settle();
        expect(driver.framing).toBe(false);
        expect(port.written).toContain(REALTIME.hold);
        receive("<Hold:0|MPos:0,0,0>\n");
        await settle();
        expect(port.written).toContain(REALTIME.reset);
        receive("Grbl 1.1h ['$' for help]\n");
        await settle();
        expect(port.lines.slice(-2)).toEqual(["M5", "M9"]);
        expect(port.lines).toContain("M7");
    });

    test("«Маркировка» during the loop ends the loop first and starts the job after the reset", async () => {
        const { port, driver, receive } = await connected();
        driver.startFraming(square);
        expect(driver.run(program(["G1 X5 S100 F1000"]))).toBe(true);
        expect(driver.framing).toBe(false);
        receive("<Hold:0|MPos:0,0,0>\n");
        receive("Grbl 1.1h ['$' for help]\n");
        await settle();
        expect(driver.jobState).toBe("running");
        expect(port.lines.slice(-2)).toEqual(["M5", "G1X5S100F1000"]);
    });

    test("a job runs, reports progress and ends", async () => {
        const { driver, receive, events } = await connected();
        expect(driver.run(program(["G0 X1", "G1 X2 S10 F100"]))).toBe(true);
        receive("ok\nok\n");
        expect(driver.jobState).toBe("done");
        expect(events).toContainEqual({ type: "progress", done: 2, total: 2 });
    });

    test("an alarm is explained and stops the loop", async () => {
        const { driver, receive, events } = await connected();
        driver.startFraming(square);
        receive("ALARM:2\n");
        expect(driver.framing).toBe(false);
        const alert = events.find((e) => e.type === "alert");
        expect(alert).toBeDefined();
        expect((alert as { text: string }).text).toMatch(/^ALARM:2 — /);
    });

    test("disconnecting switches the laser off and closes the port", async () => {
        const { port, driver, timers, polls } = await connected();
        const done = driver.disconnect();
        await settle();
        timers.forEach((fn) => fn());
        await done;
        expect(port.lines).toContain("M5");
        expect(port.closed).toBe(true);
        expect(driver.connected).toBe(false);
        expect(polls()).toBe(0);
    });
});
