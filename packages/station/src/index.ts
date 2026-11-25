// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { WebSerialConnection } from "@chili3d/app/src/laser/webSerial";
import { DemoGrbl, demoProgram } from "./demoGrbl";
import { demoDisplay, serverDisplay } from "./settings";
import { type Connect, StationMachine } from "./stationMachine";
import { StationUi } from "./stationUi";
import { demoWifi, serverWifi } from "./wifiPanel";

/**
 * «Kern3D Станок»: the machine station's page (station.html). Only the machine — no modeller,
 * no OCCT kernel — so it starts in a moment on the PC by the mill. The controller is opened by
 * USB (Web Serial): a port granted once is reopened by itself at start and when the cable
 * comes back.
 */
const BAUD = 115200;
let ask = false;

/** `station.html?demo`: a pretend controller and a sample job, to try the screen without a machine. */
const demo = new URLSearchParams(location.search).has("demo");

const connect: Connect = async (onData, onClose) => {
    if (demo) return new DemoGrbl(onData, onClose);
    const again = await WebSerialConnection.reopen(BAUD, onData, onClose).catch(() => undefined);
    if (again) return again;
    if (!ask) return undefined;
    return WebSerialConnection.request(BAUD, onData, onClose).catch(() => undefined);
};

const machine = new StationMachine(connect);

function openFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".nc,.ngc,.gcode,.gc,.tap,.txt";
    input.multiple = true;
    input.onchange = async () => {
        for (const file of input.files ?? [])
            machine.addJob(file.name.replace(/\.[^.]+$/, ""), await file.text(), "file");
    };
    input.click();
}

const ui = new StationUi(
    machine,
    openFile,
    () => {
        ask = true;
        void machine.connect().finally(() => (ask = false));
    },
    demo ? demoWifi() : serverWifi(),
    demo ? demoDisplay() : serverDisplay(),
);

// a file dropped on the screen joins the queue
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
    e.preventDefault();
    for (const file of e.dataTransfer?.files ?? []) {
        machine.addJob(file.name.replace(/\.[^.]+$/, ""), await file.text(), "file");
        ui.toast(`📥 ${file.name}`);
    }
});

if (demo) {
    machine.addJob("Демо: карман 80×50", demoProgram(), "file");
    setTimeout(() => {
        machine.addJob("Крышка корпуса (с ноутбука)", demoProgram(), "network");
        ui.toast("📥 Новое задание с ноутбука");
    }, 6000);
}

// reconnect by itself: at start and every few seconds while the controller is away
void machine.connect();
setInterval(() => {
    if (!machine.connected) void machine.connect();
}, 3000);
