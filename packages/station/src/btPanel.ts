// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** A Bluetooth device as the station server sees it (station_server.py, GET /api/bt). */
export interface BtDevice {
    mac: string;
    name: string;
    icon: string;
    paired: boolean;
    connected: boolean;
    trusted: boolean;
    gamepad: boolean;
}

export interface BtStatus {
    present: boolean;
    powered: boolean;
    scanning: boolean;
    devices: BtDevice[];
    /** A pairing running in the background (or the last one): its stage and outcome. */
    pairing?: { mac: string; stage: string; done: boolean; ok: boolean; error: string } | null;
    ok?: boolean;
    error?: string;
}

export interface BtApi {
    status(): Promise<BtStatus>;
    scan(): Promise<BtStatus>;
    pair(mac: string): Promise<BtStatus>;
    connect(mac: string): Promise<BtStatus>;
    remove(mac: string): Promise<BtStatus>;
}

export function serverBt(base = ""): BtApi {
    const post = async (path: string, body: object = {}) => {
        const r = await fetch(`${base}/api/bt${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        return (await r.json()) as BtStatus;
    };
    return {
        status: async () => (await (await fetch(`${base}/api/bt`)).json()) as BtStatus,
        scan: () => post("/scan"),
        pair: (mac) => post("/pair", { mac }),
        connect: (mac) => post("/connect", { mac }),
        remove: (mac) => post("/remove", { mac }),
    };
}

export function demoBt(): BtApi {
    const devices: BtDevice[] = [
        {
            mac: "AA:BB:CC:00:00:01",
            name: "Xbox Wireless Controller",
            icon: "input-gaming",
            paired: false,
            connected: false,
            trusted: false,
            gamepad: true,
        },
    ];
    const extra: BtDevice = {
        mac: "AA:BB:CC:00:00:02",
        name: "8BitDo Pro 2",
        icon: "input-gaming",
        paired: false,
        connected: false,
        trusted: false,
        gamepad: true,
    };
    let scanning = false;
    let pairing: BtStatus["pairing"] = null;
    const state = (): BtStatus => ({
        present: true,
        powered: true,
        scanning,
        devices: structuredClone(devices),
        pairing: pairing ? { ...pairing } : null,
    });
    const wait = (s: BtStatus) => new Promise<BtStatus>((r) => setTimeout(() => r(s), 700));
    const find = (mac: string) => devices.find((d) => d.mac === mac);
    return {
        status: () => wait(state()),
        scan: () => {
            scanning = true;
            setTimeout(() => {
                if (!find(extra.mac)) devices.push({ ...extra });
                scanning = false;
            }, 3000);
            return wait(state());
        },
        pair: (mac) => {
            const stages = ["поиск устройства", "сопряжение", "доверие", "подключение"];
            pairing = { mac, stage: stages[0], done: false, ok: false, error: "" };
            stages.forEach((stage, i) =>
                setTimeout(() => {
                    if (pairing) pairing.stage = stage;
                }, i * 900),
            );
            setTimeout(() => {
                const d = find(mac);
                if (d) Object.assign(d, { paired: true, trusted: true, connected: true });
                if (pairing) Object.assign(pairing, { done: true, ok: true });
            }, stages.length * 900);
            return wait(state());
        },
        connect: (mac) => {
            const d = find(mac);
            if (d) d.connected = true;
            return wait({ ...state(), ok: true });
        },
        remove: (mac) => {
            const i = devices.findIndex((d) => d.mac === mac);
            if (i >= 0) devices.splice(i, 1);
            return wait({ ...state(), ok: true });
        },
    };
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
}

/**
 * Settings → Bluetooth: search, pair a gamepad (paired = trusted, so it comes back by itself when
 * switched on), connect, remove; and the gamepad the browser sees, with its sticks moving live, to
 * check it before jogging the machine with it.
 */
export class BtPanel {
    private readonly info = h("div", "wifiInfo");
    private readonly list = h("div", "wifiList");
    private readonly pad = h("div", "padTest");
    private busy = false;
    private poll?: ReturnType<typeof setInterval>;
    private frame = 0;
    /** The pairing whose outcome was already told (so it is told once). */
    private toldPairing = "";

    constructor(
        host: HTMLElement,
        private readonly api: BtApi,
        private readonly toast: (text: string) => void,
    ) {
        const scan = h("button", "sheetBtn", "🔍 Искать");
        scan.onclick = () => void this.run(() => this.api.scan(), "");
        const bar = h("div", "sectionBar");
        bar.append(this.info, scan);
        host.append(
            bar,
            h(
                "p",
                "hint",
                "Включите на джойстике режим сопряжения (обычно кнопка с логотипом + кнопка сопряжения, огоньки часто мигают), нажмите «Искать», затем «Подключить» — пока идёт сопряжение, держите джойстик в этом режиме.",
            ),
            this.list,
            this.pad,
        );
    }

    show() {
        void this.run(() => this.api.status(), "");
        this.poll = setInterval(() => void this.refresh(), 1000);
        const loop = () => {
            this.drawPad();
            this.frame = requestAnimationFrame(loop);
        };
        loop();
    }

    hide() {
        clearInterval(this.poll);
        cancelAnimationFrame(this.frame);
    }

    private async refresh() {
        if (this.busy) return;
        try {
            this.render(await this.api.status());
        } catch {}
    }

    private async run(call: () => Promise<BtStatus>, done: string) {
        if (this.busy) return;
        this.busy = true;
        this.info.textContent = "…";
        try {
            const s = await call();
            if (s.ok === false) this.toast(`Bluetooth: ${s.error || "не удалось"}`);
            else if (s.ok && done) this.toast(done);
            this.render(s);
        } catch {
            this.info.textContent = "Сервер станции не отвечает";
        } finally {
            this.busy = false;
        }
    }

    private render(s: BtStatus) {
        const pairing = s.pairing;
        const pairingNow = pairing && !pairing.done ? pairing : undefined;
        if (pairing?.done && this.toldPairing !== `${pairing.mac}:${pairing.ok}:${pairing.error}`) {
            this.toldPairing = `${pairing.mac}:${pairing.ok}:${pairing.error}`;
            const name = s.devices.find((d) => d.mac === pairing.mac)?.name ?? pairing.mac;
            this.toast(pairing.ok ? `🎮 ${name} подключён` : `Bluetooth: ${pairing.error || "не удалось"}`);
        }
        this.info.textContent = pairingNow
            ? `Сопряжение: ${pairingNow.stage}…`
            : !s.present
              ? "Bluetooth-адаптер не найден"
              : !s.powered
                ? "Bluetooth выключен"
                : s.scanning
                  ? "Поиск… (20 с)"
                  : `Устройств: ${s.devices.length}`;
        this.list.replaceChildren(
            ...s.devices.map((d) => {
                const row = h("div", `wifiRow${d.connected ? " on" : ""}`);
                const icon = h("span", "btIcon", d.gamepad ? "🎮" : "ᛒ");
                const name = h("div", "wifiName", d.name);
                name.append(
                    h(
                        "small",
                        "",
                        d.connected ? "подключён" : d.paired ? "сопряжён, не в сети" : "новое устройство",
                    ),
                );
                row.append(icon, name);
                const act = (label: string, call: () => Promise<BtStatus>, done: string) => {
                    const b = h("button", "sheetBtn", label);
                    b.onclick = (e) => {
                        e.stopPropagation();
                        void this.run(call, done);
                    };
                    row.append(b);
                };
                if (pairingNow?.mac === d.mac) {
                    row.append(h("span", "spinner"));
                    return row;
                }
                if (pairingNow) return row;
                if (!d.paired) act("Подключить", () => this.api.pair(d.mac), "");
                else if (!d.connected) act("Соединить", () => this.api.connect(d.mac), `🎮 ${d.name} в сети`);
                if (d.paired) act("Удалить", () => this.api.remove(d.mac), "");
                return row;
            }),
        );
    }

    /** The first gamepad the browser has, sticks and buttons live. */
    private drawPad() {
        const pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p);
        if (!pad) {
            if (this.pad.dataset["state"] !== "none") {
                this.pad.dataset["state"] = "none";
                this.pad.replaceChildren(
                    h(
                        "div",
                        "hint",
                        "Джойстик пока не виден пульту: подключите его и нажмите на нём любую кнопку.",
                    ),
                );
            }
            return;
        }
        if (this.pad.dataset["state"] !== "pad") {
            this.pad.dataset["state"] = "pad";
            const stick = (id: string) => {
                const s = h("div", "stick");
                s.append(h("i"));
                s.dataset["id"] = id;
                return s;
            };
            const buttons = h("div", "padButtons");
            this.pad.replaceChildren(
                h("div", "padName", `🎮 ${pad.id.replace(/\s*\(.*\)\s*/, "")}`),
                h("div", "padRow"),
                buttons,
            );
            this.pad.children[1].append(stick("l"), stick("r"));
        }
        const dot = (id: string, x: number, y: number) => {
            const i = this.pad.querySelector<HTMLElement>(`.stick[data-id="${id}"] i`);
            if (i) i.style.transform = `translate(${x * 120}%, ${y * 120}%)`;
        };
        dot("l", pad.axes[0] ?? 0, pad.axes[1] ?? 0);
        dot("r", pad.axes[2] ?? 0, pad.axes[3] ?? 0);
        const box = this.pad.querySelector(".padButtons")!;
        if (box.children.length !== pad.buttons.length)
            box.replaceChildren(...pad.buttons.map((_, i) => h("span", "", String(i))));
        pad.buttons.forEach((b, i) => box.children[i].classList.toggle("on", b.pressed));
    }
}
