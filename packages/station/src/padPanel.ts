// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    assign,
    buttonName,
    clearAction,
    PAD_ACTIONS,
    type PadAction,
    padCapture,
    padMap,
    resetPadMap,
} from "./padMap";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
}

const firstPad = () => [...(navigator.getGamepads?.() ?? [])].find((p) => p);

/**
 * Settings → Джойстик: every action with its button; «Назначить», then the button pressed on the
 * gamepad becomes that action's (taken off any other action). Presses do nothing to the machine
 * while a button is being chosen.
 */
export class PadPanel {
    private readonly list = h("div", "wifiList");
    private readonly info = h("div", "wifiInfo");
    private waiting?: PadAction;
    private timer?: ReturnType<typeof setInterval>;
    private held: boolean[] = [];

    constructor(
        host: HTMLElement,
        private readonly toast: (text: string) => void,
    ) {
        const reset = h("button", "sheetBtn", "Сбросить");
        reset.onclick = () => {
            resetPadMap();
            this.stopWaiting();
            this.render();
            this.toast("Кнопки джойстика: как было");
        };
        const bar = h("div", "sectionBar");
        bar.append(this.info, reset);
        host.append(bar, this.list);
    }

    show() {
        this.render();
    }

    hide() {
        this.stopWaiting();
    }

    private render() {
        const pad = firstPad();
        this.info.textContent = pad
            ? `🎮 ${pad.id.replace(/\s*\(.*\)\s*/, "")}`
            : "Джойстик не подключён — назначить можно, когда он появится";
        const map = padMap();
        this.list.replaceChildren(
            ...PAD_ACTIONS.map(([action, label]) => {
                const waiting = this.waiting === action;
                const row = h("div", `wifiRow padMapRow${waiting ? " waiting" : ""}`);
                const name = h("div", "wifiName", label);
                const badge = h(
                    "span",
                    `padBadge${map[action] < 0 ? " none" : ""}`,
                    waiting ? "нажмите кнопку…" : buttonName(map[action]),
                );
                const choose = h("button", "sheetBtn", waiting ? "Отмена" : "Назначить");
                choose.onclick = () => (waiting ? this.stopWaiting() : this.wait(action));
                row.append(name, badge, choose);
                if (map[action] >= 0 && !waiting) {
                    const clear = h("button", "sheetBtn", "✕");
                    clear.onclick = () => {
                        clearAction(action);
                        this.render();
                    };
                    row.append(clear);
                }
                return row;
            }),
        );
    }

    /** Waits for a button that was not already held when the wait began. */
    private wait(action: PadAction) {
        this.stopWaiting();
        this.waiting = action;
        padCapture.active = true;
        this.held = firstPad()?.buttons.map((b) => b.pressed) ?? [];
        this.render();
        this.timer = setInterval(() => {
            const pad = firstPad();
            if (!pad) return;
            const pressed = pad.buttons.map((b) => b.pressed);
            const button = pressed.findIndex((p, i) => p && !this.held[i]);
            this.held = pressed;
            if (button < 0) return;
            assign(action, button);
            const label = PAD_ACTIONS.find(([a]) => a === action)?.[1] ?? action;
            this.toast(`${label}: ${buttonName(button)}`);
            this.stopWaiting();
            this.render();
        }, 30);
    }

    private stopWaiting() {
        clearInterval(this.timer);
        this.timer = undefined;
        if (this.waiting) {
            this.waiting = undefined;
            this.render();
        }
        // a moment's grace: the button that was just assigned is still down
        setTimeout(() => (padCapture.active = this.waiting !== undefined), 400);
    }
}
