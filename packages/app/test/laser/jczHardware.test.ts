// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test } from "@rstest/core";
import { importMarkcfg } from "../../src/laser/ezcadImport";
import { JczDriver } from "../../src/laser/jczDriver";
import { defaultMachineProfile, type MachineProfile } from "../../src/laser/machineProfile";
import { openLmcUsb } from "../../src/laser/webUsb";

/**
 * On a real JCZ board, red pointer only (the laser is never fired): run with
 * KERN3D_JCZ_HW=<folder with node_modules/usb> and, optionally, KERN3D_EZCAD_CFG=<plug/markcfg7>.
 */
const hw = process.env["KERN3D_JCZ_HW"];

describe.skipIf(!hw)("JCZ board on USB (hardware)", () => {
    test("connects, reports, loops the red pointer round a 20 mm square for 5 s, stops", async () => {
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
        const log: string[] = [];
        driver.on((e) => {
            if (e.type === "log") log.push(`${e.kind}: ${e.text}`);
            if (e.type === "status") log.push(`status: ${e.status.label}`);
            if (e.type === "framing") log.push(`framing: ${e.active}`);
        });
        await driver.connect();
        console.log(`serial ${driver.serial}, version ${driver.version}, field ${jcz.field} mm`);
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
        await new Promise((r) => setTimeout(r, 5000));
        driver.stopFraming();
        for (let i = 0; i < 100 && driver.framing; i++) await new Promise((r) => setTimeout(r, 50));
        expect(driver.framing).toBe(false);
        await driver.disconnect();
        const out = process.env["KERN3D_JCZ_LOG"];
        if (out)
            writeFileSync(
                out,
                [`serial ${driver.serial} version ${driver.version} field ${jcz.field}`, ...log].join("\n"),
            );
        expect(driver.connected).toBe(false);
    }, 30000);
});
