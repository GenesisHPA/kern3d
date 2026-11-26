// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { StationMachine } from "../src/stationMachine";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A controller with limit switches at both ends of X: homes to 0, and a jog toward −X trips the far
 * switch at −352.5 (ALARM:1); a reset brings it back locked.
 */
function machineWithSwitches(settings: string[]) {
    let feed: (t: string) => void = () => {};
    const sent: string[] = [];
    let x = -120;
    let state = "Idle";
    const say = (t: string) => feed(`${t}\r\n`);
    const status = () => say(`<${state}|MPos:${x.toFixed(3)},-50.000,-10.000|FS:0,0>`);
    const machine = new StationMachine(async (onData) => {
        feed = onData;
        return {
            write: async (data: string) => {
                sent.push(data);
                setTimeout(() => {
                    if (data === "?") return status();
                    if (data === "\x18") {
                        state = "Alarm";
                        say("Grbl 1.1h ['$' for help]");
                        return status();
                    }
                    const line = data.trim();
                    if (line === "$$") {
                        for (const s of settings) say(s);
                        return say("ok");
                    }
                    if (line === "$H") {
                        state = "Home";
                        status();
                        x = -1;
                        state = "Idle";
                        status();
                        return say("ok");
                    }
                    if (line === "$X") {
                        state = "Idle";
                        return say("ok");
                    }
                    if (line.startsWith("$J=")) {
                        say("ok");
                        x = -352.5;
                        state = "Alarm";
                        status();
                        return say("ALARM:1");
                    }
                    say("ok");
                }, 0);
            },
            close: async () => {},
        };
    });
    return { machine, sent };
}

describe("travel by the limit switches", () => {
    test("homes, jogs to the far switch, reads where it tripped, resets, homes again", async () => {
        const { machine, sent } = machineWithSwitches([
            "$20=1",
            "$21=1",
            "$22=1",
            "$27=1.000",
            "$130=300.000",
        ]);
        await machine.connect();
        await new Promise((r) => setTimeout(r, 20));
        const r = await machine.measureTravel("X");
        expect(r).toEqual({ trippedAt: -352.5, pullOff: 1, travel: 351.5 });
        const lines = sent.map((s) => s.trim()).filter((s) => s.length > 1);
        // soft limits off for the jog, back on after; homed before and after
        expect(lines.indexOf("$20=0")).toBeLessThan(lines.findIndex((l) => l.startsWith("$J=")));
        expect(lines.at(-1)).toBe("$H");
        expect(lines).toContain("$20=1");
        expect(sent).toContain("\x18");
        expect(machine.measuring).toBeUndefined();
        await machine.disconnect();
    });

    test("refuses without limit switches enabled", async () => {
        const { machine } = machineWithSwitches(["$21=0", "$22=1"]);
        await machine.connect();
        await new Promise((r) => setTimeout(r, 20));
        await tick();
        await expect(machine.measureTravel("Y")).rejects.toThrow("$21=0");
        await machine.disconnect();
    });
});
