// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test } from "@rstest/core";
import { importMarkcfg } from "../../src/laser/ezcadImport";
import { JczDriver } from "../../src/laser/jczDriver";
import { defaultMachineProfile, type MachineProfile } from "../../src/laser/machineProfile";
import { openLmcUsb } from "../../src/laser/webUsb";

/**
 * On a real JCZ board, red pointer only (the laser is never fired). Run with
 * KERN3D_JCZ_HW=<folder with node_modules/usb>, optionally KERN3D_EZCAD_CFG=<plug/markcfg7>
 * and KERN3D_JCZ_LOG=<file> for a timed log of what happened.
 */
const hw = process.env["KERN3D_JCZ_HW"];
const logFile = process.env["KERN3D_JCZ_LOG"];
const t0 = Date.now();

function note(line: string) {
    if (logFile) appendFileSync(logFile, `${((Date.now() - t0) / 1000).toFixed(2)} ${line}\n`);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hw)("JCZ board on USB (hardware)", () => {
    test("connects, reports, loops the red pointer round a 20 mm square for 5 s, stops", async () => {
        if (logFile) writeFileSync(logFile, "");
        const { WebUSB } = createRequire(`${hw}/`)("usb");
        Object.defineProperty(globalThis, "navigator", {
            value: { language: "ru", languages: ["ru"], usb: new WebUSB({ allowAllDevices: true }) },
            configurable: true,
        });
        const base = defaultMachineProfile();
        let jcz = base.jcz;
        const cfg = process.env["KERN3D_EZCAD_CFG"];
        if (cfg) jcz = importMarkcfg(readFileSync(cfg, "latin1"), jcz).jcz;
        const profile: MachineProfile = { ...base, controller: "jcz", origin: "center", jcz };
        const driver = new JczDriver(() => profile, openLmcUsb);
        driver.on((e) => {
            if (e.type === "log") note(`${e.kind}: ${e.text}`);
            if (e.type === "status") note(`status: ${e.status.state} ${e.status.label}`);
            if (e.type === "framing") note(`framing: ${e.active}`);
        });
        await driver.connect();
        note(`serial ${driver.serial} version ${driver.version} field ${jcz.field}`);
        expect(driver.connected).toBe(true);
        const square = [
            [
                { x: -10, y: -10 },
                { x: 10, y: -10 },
                { x: 10, y: 10 },
                { x: -10, y: 10 },
                { x: -10, y: -10 },
            ],
        ];
        expect(driver.startFraming(square)).toBe(true);
        await wait(5000);
        note("stop");
        driver.stopFraming();
        for (let i = 0; i < 100 && driver.framing; i++) await wait(50);
        note(`framing ${driver.framing}`);
        const result = await Promise.race([
            driver.disconnect().then(() => "done"),
            wait(8000).then(() => "timeout"),
        ]);
        note(`disconnect ${result}`);
        if (result === "timeout") {
            // let go of the board anyway, or Windows keeps it until it is replugged
            await (driver as unknown as { transport?: { close(): Promise<void> } }).transport?.close();
        }
        expect(result).toBe("done");
        expect(driver.connected).toBe(false);
    }, 40000);
});
