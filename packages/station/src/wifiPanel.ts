// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** What the station server reports about Wi-Fi (station_server.py, GET /api/wifi). */
export interface WifiNetwork {
    ssid: string;
    signal: number;
    secure: boolean;
    active: boolean;
    saved: boolean;
}

export interface WifiStatus {
    device: string | null;
    state: string;
    radio: boolean;
    ip: string;
    networks: WifiNetwork[];
    ok?: boolean;
    error?: string;
}

/** Talks to the station server; a fake in `?demo` (no server behind the preview). */
export interface WifiApi {
    status(): Promise<WifiStatus>;
    rescan(): Promise<WifiStatus>;
    connect(ssid: string, password: string): Promise<WifiStatus>;
    forget(ssid: string): Promise<WifiStatus>;
}

export function serverWifi(base = ""): WifiApi {
    const post = async (path: string, body: object = {}) => {
        const r = await fetch(`${base}/api/wifi${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        return (await r.json()) as WifiStatus;
    };
    return {
        status: async () => (await (await fetch(`${base}/api/wifi`)).json()) as WifiStatus,
        rescan: () => post("/rescan"),
        connect: (ssid, password) => post("/connect", { ssid, password }),
        forget: (ssid) => post("/forget", { ssid }),
    };
}

export function demoWifi(): WifiApi {
    const state: WifiStatus = {
        device: "wlp2s0",
        state: "connected",
        radio: true,
        ip: "192.168.68.120",
        networks: [
            { ssid: "Мастерская", signal: 92, secure: true, active: true, saved: true },
            { ssid: "HomeWi-Fi2", signal: 77, secure: true, active: false, saved: false },
            { ssid: "Гость", signal: 41, secure: false, active: false, saved: false },
        ],
    };
    const wait = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 600));
    return {
        status: () => wait(state),
        rescan: () => wait(state),
        connect: async (ssid, password) => {
            if (password.length > 0 && password.length < 8)
                return wait({ ...state, ok: false, error: "пароль короче 8 символов" });
            for (const n of state.networks) n.active = n.ssid === ssid;
            const n = state.networks.find((x) => x.ssid === ssid);
            if (n) n.saved = true;
            return wait({ ...state, ok: true });
        },
        forget: async (ssid) => {
            const n = state.networks.find((x) => x.ssid === ssid);
            if (n) {
                n.saved = false;
                n.active = false;
            }
            return wait({ ...state, ok: true });
        },
    };
}

const ROWS_LATIN = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
const ROWS_SYMBOLS = ["1234567890", "!@#$%^&*()", "-_=+[]{};:", "'\",.<>/?\\|`~"];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
}

/**
 * Settings → Wi-Fi as a sheet over the station screen: the networks in range with their signal,
 * tap to join (an on-screen keyboard for the password — there is no keyboard at the machine),
 * forget a saved one, rescan.
 */
export class WifiPanel {
    private readonly sheet = h("div", "sheet");
    private readonly list = h("div", "wifiList");
    private readonly info = h("div", "wifiInfo");
    private readonly keyboard = h("div", "kbd");
    private password = "";
    private target?: WifiNetwork;
    private shift = false;
    private symbols = false;
    private busy = false;

    constructor(
        host: HTMLElement,
        private readonly api: WifiApi,
        private readonly toast: (text: string) => void,
    ) {
        const close = h("button", "sheetClose", "✕");
        close.onclick = () => this.hide();
        const rescan = h("button", "sheetBtn", "↻ Обновить");
        rescan.onclick = () => this.run(() => this.api.rescan());
        const head = h("div", "sheetHead");
        head.append(h("div", "sheetTitle", "Wi-Fi"), rescan, close);
        this.sheet.append(head, this.info, this.list, this.keyboard);
        host.append(this.sheet);
    }

    show() {
        this.sheet.classList.add("open");
        this.keyboard.classList.remove("open");
        void this.run(() => this.api.status());
    }

    hide() {
        this.sheet.classList.remove("open");
        this.password = "";
    }

    private async run(call: () => Promise<WifiStatus>) {
        if (this.busy) return;
        this.busy = true;
        this.info.textContent = "…";
        try {
            const s = await call();
            if (s.ok === false) this.toast(`Wi-Fi: ${s.error || "не удалось подключиться"}`);
            else if (s.ok === true) this.toast("Wi-Fi: готово");
            this.render(s);
        } catch {
            this.info.textContent = "Сервер станции не отвечает";
        } finally {
            this.busy = false;
        }
    }

    private render(s: WifiStatus) {
        const active = s.networks.find((n) => n.active);
        this.info.textContent = !s.device
            ? "Wi-Fi-адаптер не найден"
            : active
              ? `Подключено: ${active.ssid}${s.ip ? ` · ${s.ip}` : ""}`
              : "Не подключено";
        this.list.replaceChildren(
            ...s.networks.map((n) => {
                const row = h("div", `wifiRow${n.active ? " on" : ""}`);
                const bars = h("span", "bars");
                for (let i = 1; i <= 4; i++) bars.append(h("i", n.signal >= i * 22 ? "lit" : ""));
                const name = h("div", "wifiName", n.ssid);
                name.append(
                    h(
                        "small",
                        "",
                        `${n.secure ? "🔒 " : ""}${n.active ? "подключено" : n.saved ? "сохранена" : ""}`,
                    ),
                );
                row.append(bars, name);
                if (n.saved) {
                    const forget = h("button", "sheetBtn", "Забыть");
                    forget.onclick = (e) => {
                        e.stopPropagation();
                        void this.run(() => this.api.forget(n.ssid));
                    };
                    row.append(forget);
                }
                row.onclick = () => this.choose(n);
                return row;
            }),
        );
    }

    private choose(n: WifiNetwork) {
        if (n.active) return;
        if (!n.secure || n.saved) {
            void this.run(() => this.api.connect(n.ssid, ""));
            return;
        }
        this.target = n;
        this.password = "";
        this.drawKeyboard();
        this.keyboard.classList.add("open");
    }

    private drawKeyboard() {
        const n = this.target;
        if (!n) return;
        const field = h("div", "kbdField", this.password ? "•".repeat(this.password.length) : "пароль");
        field.classList.toggle("empty", !this.password);
        const show = h("button", "sheetBtn", "👁");
        show.onpointerdown = () => (field.textContent = this.password || "пароль");
        show.onpointerup = show.onpointerleave = () =>
            (field.textContent = this.password ? "•".repeat(this.password.length) : "пароль");
        const top = h("div", "kbdTop");
        top.append(h("div", "kbdFor", n.ssid), field, show);
        const rows = (this.symbols ? ROWS_SYMBOLS : ROWS_LATIN).map((r, i) => {
            const row = h("div", "kbdRow");
            if (i === 3 && !this.symbols) {
                const sh = h("button", `key wide${this.shift ? " on" : ""}`, "⇧");
                sh.onclick = () => {
                    this.shift = !this.shift;
                    this.drawKeyboard();
                };
                row.append(sh);
            }
            for (const ch of r) {
                const c = this.shift && !this.symbols ? ch.toUpperCase() : ch;
                const k = h("button", "key", c);
                k.onclick = () => {
                    this.password += c;
                    if (this.shift) this.shift = false;
                    this.drawKeyboard();
                };
                row.append(k);
            }
            if (i === 3) {
                const back = h("button", "key wide", "⌫");
                back.onclick = () => {
                    this.password = this.password.slice(0, -1);
                    this.drawKeyboard();
                };
                row.append(back);
            }
            return row;
        });
        const last = h("div", "kbdRow");
        const mode = h("button", "key wide", this.symbols ? "abc" : "?123");
        mode.onclick = () => {
            this.symbols = !this.symbols;
            this.drawKeyboard();
        };
        const space = h("button", "key space", "пробел");
        space.onclick = () => {
            this.password += " ";
            this.drawKeyboard();
        };
        const cancel = h("button", "key wide", "Отмена");
        cancel.onclick = () => this.keyboard.classList.remove("open");
        const ok = h("button", "key go", "Подключить");
        ok.onclick = () => {
            this.keyboard.classList.remove("open");
            const pw = this.password;
            this.password = "";
            void this.run(() => this.api.connect(n.ssid, pw));
        };
        last.append(mode, space, cancel, ok);
        this.keyboard.replaceChildren(top, ...rows, last);
    }
}
