// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n } from "@chili3d/core";
import type { GrblTransport } from "../laser/grblController";
import { toBytes } from "../laser/webSerial";
import { type Axis, jogLine } from "./machineControl";

/**
 * grblHAL over the network: its WebSocket server (networking plugin, port 81 by default)
 * carries the same text stream as USB; realtime bytes go as they are.
 */
export class WebSocketConnection implements GrblTransport {
    private constructor(
        private readonly ws: WebSocket,
        private readonly onData: (text: string) => void,
        private readonly onClose: () => void,
    ) {
        ws.binaryType = "arraybuffer";
        ws.onmessage = (e) => {
            const text =
                typeof e.data === "string"
                    ? e.data
                    : String.fromCharCode(...new Uint8Array(e.data as ArrayBuffer));
            this.onData(text);
        };
        ws.onclose = () => this.onClose();
    }

    /** `192.168.1.50`, `192.168.1.50:81` or a full `ws://…` address. */
    static address(text: string): string {
        const t = text.trim();
        if (/^wss?:\/\//i.test(t)) return t;
        return /:\d+$/.test(t) ? `ws://${t}` : `ws://${t}:81`;
    }

    static open(
        address: string,
        onData: (text: string) => void,
        onClose: () => void,
    ): Promise<WebSocketConnection> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(WebSocketConnection.address(address), ["arduino"]);
            const timer = setTimeout(() => {
                ws.close();
                reject(new Error("timeout"));
            }, 5000);
            ws.onopen = () => {
                clearTimeout(timer);
                resolve(new WebSocketConnection(ws, onData, onClose));
            };
            ws.onerror = () => {
                clearTimeout(timer);
                reject(
                    new Error(
                        I18n.translate("error.app.noConnection{0}", WebSocketConnection.address(address)),
                    ),
                );
            };
        });
    }

    async write(data: string): Promise<void> {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(new Uint8Array(toBytes(data)));
    }

    async close(): Promise<void> {
        this.ws.close();
    }
}

/**
 * Jogging from a gamepad: the left stick moves X / Y, the right stick (or the triggers) Z,
 * speed growing with the deflection. Short jogs are streamed while the stick is held (the
 * way GRBL's jogging is meant to be driven) and cancelled when it is let go.
 */
export class GamepadJog {
    private timer: ReturnType<typeof setInterval> | undefined;
    private moving = false;
    /** Stick deflection under this counts as centred. */
    static readonly DEAD = 0.15;
    static readonly TICK = 0.1;

    constructor(
        private readonly send: (line: string) => boolean,
        private readonly cancel: () => void,
        private readonly maxFeed: () => number,
        private readonly busy: () => boolean,
        private readonly onButton: (name: "stop" | "hold" | "start") => void,
    ) {}

    get active(): boolean {
        return this.timer !== undefined;
    }

    start() {
        if (this.timer) return;
        let last: boolean[] = [];
        this.timer = setInterval(() => {
            const pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p);
            if (!pad) return;
            const pressed = pad.buttons.map((b) => b.pressed);
            // B (1) stop, X (2) hold, Y (3) start — on press only
            if (pressed[1] && !last[1]) this.onButton("stop");
            if (pressed[2] && !last[2]) this.onButton("hold");
            if (pressed[3] && !last[3]) this.onButton("start");
            last = pressed;
            const z =
                Math.abs(pad.axes[3] ?? 0) > GamepadJog.DEAD
                    ? -(pad.axes[3] ?? 0)
                    : (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
            const line = GamepadJog.tick(pad.axes[0] ?? 0, -(pad.axes[1] ?? 0), z, this.maxFeed());
            if (line) {
                if (!this.busy()) this.moving = this.send(line) || this.moving;
            } else if (this.moving) {
                this.moving = false;
                this.cancel();
            }
        }, GamepadJog.TICK * 1000);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        if (this.moving) this.cancel();
        this.moving = false;
    }

    /** One tick's jog for these deflections (−1…1), a little longer than a tick so moves join up. */
    static tick(x: number, y: number, z: number, maxFeed: number): string | undefined {
        const d = (v: number) => (Math.abs(v) < GamepadJog.DEAD ? 0 : v);
        const v = { X: d(x), Y: d(y), Z: d(z) };
        const mag = Math.max(Math.abs(v.X), Math.abs(v.Y), Math.abs(v.Z));
        if (mag === 0) return undefined;
        const feed = maxFeed * mag * mag;
        const len = (feed / 60) * GamepadJog.TICK * 1.3;
        const norm = Math.hypot(v.X, v.Y, v.Z);
        const moves: Partial<Record<Axis, number>> = {};
        for (const a of ["X", "Y", "Z"] as const) if (v[a] !== 0) moves[a] = (v[a] / norm) * len;
        return jogLine(moves, feed);
    }
}
