// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { GamepadJog } from "@chili3d/app/src/cam/camNet";
import { WebSerialConnection } from "@chili3d/app/src/laser/webSerial";
import { demoBt, serverBt } from "./btPanel";
import { DemoGrbl, demoProgram } from "./demoGrbl";
import { useServerPads } from "./serverPads";
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

// joysticks the browser leaves out, read by the station server from Linux
if (!demo) useServerPads();

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
    demo ? demoBt() : serverBt(),
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

/**
 * Jogging with a gamepad (Bluetooth or USB): left stick X/Y, right stick (or ZL/ZR) Z, the
 * deflection sets the speed; the d-pad moves X/Y and L/R move Z by the step chosen on screen.
 * The buttons as on this station's Switch-style pad: B stop, Y hold, + start (held for a second,
 * like «Старт» on screen), − home.
 */
const PAD = { stop: 0, hold: 2, start: 9, home: 8, up: 12, down: 13, left: 14, right: 15, zUp: 5, zDown: 4 };
const START_HOLD_MS = 1000;
const firstPad = () => [...(navigator.getGamepads?.() ?? [])].find((p) => p);
const gamepadJog = new GamepadJog(
    (line) => machine.jogLine(line),
    () => machine.jogStop(),
    () => 3000,
    () => false,
    (button) => {
        if (button === "stop") machine.stop();
        else if (button === "hold") machine.pause();
        else
            setTimeout(() => {
                if (firstPad()?.buttons[PAD.start]?.pressed && !machine.start())
                    ui.toast("Нечего запускать или станок занят");
            }, START_HOLD_MS);
    },
    { stop: PAD.stop, hold: PAD.hold, start: PAD.start },
);

/** The d-pad and the shoulder buttons: one step per press, the step chosen on the screen. */
let lastPressed: boolean[] = [];
setInterval(() => {
    const pad = firstPad();
    if (!pad) return;
    const pressed = pad.buttons.map((b) => b.pressed);
    const edge = (i: number) => pressed[i] && !lastPressed[i];
    const step = ui.jogStep || 1; // continuous (0) is the sticks' job: a press steps 1 mm
    if (edge(PAD.up)) machine.jog("Y", 1, step);
    if (edge(PAD.down)) machine.jog("Y", -1, step);
    if (edge(PAD.left)) machine.jog("X", -1, step);
    if (edge(PAD.right)) machine.jog("X", 1, step);
    if (edge(PAD.zUp)) machine.jog("Z", 1, step);
    if (edge(PAD.zDown)) machine.jog("Z", -1, step);
    if (edge(PAD.home)) machine.home();
    lastPressed = pressed;
}, 50);

addEventListener("gamepadconnected", (e) => {
    gamepadJog.start();
    ui.toast(`🎮 ${e.gamepad.id.replace(/\s*\(.*\)\s*/, "")}`);
});
addEventListener("gamepaddisconnected", () => {
    if (!firstPad()) gamepadJog.stop();
});
