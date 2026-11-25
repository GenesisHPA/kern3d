// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** What a gamepad button can do on the station. */
export type PadAction =
    | "stop"
    | "hold"
    | "start"
    | "home"
    | "yPlus"
    | "yMinus"
    | "xMinus"
    | "xPlus"
    | "zPlus"
    | "zMinus"
    | "stepUp"
    | "stepDown"
    | "zeroXY"
    | "zeroZ";

/** The actions in the order the settings list them, with their names. */
export const PAD_ACTIONS: readonly [PadAction, string][] = [
    ["stop", "Стоп (нажать — пауза, держать 1 с — стоп)"],
    ["hold", "Пауза"],
    ["start", "Старт (удерживать 1 с)"],
    ["home", "Домой"],
    ["yPlus", "Y+ на шаг"],
    ["yMinus", "Y− на шаг"],
    ["xMinus", "X− на шаг"],
    ["xPlus", "X+ на шаг"],
    ["zPlus", "Z+ на шаг"],
    ["zMinus", "Z− на шаг"],
    ["stepUp", "Шаг больше"],
    ["stepDown", "Шаг меньше"],
    ["zeroXY", "Обнулить X и Y"],
    ["zeroZ", "Обнулить Z"],
];

/** A button number for each action; −1 = none. */
export type PadMap = Record<PadAction, number>;

/** This station's Switch-style pad (B 0, A 1, Y 2, X 3, L 4, R 5, − 8, + 9, d-pad 12–15). */
export const DEFAULT_PAD_MAP: PadMap = {
    stop: 0,
    hold: 2,
    start: 9,
    home: 8,
    yPlus: 12,
    yMinus: 13,
    xMinus: 14,
    xPlus: 15,
    zPlus: 5,
    zMinus: 4,
    stepUp: -1,
    stepDown: -1,
    zeroXY: -1,
    zeroZ: -1,
};

const KEY = "kern3d.station.padmap";

let current: PadMap = load();

function load(): PadMap {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<PadMap>;
        const map = { ...DEFAULT_PAD_MAP };
        for (const [action] of PAD_ACTIONS)
            if (typeof saved[action] === "number") map[action] = saved[action] as number;
        return map;
    } catch {
        return { ...DEFAULT_PAD_MAP };
    }
}

export function padMap(): PadMap {
    return current;
}

/** Puts `button` on `action`; the action that had it before loses it (one button, one action). */
export function assign(action: PadAction, button: number): PadMap {
    const next = { ...current };
    for (const [a] of PAD_ACTIONS) if (next[a] === button) next[a] = -1;
    next[action] = button;
    return save(next);
}

export function clearAction(action: PadAction): PadMap {
    return save({ ...current, [action]: -1 });
}

export function resetPadMap(): PadMap {
    return save({ ...DEFAULT_PAD_MAP });
}

function save(map: PadMap): PadMap {
    current = map;
    localStorage.setItem(KEY, JSON.stringify(map));
    return map;
}

/** While a button is being chosen in the settings, presses do nothing to the machine. */
export const padCapture = { active: false };

/** A button's usual name on this station's pad, for the list. */
const NAMES: Record<number, string> = {
    0: "B",
    1: "A",
    2: "Y",
    3: "X",
    4: "L",
    5: "R",
    6: "ZL",
    7: "ZR",
    8: "−",
    9: "+",
    10: "L-стик",
    11: "R-стик",
    12: "↑",
    13: "↓",
    14: "←",
    15: "→",
    16: "Дом",
    17: "○",
};

export function buttonName(button: number): string {
    if (button < 0) return "—";
    return NAMES[button] ? `${NAMES[button]} · ${button}` : `кнопка ${button}`;
}
