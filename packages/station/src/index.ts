// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { GamepadJog } from "@chili3d/app/src/cam/camNet";
import { WebSerialConnection } from "@chili3d/app/src/laser/webSerial";
import { demoBt, serverBt } from "./btPanel";
import { DemoGrbl, demoProgram } from "./demoGrbl";
import { JobStore } from "./jobStore";
import { padCapture, padMap } from "./padMap";
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
const jobs = new JobStore(machine);

function openFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".nc,.ngc,.gcode,.gc,.tap,.txt";
    input.multiple = true;
    input.onchange = async () => {
        for (const file of input.files ?? [])
            jobs.add(file.name.replace(/\.[^.]+$/, ""), await file.text(), "file");
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
        jobs.add(file.name.replace(/\.[^.]+$/, ""), await file.text(), "file");
        ui.toast(`📥 ${file.name}`);
    }
});

if (!demo) void jobs.restore().catch(() => {});
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
 * deflection sets the speed. The buttons are set in ⚙ → Джойстик (padMap.ts): stop, hold, start
 * (held a second, like «Старт» on screen), home, a step on X/Y/Z, the step finer/coarser, zeroing.
 */
const START_HOLD_MS = 1000;
const STOP_HOLD_MS = 1000;

/**
 * The gamepad's «Стоп»: a press is a pause (feed hold — the job carries on with «Старт», a jog is
 * cut short), so a knock on the button spoils nothing; held a second it is the full stop. The
 * screen's «Стоп» stays instant; the real emergency stop is the mushroom button on the machine.
 */
function padStop() {
    const s = machine.snapshot();
    if (s.jobState === "running") machine.pause();
    else machine.jogStop();
    setTimeout(() => {
        if (!firstPad()?.buttons[padMap().stop]?.pressed) {
            if (s.jobState === "running")
                ui.toast("⏸ Пауза — «Старт» продолжит, удержание «Стоп» 1 с — полный стоп");
            return;
        }
        machine.stop();
        ui.toast("■ Стоп");
    }, STOP_HOLD_MS);
}
const firstPad = () => [...(navigator.getGamepads?.() ?? [])].find((p) => p);
const gamepadJog = new GamepadJog(
    (line) => (padCapture.active ? false : machine.jogLine(line)),
    () => machine.jogStop(),
    () => 3000,
    () => padCapture.active,
    (button) => {
        if (padCapture.active) return;
        if (button === "stop") padStop();
        else if (button === "hold") machine.pause();
        else
            setTimeout(() => {
                if (firstPad()?.buttons[padMap().start]?.pressed && !machine.start())
                    ui.toast("Нечего запускать или станок занят");
            }, START_HOLD_MS);
    },
    {
        get stop() {
            return padMap().stop;
        },
        get hold() {
            return padMap().hold;
        },
        get start() {
            return padMap().start;
        },
    },
);

/** The other buttons: one step per press, the step chosen on the screen. */
let lastPressed: boolean[] = [];
setInterval(() => {
    const pad = firstPad();
    if (!pad) return;
    const pressed = pad.buttons.map((b) => b.pressed);
    const map = padMap();
    const edge = (i: number) => i >= 0 && pressed[i] && !lastPressed[i];
    lastPressed = pressed;
    if (padCapture.active) return;
    const step = ui.jogStep || 1; // continuous (0) is the sticks' job: a press steps 1 mm
    if (edge(map.yPlus)) machine.jog("Y", 1, step);
    if (edge(map.yMinus)) machine.jog("Y", -1, step);
    if (edge(map.xMinus)) machine.jog("X", -1, step);
    if (edge(map.xPlus)) machine.jog("X", 1, step);
    if (edge(map.zPlus)) machine.jog("Z", 1, step);
    if (edge(map.zMinus)) machine.jog("Z", -1, step);
    if (edge(map.home)) machine.home();
    if (edge(map.stepUp)) ui.shiftStep(1);
    if (edge(map.stepDown)) ui.shiftStep(-1);
    if (edge(map.zeroXY)) machine.zero(["X", "Y"]);
    if (edge(map.zeroZ)) machine.zero(["Z"]);
}, 50);

addEventListener("gamepadconnected", (e) => {
    gamepadJog.start();
    ui.toast(`🎮 ${e.gamepad.id.replace(/\s*\(.*\)\s*/, "")}`);
});
addEventListener("gamepaddisconnected", () => {
    if (!firstPad()) gamepadJog.stop();
});
