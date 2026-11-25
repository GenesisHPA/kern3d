// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    controllerHasA,
    fluidncLines,
    type RotarySettings,
    rotary,
    setRotary,
    stepsPerDegree,
    surfacePerDegree,
} from "./rotary";
import type { StationMachine } from "./stationMachine";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
}

/**
 * Settings → 4-я ось: on the table or not, which axis it lies along, the motor, microstepping and
 * reduction (→ steps per degree), its speed and acceleration, the stock diameter; «Записать в
 * контроллер» sends them to a FluidNC board (GRBL on a Nano has only three axes).
 */
export class RotaryPanel {
    private readonly calc = h("div", "rotaryCalc");
    private readonly ctrl = h("div", "wifiInfo");
    private readonly refreshers: (() => void)[] = [];
    private timer?: ReturnType<typeof setInterval>;

    constructor(
        host: HTMLElement,
        private readonly machine: StationMachine,
        private readonly toast: (text: string) => void,
    ) {
        const save = (change: (s: RotarySettings) => void) => {
            const next = { ...rotary() };
            change(next);
            setRotary(next);
            this.refresh();
        };
        const pick = <T extends string | boolean>(
            options: [T, string][],
            get: () => T,
            set: (v: T) => void,
        ) => {
            const row = h("div", "choices");
            for (const [value, label] of options) {
                const b = h("button", "choice", label);
                b.onclick = () => set(value);
                this.refreshers.push(() => b.classList.toggle("on", get() === value));
                row.append(b);
            }
            return row;
        };
        const write = h("button", "sheetBtn primary", "Записать в контроллер");
        write.onclick = () => {
            const firmware = this.machine.snapshot().firmware;
            if (!controllerHasA(firmware)) {
                this.toast(
                    "Этот контроллер не знает 4-й оси (GRBL — только X, Y, Z). Нужна плата на FluidNC.",
                );
                return;
            }
            this.machine
                .sendLines(fluidncLines(rotary()))
                .then(() => this.toast("Ось A записана в контроллер"))
                .catch((e) => this.toast(`Не записалось: ${e instanceof Error ? e.message : String(e)}`));
        };
        const bar = h("div", "sectionBar");
        bar.append(this.ctrl, write);

        host.append(
            bar,
            h("div", "label", "Поворотная ось"),
            pick<boolean>(
                [
                    [true, "Установлена"],
                    [false, "Снята"],
                ],
                () => rotary().installed,
                (v) => save((s) => (s.installed = v)),
            ),
            h("div", "label", "Лежит вдоль оси"),
            pick<"X" | "Y">(
                [
                    ["X", "Вдоль X"],
                    ["Y", "Вдоль Y"],
                ],
                () => rotary().along,
                (v) => save((s) => (s.along = v)),
            ),
            h("div", "label", "Мотор и редуктор"),
            this.numbers(
                [
                    ["Шагов на оборот", "stepsPerRev"],
                    ["Микрошаг", "microsteps"],
                    ["Передаточное (1:N)", "ratio"],
                ],
                save,
            ),
            h("div", "label", "Скорость"),
            this.numbers(
                [
                    ["Макс., °/мин", "maxRate"],
                    ["Ускорение, °/с²", "accel"],
                    ["Диаметр заготовки, мм", "diameter"],
                ],
                save,
            ),
            this.calc,
            h(
                "p",
                "hint",
                "Передаточное: сколько оборотов мотора на один оборот патрона — 1 для прямого, 4 для ремня 1:4, " +
                    "90 для червяка 1:90. Направление вращения меняется в конфиге платы (пин направления «:low»). " +
                    "Пока ось снята, на экране её нет; программы с A не запускайте.",
            ),
        );
    }

    private numbers(
        items: [string, "stepsPerRev" | "microsteps" | "ratio" | "maxRate" | "accel" | "diameter"][],
        save: (change: (s: RotarySettings) => void) => void,
    ): HTMLElement {
        const row = h("div", "toolNums");
        for (const [label, key] of items) {
            const input = h("input");
            input.type = "number";
            input.step = "any";
            input.inputMode = "decimal";
            input.onchange = () => {
                const v = Number(input.value.replace(",", "."));
                if (Number.isFinite(v) && v > 0) save((s) => (s[key] = v));
                else this.refresh();
            };
            this.refreshers.push(() => {
                if (document.activeElement !== input) input.value = String(rotary()[key]);
            });
            const l = h("label", "toolNum");
            l.append(h("span", "", label), input);
            row.append(l);
        }
        return row;
    }

    private refresh() {
        for (const r of this.refreshers) r();
        const s = rotary();
        const spd = stepsPerDegree(s);
        this.calc.innerHTML =
            `<b>${spd.toFixed(3)}</b> шагов на градус · один шаг = <b>${(1 / spd).toFixed(4)}°</b><br>` +
            `по поверхности Ø${s.diameter}: <b>${surfacePerDegree(s).toFixed(3)}</b> мм на градус · ` +
            `полный оборот за <b>${((360 / s.maxRate) * 60).toFixed(1)}</b> с`;
        const firmware = this.machine.snapshot().firmware;
        this.ctrl.textContent = !firmware
            ? "Контроллер не подключён"
            : controllerHasA(firmware)
              ? `Контроллер: ${firmware.replace(/^Grbl\s*/i, "")} — ось A поддерживается`
              : "Контроллер GRBL: только 3 оси — для A нужна плата на FluidNC";
    }

    show() {
        this.refresh();
        clearInterval(this.timer);
        this.timer = setInterval(() => this.refresh(), 1500);
    }

    hide() {
        clearInterval(this.timer);
    }
}
