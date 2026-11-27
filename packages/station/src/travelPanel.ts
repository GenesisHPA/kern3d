// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Axis } from "@chili3d/app/src/cam/machineControl";
import { PINS } from "./grblText";
import type { StationMachine } from "./stationMachine";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
}

/**
 * Settings → Станок: what the controller says (travel, homing, limits) and the travel measured
 * between each axis's two limit switches, then written to the controller. Z asks first: it drives
 * the spindle down to its lower switch.
 */
export class TravelPanel {
    private readonly info = h("div", "rotaryCalc");
    private readonly rows = h("div", "travelRows");
    private readonly found = new Map<Axis, number>();
    private readonly pins = h("div", "pinRow");
    private readonly spindle = h("div", "probeOpts");
    private readonly setter = h("div", "wifiRow");
    private touched?: number;
    private timer?: ReturnType<typeof setInterval>;

    constructor(
        host: HTMLElement,
        private readonly machine: StationMachine,
        private readonly toast: (text: string) => void,
    ) {
        host.append(
            h("div", "label", "Контроллер"),
            this.info,
            h("div", "label", "Шпиндель"),
            this.spindle,
            h("div", "label", "Входы контроллера (горят — замкнуты)"),
            this.pins,
            h(
                "p",
                "hint",
                "Нажмите рукой концевик, щуп, аварийную кнопку — должен загореться свой вход. Горит без нажатия — " +
                    "провод замкнут или концевик нормально-закрытый (инверсия в $5 / $6 / конфиге FluidNC).",
            ),
            h("div", "label", "Датчик длины фрезы (стационарный)"),
            this.setter,
            h(
                "p",
                "hint",
                "Место датчика задаётся в ⚙ → Инструмент («📍 Отсюда»: подведите фрезу над датчиком). " +
                    "Оно в координатах станка, поэтому сначала «Домой». «Проверить» — станок едет к датчику и касается его.",
            ),
            h("div", "label", "Замер хода по концевикам"),
            this.rows,
            h(
                "p",
                "hint",
                "Станок находит ноль, медленно едет до противоположного концевика, запоминает, где тот сработал, " +
                    "затем сбрасывается и снова находит ноль. Ход = до дальнего концевика минус отскок ($27). " +
                    "Нужны концевики на обоих концах оси и включённые в контроллере $21=1 и $22=1.",
            ),
        );
    }

    private render() {
        const s = this.machine.snapshot();
        const m = s.machine;
        const t = m.travel;
        this.info.innerHTML = s.connected
            ? `Ход: <b>${t ? `X ${t[0]} · Y ${t[1]} · Z ${t[2]} мм` : "неизвестен"}</b><br>` +
              `Поиск нуля ${m.homing ? "<b>вкл</b>" : "выкл"} · концевики ${m.hardLimits ? "<b>вкл</b>" : "выкл"} · ` +
              `мягкие пределы ${m.softLimits ? "<b>вкл</b>" : "выкл"} · ${s.homed ? "станок инициализирован" : "ноль не найден"}`
            : "Контроллер не подключён";
        const busy = this.machine.measuring;
        const m0 = this.machine;
        const stopBtn = h(
            "button",
            `choice${m0.stopSpindleOnPause ? " on" : ""}`,
            m0.stopSpindleOnPause ? "Пауза останавливает шпиндель" : "Пауза: шпиндель крутится",
        );
        stopBtn.onclick = () => {
            m0.stopSpindleOnPause = !m0.stopSpindleOnPause;
            saveSpindle(m0);
            this.render();
        };
        const spin = (d: number) => {
            const b = h("button", "sheetBtn", d > 0 ? `+${d}` : String(d));
            b.onclick = () => {
                m0.spinUp = Math.max(0, Math.min(30, m0.spinUp + d));
                saveSpindle(m0);
                this.render();
            };
            return b;
        };
        this.spindle.replaceChildren(
            stopBtn,
            h("span", "hint", "Разгон после M3/M4:"),
            spin(-1),
            h("b", "", `${m0.spinUp} с`),
            spin(1),
        );
        const on = s.status.pins ?? "";
        this.pins.replaceChildren(
            ...PINS.map(([key, label]) =>
                h("span", `pin${on.includes(key) ? " on" : ""}`, `${key} · ${label}`),
            ),
        );
        const sp = this.machine.probe.setter;
        const name = h(
            "div",
            "wifiName",
            sp.enabled ? `X ${sp.x} · Y ${sp.y} · начало поиска Z ${sp.z}` : "Датчик выключен",
        );
        const inside =
            !t || (sp.x >= -t[0] && sp.x <= 0 && sp.y >= -t[1] && sp.y <= 0 && sp.z >= -t[2] && sp.z <= 0);
        name.append(
            h(
                "small",
                "",
                busy?.stage === "касание датчика длины"
                    ? "⏳ касается датчика…"
                    : !inside
                      ? "⚠ место вне хода станка"
                      : this.touched !== undefined
                        ? `коснулся на Z ${this.touched.toFixed(3)} (машинные)`
                        : "",
            ),
        );
        const check = h("button", "sheetBtn", "Проверить");
        check.disabled = !sp.enabled || busy !== undefined || !s.connected;
        check.onclick = () =>
            this.machine
                .checkSetter()
                .then((z) => {
                    this.touched = z;
                    this.toast(`Датчик на месте: касание на Z ${z.toFixed(3)}`);
                    this.render();
                })
                .catch((e) => this.toast(`⚠ ${e instanceof Error ? e.message : String(e)}`));
        this.setter.replaceChildren(name, check);
        this.rows.replaceChildren(
            ...(["X", "Y", "Z"] as Axis[]).map((axis, i) => {
                const row = h("div", "wifiRow");
                const name = h("div", "wifiName", `Ось ${axis}`);
                const now = t ? `сейчас ${t[i]} мм` : "";
                const got = this.found.get(axis);
                name.append(
                    h(
                        "small",
                        "",
                        busy?.axis === axis
                            ? `⏳ ${busy.stage}`
                            : got !== undefined
                              ? `замерено ${got} мм · ${now}`
                              : now,
                    ),
                );
                const go = h("button", "sheetBtn", "Замерить");
                go.disabled = busy !== undefined || !s.connected;
                go.onclick = () => {
                    if (axis === "Z" && !armZ(this.toast)) return;
                    this.machine
                        .measureTravel(axis)
                        .then((r) => {
                            this.found.set(axis, r.travel);
                            this.toast(`Ход ${axis}: ${r.travel} мм (концевик на ${r.trippedAt})`);
                            this.render();
                        })
                        .catch((e) => this.toast(`⚠ ${e instanceof Error ? e.message : String(e)}`));
                };
                row.append(name, go);
                if (got !== undefined) {
                    const write = h("button", "sheetBtn primary", "Записать");
                    write.disabled = busy !== undefined;
                    write.onclick = () =>
                        this.machine
                            .setTravel(axis, got)
                            .then(() => this.toast(`Ход ${axis} = ${got} мм записан в контроллер`))
                            .catch((e) => this.toast(`⚠ ${e instanceof Error ? e.message : String(e)}`));
                    row.append(write);
                }
                return row;
            }),
        );
    }

    show() {
        zConfirmed = false;
        this.render();
        clearInterval(this.timer);
        this.timer = setInterval(() => this.render(), 700);
    }

    hide() {
        clearInterval(this.timer);
    }
}

/** Z goes down to its lower switch: the first press only warns, the second within 5 s measures. */
let zConfirmed = false;
let zTimer: ReturnType<typeof setTimeout> | undefined;
export function armZ(toast: (t: string) => void): boolean {
    if (zConfirmed) return true;
    zConfirmed = true;
    clearTimeout(zTimer);
    zTimer = setTimeout(() => (zConfirmed = false), 5000);
    toast(
        "⚠ Z поедет вниз до нижнего концевика: уберите фрезу и всё из-под шпинделя. Нажмите «Замерить» ещё раз.",
    );
    return false;
}

const SPINDLE_KEY = "kern3d.station.spindle";

export function saveSpindle(m: StationMachine) {
    localStorage.setItem(SPINDLE_KEY, JSON.stringify({ stop: m.stopSpindleOnPause, spinUp: m.spinUp }));
}

/** The spindle settings kept on the station, put on the machine at start. */
export function loadSpindle(m: StationMachine) {
    try {
        const v = JSON.parse(localStorage.getItem(SPINDLE_KEY) ?? "null") as {
            stop?: boolean;
            spinUp?: number;
        } | null;
        if (typeof v?.stop === "boolean") m.stopSpindleOnPause = v.stop;
        if (typeof v?.spinUp === "number") m.spinUp = v.spinUp;
    } catch {}
}
