// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { grblAlarmText, PINS } from "../src/grblText";
import { StationMachine } from "../src/stationMachine";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("safety on the station", () => {
    test("alarms read in words; unknown ones keep their number", () => {
        expect(grblAlarmText(1)).toContain("концевик");
        expect(grblAlarmText(9)).toContain("не найден");
        expect(grblAlarmText(42)).toBe("тревога 42");
        expect(PINS.map(([k]) => k)).toEqual(["X", "Y", "Z", "A", "P", "T", "D", "H", "R", "S"]);
    });

    test("a spindle start waits for the spindle: a dwell in the same block, once", () => {
        const m = new StationMachine(async () => undefined);
        expect(m.withSpinUp("S12000M3")).toBe("S12000M3G4P3");
        expect(m.withSpinUp("M04S8000")).toBe("M04S8000G4P3");
        expect(m.withSpinUp("M3S9000G4P5")).toBe("M3S9000G4P5"); // its own dwell kept
        expect(m.withSpinUp("M30")).toBe("M30");
        expect(m.withSpinUp("G1X10F300")).toBe("G1X10F300");
        m.spinUp = 0;
        expect(m.withSpinUp("S12000M3")).toBe("S12000M3");
    });

    test("pause stops the spindle once the hold has settled; resume does not send it again", async () => {
        let feed: (t: string) => void = () => {};
        const realtime: string[] = [];
        let state = "Run";
        const machine = new StationMachine(async (onData) => {
            feed = onData;
            return {
                write: async (data: string) => {
                    if (data === "?") {
                        setTimeout(() => feed(`<${state}|MPos:0,0,0|FS:500,12000>\r\n`), 0);
                        return;
                    }
                    if (!data.endsWith("\n")) realtime.push(data);
                },
                close: async () => {},
            };
        });
        await machine.connect();
        machine.addJob("j", "S12000 M3\nG1 X10 F100\nG1 X20\nG1 X30", "file");
        expect(machine.start()).toBe(true);
        machine.pause();
        state = "Hold:1"; // still slowing down: not yet
        await wait(300);
        expect(realtime).not.toContain("\x9e");
        state = "Hold:0";
        await wait(400);
        expect(realtime.filter((b) => b === "\x9e")).toHaveLength(1);
        expect(machine.start()).toBe(true); // resume: «~», and GRBL restores the spindle itself
        await wait(50);
        expect(realtime.filter((b) => b === "\x9e")).toHaveLength(1);
        expect(realtime).toContain("~");
        await machine.disconnect();
    });
});
