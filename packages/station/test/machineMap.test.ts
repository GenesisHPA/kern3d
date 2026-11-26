// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { machineSettings, overrunText, readSetting, stockBox, travelOverruns } from "../src/machineMap";
import { StationMachine } from "../src/stationMachine";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("machine map", () => {
    test("the controller's $$ lines give travel, homing and limits", () => {
        const s = new Map<number, number>();
        for (const l of ["$20=1", "$21=0", "$22=1", "$130=350.000", "$131=150.000", "$132=120.000", "ok"])
            readSetting(s, l);
        expect(machineSettings(s)).toEqual({
            travel: [350, 150, 120],
            homing: true,
            softLimits: true,
            hardLimits: false,
        });
        expect(machineSettings(new Map()).travel).toBeUndefined();
    });

    test("a program is checked against the travel at the current work zero", () => {
        const path = {
            min: [0, 0, -5] as [number, number, number],
            max: [80, 50, 5] as [number, number, number],
        };
        const travel: [number, number, number] = [350, 150, 120];
        // work zero in the middle of the table, 30 mm under the top of Z: fits
        expect(travelOverruns(path, [-200, -100, -30], travel)).toEqual([]);
        // work zero 20 mm from the right end: the program runs 60 mm past it
        const out = travelOverruns(path, [-20, -100, -30], travel);
        expect(out).toEqual([{ axis: "X", by: 60, side: "max" }]);
        expect(overrunText(out)).toBe("X на 60.0 мм за правым краем");
    });

    test("the stock sits on its work zero: front-left corner or centre", () => {
        expect(stockBox({ width: 100, depth: 60, height: 20, zeroAt: "frontLeft" })).toEqual({
            min: [0, 0, -20],
            max: [100, 60, 0],
        });
        expect(stockBox({ width: 100, depth: 60, height: 20, zeroAt: "centre" }).min).toEqual([
            -50, -30, -20,
        ]);
    });

    test("with homing on the job waits for «Домой»; homing done, it starts", async () => {
        let feed: (t: string) => void = () => {};
        const machine = new StationMachine(async (onData) => {
            feed = onData;
            return { write: async () => {}, close: async () => {} };
        });
        await machine.connect();
        await tick();
        feed("$22=1\r\n$130=350\r\n$131=150\r\n$132=120\r\nok\r\n");
        feed("<Idle|MPos:-200.000,-100.000,-30.000|FS:0,0|WCO:-200.000,-100.000,-30.000>\r\n");
        machine.addJob("j", "G1 X10 F100", "file");
        expect(machine.whyNotStart()).toContain("Домой");
        expect(machine.start()).toBe(false);
        feed("<Home|MPos:0.000,0.000,0.000|FS:0,0>\r\n");
        feed("<Idle|MPos:-200.000,-100.000,-30.000|FS:0,0|WCO:-200.000,-100.000,-30.000>\r\n");
        expect(machine.snapshot().homed).toBe(true);
        expect(machine.whyNotStart()).toBeUndefined();
        await machine.disconnect();
    });
});
