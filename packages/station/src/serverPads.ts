// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** A joystick as the station server reads it from Linux (GET /api/gamepad/events). */
interface ServerPad {
    id: string;
    axes: number[];
    buttons: number[];
}

/**
 * Gamepads the browser does not show — Chromium leaves out some (a Switch-style clone over
 * Bluetooth with vendor 0000) — read by the station server from Linux and streamed here. They
 * are merged into `navigator.getGamepads()`, with `gamepadconnected` / `gamepaddisconnected`,
 * so the rest of the page (the jog, the test in settings) treats them like any gamepad.
 */
export function useServerPads(url = "/api/gamepad/events") {
    const native = navigator.getGamepads?.bind(navigator);
    let pads: Gamepad[] = [];
    const toGamepad = (p: ServerPad, index: number): Gamepad =>
        ({
            id: `${p.id} (station)`,
            index,
            connected: true,
            mapping: "",
            timestamp: performance.now(),
            axes: p.axes,
            buttons: p.buttons.map((v) => ({ pressed: v > 0.5, touched: v > 0.5, value: v })),
            vibrationActuator: null,
            hapticActuators: [],
        }) as unknown as Gamepad;

    navigator.getGamepads = () => {
        const browser = native ? [...native()].filter((p): p is Gamepad => p !== null) : [];
        return (browser.length > 0 ? browser : pads) as (Gamepad | null)[];
    };

    const announce = (type: "gamepadconnected" | "gamepaddisconnected", gamepad: Gamepad) => {
        const e = new Event(type);
        Object.defineProperty(e, "gamepad", { value: gamepad });
        dispatchEvent(e);
    };

    const source = new EventSource(url);
    source.onmessage = (m) => {
        const next = (JSON.parse(m.data) as ServerPad[]).map(toGamepad);
        const before = new Set(pads.map((p) => p.id));
        const after = new Set(next.map((p) => p.id));
        for (const p of next) if (!before.has(p.id)) announce("gamepadconnected", p);
        for (const p of pads) if (!after.has(p.id)) announce("gamepaddisconnected", p);
        pads = next;
    };
}
