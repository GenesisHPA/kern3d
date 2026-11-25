// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type BtApi, BtPanel } from "./btPanel";
import { type WifiApi, WifiPanel } from "./wifiPanel";

export type Layout = "auto" | "portrait" | "landscape";
export type Rotation = 0 | 90 | 180 | 270;

const LAYOUT_KEY = "kern3d.station.layout";

/** The layout asked for: `?layout=` first (for trying), then the saved choice. */
export function savedLayout(): Layout {
    const asked = new URLSearchParams(location.search).get("layout");
    const value = asked ?? localStorage.getItem(LAYOUT_KEY) ?? "auto";
    return value === "portrait" || value === "landscape" ? value : "auto";
}

/** Portrait or landscape for a choice: «auto» by the window's shape. */
export function resolveLayout(
    layout: Layout,
    width = innerWidth,
    height = innerHeight,
): "portrait" | "landscape" {
    if (layout !== "auto") return layout;
    return width > height ? "landscape" : "portrait";
}

/** The station server's screen rotation (cage -r), a fake in `?demo`. */
export interface DisplayApi {
    rotation(): Promise<Rotation>;
    rotate(to: Rotation): Promise<Rotation>;
}

export function serverDisplay(base = ""): DisplayApi {
    return {
        rotation: async () =>
            ((await (await fetch(`${base}/api/display`)).json()) as { rotate: Rotation }).rotate,
        rotate: async (to) => {
            const r = await fetch(`${base}/api/display`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ rotate: to }),
            });
            return ((await r.json()) as { rotate: Rotation }).rotate;
        },
    };
}

export function demoDisplay(): DisplayApi {
    let current: Rotation = 0;
    return {
        rotation: async () => current,
        rotate: async (to) => (current = to),
    };
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
}

/** A row of mutually exclusive choices; returns the row and a setter for the shown one. */
function choices<T extends string | number>(
    options: readonly [T, string][],
    onPick: (value: T) => void,
): [HTMLElement, (value: T) => void] {
    const row = h("div", "choices");
    const buttons = options.map(([value, label]) => {
        const b = h("button", "choice", label);
        b.onclick = () => {
            set(value);
            onPick(value);
        };
        row.append(b);
        return [value, b] as const;
    });
    const set = (value: T) => {
        for (const [v, b] of buttons) b.classList.toggle("on", v === value);
    };
    return [row, set];
}

/**
 * ⚙ Settings: a sheet sliding up over the station screen, with sections — Wi-Fi, Bluetooth (the
 * gamepad), Экран (layout and rotation).
 */
export class SettingsSheet {
    private readonly sheet = h("div", "sheet");
    private readonly tabs = h("div", "choices tabs");
    private readonly body = h("div", "sheetBody");
    private readonly sections = new Map<string, { el: HTMLElement; show: () => void; hide?: () => void }>();
    private current = "";

    constructor(
        host: HTMLElement,
        wifi: WifiApi,
        bt: BtApi,
        private readonly display: DisplayApi,
        private readonly onLayout: (layout: Layout) => void,
        toast: (text: string) => void,
    ) {
        const close = h("button", "sheetClose", "✕");
        close.onclick = () => this.hide();
        const head = h("div", "sheetHead");
        head.append(h("div", "sheetTitle", "Настройки"), close);
        this.sheet.append(head, this.tabs, this.body);
        host.append(this.sheet);

        const wifiEl = h("div", "section");
        const wifiPanel = new WifiPanel(wifiEl, wifi, toast);
        this.add(
            "wifi",
            "Wi-Fi",
            wifiEl,
            () => wifiPanel.show(),
            () => wifiPanel.hide(),
        );
        const btEl = h("div", "section");
        const btPanel = new BtPanel(btEl, bt, toast);
        this.add(
            "bt",
            "Bluetooth",
            btEl,
            () => btPanel.show(),
            () => btPanel.hide(),
        );
        this.add("screen", "Экран", this.screenSection(), () => {});
        this.open("wifi");
    }

    private add(id: string, label: string, el: HTMLElement, show: () => void, hide?: () => void) {
        const tab = h("button", "choice", label);
        tab.onclick = () => this.open(id);
        tab.dataset["id"] = id;
        this.tabs.append(tab);
        el.hidden = true;
        this.body.append(el);
        this.sections.set(id, { el, show, hide });
    }

    private open(id: string) {
        this.sections.get(this.current)?.hide?.();
        this.current = id;
        for (const [key, s] of this.sections) s.el.hidden = key !== id;
        for (const t of this.tabs.children) t.classList.toggle("on", (t as HTMLElement).dataset["id"] === id);
        if (this.sheet.classList.contains("open")) this.sections.get(id)?.show();
    }

    show() {
        this.sheet.classList.add("open");
        this.sections.get(this.current)?.show();
    }

    hide() {
        this.sheet.classList.remove("open");
        this.sections.get(this.current)?.hide?.();
    }

    private screenSection(): HTMLElement {
        const el = h("div", "section");
        const [layoutRow, setLayout] = choices<Layout>(
            [
                ["auto", "Авто"],
                ["portrait", "Вертикально"],
                ["landscape", "Горизонтально"],
            ],
            (value) => {
                localStorage.setItem(LAYOUT_KEY, value);
                this.onLayout(value);
            },
        );
        setLayout(savedLayout());
        const [rotateRow, setRotate] = choices<Rotation>(
            [
                [0, "0°"],
                [90, "90°"],
                [180, "180°"],
                [270, "270°"],
            ],
            (value) => void this.display.rotate(value).then(setRotate),
        );
        void this.display.rotation().then(setRotate, () => {});
        el.append(
            h("div", "label", "Раскладка пульта"),
            layoutRow,
            h(
                "p",
                "hint",
                "«Авто» выбирает по форме экрана: широкий — горизонтальная, высокий — вертикальная.",
            ),
            h("div", "label", "Поворот изображения"),
            rotateRow,
            h(
                "p",
                "hint",
                "Для экрана, установленного боком (дисплей Tesla вертикально — 90°). Экран погаснет на пару секунд.",
            ),
        );
        return el;
    }
}
