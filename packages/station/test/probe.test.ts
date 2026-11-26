// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { StationMachine } from "../src/stationMachine";

/** A controller that answers every line with ok, a probing move with a touch at machine Z −42.5. */
function rig(pins = "") {
    let feed: (t: string) => void = () => {};
    const lines: string[] = [];
    const machine = new StationMachine(async (onData) => {
        feed = onData;
        return {
            write: async (data: string) => {
                if (!data.endsWith("\n")) {
                    if (data === "?")
                        setTimeout(
                            () => feed(`<Idle|MPos:-100.000,-50.000,-30.000|FS:0,0|Pn:${pins}>\r\n`),
                            0,
                        );
                    return;
                }
                const line = data.trim();
                lines.push(line);
                setTimeout(() => {
                    if (line.startsWith("G38.2")) feed("[PRB:-100.000,-50.000,-42.500:1]\r\n");
                    feed("ok\r\n");
                }, 0);
            },
            close: async () => {},
        };
    });
    return {
        machine,
        lines,
        status: () => feed(`<Idle|MPos:-100.000,-50.000,-30.000|FS:0,0|Pn:${pins}>\r\n`),
    };
}

describe("probing on the station", () => {
    test("Z by the top: down onto it, the work Z set where it touched", async () => {
        const r = rig();
        await r.machine.connect();
        await new Promise((ok) => setTimeout(ok, 20)); // the «$$» asked on connect answered
        r.status();
        const text = await r.machine.probeRun("top", {
            corner: "frontLeft",
            withZ: true,
            boss: 20,
            plate: 10,
        });
        expect(text).toContain("Z = 0 по верху");
        expect(r.lines.some((l) => l.startsWith("G38.2 Z-"))).toBe(true);
        expect(r.lines).toContain("G10 L2 P0 Z-42.5");
        expect(r.machine.measuring).toBeUndefined();
        await r.machine.disconnect();
    });

    test("Z by a touch plate: the plate's thickness becomes Z", async () => {
        const r = rig();
        await r.machine.connect();
        await new Promise((ok) => setTimeout(ok, 20)); // the «$$» asked on connect answered
        r.status();
        await r.machine.probeRun("plate", { corner: "frontLeft", withZ: false, boss: 20, plate: 12.7 });
        expect(r.lines).toContain("G10 L20 P0 Z12.7");
        await r.machine.disconnect();
    });

    test("refuses while the probe already reads touching (a shorted wire)", async () => {
        const r = rig("P");
        await r.machine.connect();
        await new Promise((ok) => setTimeout(ok, 20)); // the «$$» asked on connect answered
        r.status();
        await expect(
            r.machine.probeRun("top", { corner: "frontLeft", withZ: true, boss: 20, plate: 10 }),
        ).rejects.toThrow("Щуп уже замкнут");
        await r.machine.disconnect();
    });
});
