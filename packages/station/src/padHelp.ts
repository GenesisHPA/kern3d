// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { buttonName, PAD_ACTIONS, padMap } from "./padMap";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
}

/** What every gamepad control does, as set now: the sticks, then each assigned button. */
export function padHelp(): HTMLElement {
    const box = h("div", "helpBox");
    const table = (rows: [string, string][]) => {
        const t = h("div", "helpTable");
        for (const [key, what] of rows) t.append(h("span", "helpKey", key), h("span", "helpWhat", what));
        return t;
    };
    box.append(
        h("div", "label", "Стики — плавное движение"),
        table([
            [
                "Левый стик",
                "X влево-вправо, Y вперёд-назад. Чем сильнее отклонение, тем быстрее (до 3000 мм/мин).",
            ],
            ["Правый стик ↑↓", "Z вверх-вниз, так же плавно."],
            ["ZR / ZL", "Z вверх / вниз, если правый стик не трогать (сила нажатия = скорость)."],
            ["Отпустить", "Станок останавливается сразу."],
        ]),
    );
    const map = padMap();
    const assigned = PAD_ACTIONS.filter(([action]) => map[action] >= 0).map(
        ([action, label]) => [buttonName(map[action]), label] as [string, string],
    );
    box.append(
        h("div", "label", "Кнопки — как назначено сейчас"),
        assigned.length > 0 ? table(assigned) : h("p", "hint", "Ни одна кнопка не назначена."),
        h(
            "p",
            "hint",
            "Изменить: ⚙ → Джойстик. «На шаг» — сдвиг на шаг, выбранный на экране (0,01 / 0,1 / 1 / 10 мм).",
        ),
        h("div", "label", "Безопасность"),
        table([
            ["Во время работы", "Стики и кнопки перемещения не действуют, пока идёт программа."],
            ["Старт", "Только удержанием 1 секунду — случайное нажатие не запустит станок."],
            ["Стоп", "Останавливает всё сразу: программу, перемещение, шпиндель."],
            ["Тревога", "После тревоги удерживайте «Старт» на экране — «Разблокировать»."],
        ]),
    );
    return box;
}
