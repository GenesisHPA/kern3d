// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ProbeSettings, storeProbeSettings } from "@chili3d/app/src/cam/camProbe";
import type { StationMachine } from "./stationMachine";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
}

const fmt = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3);

/**
 * Settings → Инструмент: the tool length sensor (where it is, on or off), the tool change place,
 * the safe height, the probing speeds; the reference tool measured, the offset applied now.
 * Places are machine coordinates — «📍 Отсюда» takes where the spindle is.
 */
export class ToolPanel {
    private readonly status = h("div", "wifiInfo");
    private readonly fields: (() => void)[] = [];
    private timer?: ReturnType<typeof setInterval>;

    constructor(
        host: HTMLElement,
        private readonly machine: StationMachine,
        private readonly toast: (text: string) => void,
    ) {
        const p = () => machine.probe;
        const save = (change: (s: ProbeSettings) => void) => {
            const next = structuredClone(machine.probe);
            change(next);
            machine.probe = next;
            storeProbeSettings(next);
            this.refresh();
        };

        const onOff = h("div", "choices");
        const on = h("button", "choice", "Датчик есть");
        const off = h("button", "choice", "Датчика нет");
        on.onclick = () => save((s) => (s.setter.enabled = true));
        off.onclick = () => save((s) => (s.setter.enabled = false));
        onOff.append(on, off);
        this.fields.push(() => {
            on.classList.toggle("on", p().setter.enabled);
            off.classList.toggle("on", !p().setter.enabled);
        });

        const measure = h("button", "sheetBtn primary", "Замерить эталон");
        measure.onclick = () => {
            this.toast("Замер фрезы на датчике…");
            machine
                .measureReference()
                .then((z) => this.toast(`Эталон: Z ${fmt(z)}`))
                .catch((e) => this.toast(`Замер не удался: ${e instanceof Error ? e.message : String(e)}`));
        };
        const bar = h("div", "sectionBar");
        bar.append(this.status, measure);

        host.append(
            bar,
            h("div", "label", "Датчик длины инструмента"),
            onOff,
            this.place("Где датчик (X, Y — над ним; Z — откуда начинать поиск)", (s) => s.setter, save),
            h("div", "label", "Точка смены инструмента"),
            this.place("Куда станок отъезжает для замены фрезы", (s) => s.change, save),
            h("div", "label", "Высоты и скорости"),
            this.numbers(
                [
                    ["Безопасная Z (машинная)", (s) => s.safeZ, (s, v) => (s.safeZ = v)],
                    ["Поиск, мм/мин", (s) => s.seekFeed, (s, v) => (s.seekFeed = v)],
                    ["Точно, мм/мин", (s) => s.latchFeed, (s, v) => (s.latchFeed = v)],
                    ["Ход поиска, мм", (s) => s.travel, (s, v) => (s.travel = v)],
                ],
                save,
            ),
            h(
                "p",
                "hint",
                "Эталон — фреза, которой ставили ноль Z. Его замеряют один раз после обнуления Z (или станок " +
                    "сам замерит перед заданием). Каждая следующая фреза — плановая смена или экстренная замена — " +
                    "меряется на датчике, и разница учитывается: ноль детали не теряется. Новый ноль Z сбрасывает эталон.",
            ),
        );
    }

    /** X / Y / Z of a place (machine coordinates) and «📍 Отсюда». */
    private place(
        title: string,
        of: (s: ProbeSettings) => { x: number; y: number; z: number },
        save: (change: (s: ProbeSettings) => void) => void,
    ): HTMLElement {
        const box = h("div", "toolPlace");
        const row = this.numbers(
            (["x", "y", "z"] as const).map(
                (k) =>
                    [
                        k.toUpperCase(),
                        (s: ProbeSettings) => of(s)[k],
                        (s: ProbeSettings, v: number) => (of(s)[k] = v),
                    ] as const,
            ),
            save,
        );
        const here = h("button", "sheetBtn", "📍 Отсюда");
        here.onclick = () => {
            const m = this.machine.snapshot().status.mpos;
            if (!m) {
                this.toast("Нет позиции: станок не подключён");
                return;
            }
            save((s) => {
                const t = of(s);
                [t.x, t.y, t.z] = [m[0], m[1], m[2]];
            });
        };
        box.append(h("div", "hint", title), row, here);
        return box;
    }

    private numbers(
        items: readonly (readonly [
            string,
            (s: ProbeSettings) => number,
            (s: ProbeSettings, v: number) => void,
        ])[],
        save: (change: (s: ProbeSettings) => void) => void,
    ): HTMLElement {
        const row = h("div", "toolNums");
        for (const [label, get, set] of items) {
            const input = h("input");
            input.type = "number";
            input.step = "any";
            input.inputMode = "decimal";
            input.onchange = () => {
                const v = Number(input.value.replace(",", "."));
                if (Number.isFinite(v)) save((s) => set(s, v));
            };
            this.fields.push(() => {
                if (document.activeElement !== input) input.value = String(get(this.machine.probe));
            });
            const l = h("label", "toolNum");
            l.append(h("span", "", label), input);
            row.append(l);
        }
        return row;
    }

    private refresh() {
        for (const f of this.fields) f();
        const s = this.machine.snapshot();
        this.status.textContent = !this.machine.probe.setter.enabled
            ? "Без датчика: после смены фрезы Z обнуляется вручную"
            : s.reference === undefined
              ? "Эталон не замерен — замерится перед заданием"
              : `Эталон Z ${fmt(s.reference)} · поправка ${s.offset >= 0 ? "+" : ""}${fmt(s.offset)}`;
    }

    show() {
        this.refresh();
        clearInterval(this.timer);
        this.timer = setInterval(() => this.refresh(), 1000);
    }

    hide() {
        clearInterval(this.timer);
    }
}
