// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type BtApi, BtPanel } from "./btPanel";
import { padHelp } from "./padHelp";
import { PadPanel } from "./padPanel";
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

export interface NetStatus {
    kind: "wifi" | "ethernet" | "none";
    name: string;
    ip: string;
    signal: number;
    host: string;
}

export interface TimeStatus {
    now: string;
    timezone: string;
    ntp: boolean;
    synced: boolean;
    ok?: boolean;
    error?: string;
}

/** The station server's screen rotation, network status and clock; a fake in `?demo`. */
export interface DisplayApi {
    rotation(): Promise<Rotation>;
    rotate(to: Rotation): Promise<Rotation>;
    net(): Promise<NetStatus>;
    time(): Promise<TimeStatus>;
    setTime(req: { timezone?: string; ntp?: boolean; set?: string }): Promise<TimeStatus>;
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
        net: async () => (await (await fetch(`${base}/api/net`)).json()) as NetStatus,
        time: async () => (await (await fetch(`${base}/api/time`)).json()) as TimeStatus,
        setTime: async (req) =>
            (await (
                await fetch(`${base}/api/time`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(req),
                })
            ).json()) as TimeStatus,
    };
}

/** A local time as the server writes it: "YYYY-MM-DD HH:MM:SS". */
function stamp(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function demoDisplay(): DisplayApi {
    let current: Rotation = 0;
    const clock: TimeStatus = { now: "", timezone: "Asia/Yekaterinburg", ntp: true, synced: true };
    return {
        rotation: async () => current,
        rotate: async (to) => (current = to),
        net: async () => ({
            kind: "wifi",
            name: "Home Wi-Fi",
            ip: "192.168.68.102",
            signal: 72,
            host: "kern3d-station",
        }),
        time: async () => ({ ...clock, now: stamp(new Date()) }),
        setTime: async (req) => {
            if (req.timezone) clock.timezone = req.timezone;
            if (req.ntp !== undefined) clock.ntp = clock.synced = req.ntp;
            if (req.set) clock.ntp = clock.synced = false;
            return { ...clock, now: req.set ?? stamp(new Date()), ok: true };
        },
    };
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
}

/** A row of mutually exclusive choices; returns the row and a setter for the shown one. */
function choices<T extends string | number | boolean>(
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

/** Russia's time zones for the list (any other zone the station has is added to it as is). */
const ZONES: readonly [string, string][] = [
    ["Europe/Kaliningrad", "Калининград (UTC+2)"],
    ["Europe/Moscow", "Москва (UTC+3)"],
    ["Europe/Samara", "Самара (UTC+4)"],
    ["Asia/Yekaterinburg", "Екатеринбург (UTC+5)"],
    ["Asia/Omsk", "Омск (UTC+6)"],
    ["Asia/Novosibirsk", "Новосибирск (UTC+7)"],
    ["Asia/Krasnoyarsk", "Красноярск (UTC+7)"],
    ["Asia/Irkutsk", "Иркутск (UTC+8)"],
    ["Asia/Yakutsk", "Якутск (UTC+9)"],
    ["Asia/Vladivostok", "Владивосток (UTC+10)"],
    ["Asia/Magadan", "Магадан (UTC+11)"],
    ["Asia/Kamchatka", "Камчатка (UTC+12)"],
    ["UTC", "UTC"],
];

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
        const padEl = h("div", "section");
        const padPanel = new PadPanel(padEl, toast);
        this.add(
            "pad",
            "Джойстик",
            padEl,
            () => padPanel.show(),
            () => padPanel.hide(),
        );
        const helpEl = h("div", "section");
        this.add("help", "Справка", helpEl, () => helpEl.replaceChildren(padHelp()));
        const [timeEl, timeShow, timeHide] = this.timeSection(toast);
        this.add("time", "Время", timeEl, timeShow, timeHide);
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

    /** Opens the sheet on one section (the 🎮 chip opens the gamepad help). */
    showSection(id: string) {
        this.sheet.classList.add("open");
        this.open(id);
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

    /**
     * Время: the clock, automatic time from the internet (NTP) on or off, the time zone, and, with
     * automatic time off, setting it by hand with ± buttons.
     */
    private timeSection(toast: (text: string) => void): [HTMLElement, () => void, () => void] {
        const el = h("div", "section");
        const big = h("div", "timeBig");
        const state = h("div", "wifiInfo");
        const manual = h("div", "timeManual");
        let status: TimeStatus | undefined;
        let pending: Date | undefined; // the time being set by hand
        let timer: ReturnType<typeof setInterval> | undefined;

        const parse = (s: string) => new Date(s.replace(" ", "T"));
        const draw = () => {
            if (!status) return;
            const now = pending ?? parse(status.now);
            big.textContent = `${now.toLocaleTimeString("ru-RU")}   ${now.toLocaleDateString("ru-RU")}`;
            state.textContent = status.ntp
                ? status.synced
                    ? "✓ Время берётся из интернета автоматически"
                    : "⏳ Автоматически — ждёт связи с сервером времени"
                : "Время задано вручную";
            setNtp(status.ntp);
            setZone(status.timezone);
            manual.hidden = status.ntp;
        };
        const apply = async (req: { timezone?: string; ntp?: boolean; set?: string }) => {
            const r = await this.display.setTime(req).catch(() => undefined);
            if (!r || r.ok === false) toast(`Не удалось: ${r?.error || "нет связи со станцией"}`);
            status = r ?? status;
            pending = undefined;
            draw();
            dispatchEvent(new Event("station-time")); // the clock in the top bar follows
        };

        const [ntpRow, setNtp] = choices<boolean>(
            [
                [true, "Автоматически (интернет)"],
                [false, "Вручную"],
            ],
            (ntp) => void apply({ ntp }),
        );
        const zoneRow = h("select", "zoneSelect");
        for (const [zone, label] of ZONES) {
            const o = h("option", "", label);
            o.value = zone;
            zoneRow.append(o);
        }
        zoneRow.onchange = () => void apply({ timezone: zoneRow.value });
        const setZone = (zone: string) => {
            if (!ZONES.some(([z]) => z === zone)) {
                const o = h("option", "", zone);
                o.value = zone;
                zoneRow.append(o);
            }
            if (document.activeElement !== zoneRow) zoneRow.value = zone;
        };

        const shift = (label: string, ms: number) => {
            const b = h("button", "sheetBtn", label);
            b.onclick = () => {
                if (!status) return;
                pending = new Date((pending ?? parse(status.now)).getTime() + ms);
                draw();
            };
            return b;
        };
        const setBtn = h("button", "sheetBtn primary", "Установить");
        setBtn.onclick = () => {
            if (pending) void apply({ set: stamp(pending) });
        };
        const hour = 3600e3;
        const minute = 60e3;
        manual.append(
            shift("−1 день", -24 * hour),
            shift("−1 ч", -hour),
            shift("−1 мин", -minute),
            shift("+1 мин", minute),
            shift("+1 ч", hour),
            shift("+1 день", 24 * hour),
            setBtn,
        );

        el.append(
            big,
            state,
            h("div", "label", "Источник времени"),
            ntpRow,
            manual,
            h("div", "label", "Часовой пояс"),
            zoneRow,
        );
        const refresh = async () => {
            const r = await this.display.time().catch(() => undefined);
            if (r) status = r;
            draw();
        };
        return [
            el,
            () => {
                void refresh();
                clearInterval(timer);
                timer = setInterval(() => {
                    if (!pending) void refresh(); // the time being set by hand stays still
                }, 1000);
            },
            () => {
                clearInterval(timer);
                pending = undefined;
            },
        ];
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
