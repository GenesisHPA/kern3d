// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Axis } from "@chili3d/app/src/cam/machineControl";
import type { BtApi } from "./btPanel";
import { grblErrorText } from "./grblText";
import { MapView, type Stock, savedStock, saveStock } from "./machineMap";
import { padEnabled, setPadEnabled } from "./padMap";
import { ProbePanel } from "./probePanel";
import { rotary } from "./rotary";
import { scrollArrows } from "./scrollArrows";
import { type DisplayApi, type Layout, resolveLayout, SettingsSheet, savedLayout } from "./settings";
import type { StationMachine, StationSnapshot } from "./stationMachine";
import { PathView } from "./view3d";
import type { WifiApi } from "./wifiPanel";

const STATE_TEXT: Record<string, string> = {
    Idle: "Готов",
    Run: "Работа",
    Hold: "Пауза",
    Jog: "Перемещение",
    Home: "Поиск нуля",
    Alarm: "Тревога",
    Door: "Дверь",
    Check: "Проверка",
    Sleep: "Сон",
    Offline: "Нет связи",
};

/** The steps offered for jogging, mm; 0 = continuous (while the key is held). */
const STEPS = [0.01, 0.1, 1, 10, 0] as const;
const MAX_RPM = 24000;

function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, string> = {},
    ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    e.append(...children);
    return e;
}

function fmt(v: number | undefined): string {
    if (v === undefined || Number.isNaN(v)) return "—";
    return `${v < 0 ? "−" : " "}${Math.abs(v).toFixed(3)}`;
}

function clock(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60);
    return m >= 60
        ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")} ч`
        : `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** The machine station's screen: the layout of the approved mock-up, live. */
export class StationUi {
    private readonly root = h("div", { class: "screen" });
    private readonly view: PathView;
    private readonly el: Record<string, HTMLElement> = {};
    private step = 1;

    /** One step finer (−1) or coarser (+1) among the steps on screen, as if its chip was tapped. */
    shiftStep(delta: 1 | -1) {
        const steps = STEPS.filter((x) => x > 0);
        const i = steps.indexOf(this.step as (typeof steps)[number]);
        const next = steps[Math.min(steps.length - 1, Math.max(0, (i < 0 ? 2 : i) + delta))];
        this.step = next;
        for (const chip of this.root.querySelectorAll(".steps button"))
            chip.classList.toggle("on", chip.textContent === String(next));
        this.toast(`Шаг ${next} мм`);
    }

    /** The jog step chosen on screen, mm (0 = continuous). */
    get jogStep(): number {
        return this.step;
    }
    private shownJobId?: number;
    private shown: [number, number, number] = [0, 0, 0];
    private shownError?: string;
    private settings!: SettingsSheet;
    private layout: Layout = savedLayout();

    constructor(
        private readonly machine: StationMachine,
        private readonly openFile: () => void,
        private readonly askConnect: () => void,
        wifi: WifiApi,
        private readonly display: DisplayApi,
        private readonly bt: BtApi,
    ) {
        const canvas = h("canvas");
        this.view = new PathView(canvas);
        this.root.append(
            h("div", { class: "alarm" }),
            this.ref("toast", h("div", { class: "toast" })),
            this.ref("msg", h("div", { class: "msg" })),
            this.topBar(),
            this.dro(),
            h(
                "div",
                { class: "view card" },
                canvas,
                this.mapCanvas(),
                this.viewSwitch(),
                this.stockBox(),
                this.ref("fromBox", h("div", { class: "stockBox fromBox" })),
                this.probePanel.el,
                this.ref("gline", h("div", { class: "gline" })),
                this.emergencyButton(),
                this.ref("changeBox", h("div", { class: "changeBox" })),
                this.askChangeBox(),
            ),
            this.jobCard(),
            h("div", { class: "mid card" }, this.jogCard(), this.queueCard()),
            this.actions(),
            this.connectOverlay(),
            this.initBanner(),
        );
        document.body.append(this.root);
        this.settings = new SettingsSheet(
            this.root,
            wifi,
            bt,
            display,
            (layout) => {
                this.layout = layout;
                this.applyLayout();
            },
            (text) => this.toast(text),
            machine,
        );
        this.applyLayout();
        addEventListener("resize", () => this.applyLayout());
        // the rotary on the table or not: its row in the DRO and its jog keys
        const showRotary = () => this.root.classList.toggle("rotary", rotary().installed);
        showRotary();
        addEventListener("station-rotary", showRotary);
        // ?open=settings: the settings sheet open at start (checks, screenshots)
        const open = new URLSearchParams(location.search).get("open");
        if (new URLSearchParams(location.search).has("probe")) this.probePanel.show();
        if (new URLSearchParams(location.search).has("map")) {
            this.showMap = true;
            this.root.classList.add("mapMode");
        }
        if (open === "settings") this.settings.show();
        else if (open) this.settings.showSection(open);
        machine.onChange(() => this.render());
        this.render();
        const frame = () => {
            this.animate();
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        // The clock shows the station's time: Chromium keeps the zone it started with, so a zone
        // changed in ⚙ Время would not show. The offset is asked every 30 s and after every change.
        let offset = 0;
        const sync = async () => {
            const t = await this.display.time().catch(() => undefined);
            if (t) offset = new Date(t.now.replace(" ", "T")).getTime() - Date.now();
        };
        void sync();
        setInterval(() => void sync(), 30000);
        addEventListener("station-time", () => void sync());
        setInterval(() => {
            const now = new Date(Date.now() + offset);
            this.el["clock"].textContent = now.toTimeString().slice(0, 5);
        }, 1000);
    }

    private ref<T extends HTMLElement>(name: string, e: T): T {
        this.el[name] = e;
        return e;
    }

    toast(text: string) {
        const t = this.el["toast"];
        t.textContent = text;
        t.classList.add("show");
        setTimeout(() => t.classList.remove("show"), 2600);
    }

    // ---- building -------------------------------------------------------------------------------

    private topBar() {
        const logo = h("div", { class: "logo" }, "Kern3D ", h("b", {}, "CNC"));
        const link = this.ref(
            "link",
            h("div", { class: "chip" }, h("span", { class: "dot" }), this.ref("linkText", h("span"))),
        );
        return h(
            "div",
            { class: "top card" },
            logo,
            link,
            this.ref("state", h("div", { class: "chip" })),
            this.ref("toolChip", h("div", { class: "chip toolChip" })),
            this.padToggle(),
            h("div", { class: "sp" }),
            this.netChip(),
            this.ref("clock", h("div", { class: "clock" })),
            this.gearButton(),
        );
    }

    /** Portrait (the Tesla screen standing up) or landscape (a monitor): the grid changes, nothing else. */
    private applyLayout() {
        this.root.dataset["layout"] = resolveLayout(this.layout);
    }

    /** The link in use and the station's address, asked every 5 s (set up in ⚙ → Wi-Fi). */
    private netChip() {
        const chip = this.ref("netChip", h("div", { class: "chip netChip" }));
        const update = async () => {
            const n = await this.display.net().catch(() => undefined);
            chip.classList.toggle("down", !n || n.kind === "none");
            if (!n) chip.textContent = "⚠ нет связи со станцией";
            else if (n.kind === "none") chip.textContent = "⚠ Нет сети";
            else {
                const icon = n.kind === "ethernet" ? "🔌" : "📶";
                const level = n.kind === "wifi" && n.signal ? ` ${n.signal}%` : "";
                chip.textContent = `${icon} ${n.name}${level} · ${n.ip}`;
            }
        };
        void update();
        setInterval(() => void update(), 5000);
        return chip;
    }

    /**
     * The gamepad on or off. Off: the station ignores it and drops it over Bluetooth (its battery
     * rests); on: the paired gamepads are called back.
     */
    private padToggle() {
        const chip = this.ref("padToggle", h("button", { class: "chip padToggle" }));
        const show = () => {
            const on = padEnabled();
            chip.classList.toggle("on", on);
            chip.textContent = on ? "🎮 вкл" : "🎮 выкл";
        };
        show();
        chip.onclick = async () => {
            const on = !padEnabled();
            setPadEnabled(on);
            show();
            const pads =
                (await this.bt.status().catch(() => undefined))?.devices.filter((d) => d.gamepad) ?? [];
            if (on) {
                const paired = pads.filter((d) => d.paired && !d.connected);
                this.toast(paired.length > 0 ? "🎮 Джойстик включён — подключаю…" : "🎮 Джойстик включён");
                for (const d of paired) void this.bt.connect(d.mac).catch(() => {});
            } else {
                this.toast("🎮 Джойстик выключен");
                for (const d of pads.filter((x) => x.connected))
                    void this.bt.disconnect(d.mac).catch(() => {});
            }
        };
        return chip;
    }

    /** 🔧 in the corner of the view while a job runs: asks first, then begins the change. */
    private emergencyButton() {
        const b = this.ref("emergency", h("button", { class: "emergency" }, "🔧 Замена фрезы"));
        b.onclick = () => this.askChange();
        return b;
    }

    /** The «are you sure» before an emergency cutter change is open (the gamepad answers it too). */
    get askingChange(): boolean {
        return this.el["askChange"]?.classList.contains("show") ?? false;
    }

    /** Asks whether to stop the job and change the cutter; «Да» begins it. */
    askChange() {
        const s = this.machine.snapshot();
        if (s.change || !(s.jobState === "running" || s.jobState === "paused")) {
            this.toast("⚠ Сейчас нет работающего задания");
            return;
        }
        this.el["askChange"].classList.add("show");
    }

    /** The answer to `askChange`. */
    answerChange(yes: boolean) {
        this.el["askChange"].classList.remove("show");
        if (!yes) return;
        const why = this.machine.emergencyChange();
        if (why) this.toast(`⚠ ${why}`);
    }

    private askChangeBox() {
        const yes = h("button", { class: "primary" }, "Да, сменить");
        yes.onclick = () => this.answerChange(true);
        const no = h("button", {}, "Нет");
        no.onclick = () => this.answerChange(false);
        return this.ref(
            "askChange",
            h(
                "div",
                { class: "askChange" },
                h(
                    "div",
                    { class: "changeCard" },
                    h("div", { class: "changeIcon" }, "🔧"),
                    h("div", { class: "changeTitle" }, "Сменить фрезу?"),
                    h(
                        "p",
                        {},
                        "Фрезеровка остановится, шпиндель выключится и поднимется, станок уедет в ноль по упорам. " +
                            "После замены новая фреза замерится на датчике, и работа продолжится с того же места.",
                    ),
                    h("div", { class: "changeBtns" }, yes, no),
                    h("small", { class: "hint" }, "Джойстик: «Старт» — да, «Стоп» — нет"),
                ),
            ),
        );
    }

    // ---- the map of the table, the stock, initialisation -----------------------------------------

    private probe?: ProbePanel;
    /** «Щуп» over the view, made on first use (the machine is set by then). */
    private get probePanel(): ProbePanel {
        this.probe ??= new ProbePanel(
            this.machine,
            (t) => this.toast(t),
            (at) => {
                // the stock follows the probed zero: same size, its zero at that corner or the centre
                if (!this.stock) return;
                this.stock = { ...this.stock, zeroAt: at };
                saveStock(this.stock);
            },
        );
        return this.probe;
    }

    private showMap = false;
    private mapView!: MapView;
    private stock: Stock | undefined = savedStock();

    private probeKey(b: HTMLElement) {
        b.onclick = () => (this.probePanel.open ? this.probePanel.hide() : this.probePanel.show());
        return b;
    }

    private mapCanvas() {
        const c = this.ref("mapCanvas", h("canvas", { class: "mapCanvas" }));
        this.mapView = new MapView(c as HTMLCanvasElement);
        return c;
    }

    /** «🗺 Карта стола» / «◆ 3D», and «Заготовка» on the map. */
    private viewSwitch() {
        const toggle = h("button", { class: "viewBtn" }, "🗺 Карта стола");
        const stock = h("button", { class: "viewBtn" }, "▭ Заготовка");
        stock.onclick = () => this.el["stockBox"].classList.toggle("show");
        toggle.onclick = () => {
            this.showMap = !this.showMap;
            this.root.classList.toggle("mapMode", this.showMap);
            toggle.textContent = this.showMap ? "◆ 3D" : "🗺 Карта стола";
        };
        return h("div", { class: "viewSwitch" }, toggle, stock);
    }

    /** The stock's size, by ± buttons (no keyboard on the station), and where its work zero is. */
    private stockBox() {
        const st: Stock = this.stock ?? { width: 100, depth: 60, height: 20, zeroAt: "frontLeft" };
        const fields: [keyof Stock & ("width" | "depth" | "height"), string][] = [
            ["width", "Ширина X"],
            ["depth", "Глубина Y"],
            ["height", "Высота Z"],
        ];
        const rows = fields.map(([key, label]) => {
            const value = h("b", {}, String(st[key]));
            const step = (d: number) => {
                const b = h("button", {}, d > 0 ? `+${d}` : String(d));
                b.onclick = () => {
                    st[key] = Math.max(1, Math.round((st[key] + d) * 10) / 10);
                    value.textContent = String(st[key]);
                };
                return b;
            };
            return h(
                "div",
                { class: "stockRow" },
                h("span", {}, label),
                step(-10),
                step(-1),
                value,
                step(1),
                step(10),
            );
        });
        const zero = h("button", { class: "stockZero" });
        const order: Stock["zeroAt"][] = ["frontLeft", "frontRight", "backLeft", "backRight", "centre"];
        const names: Record<Stock["zeroAt"], string> = {
            frontLeft: "левый передний угол",
            frontRight: "правый передний угол",
            backLeft: "левый задний угол",
            backRight: "правый задний угол",
            centre: "центр",
        };
        const showZero = () => {
            zero.textContent = `Ноль: ${names[st.zeroAt]} верха`;
        };
        showZero();
        zero.onclick = () => {
            st.zeroAt = order[(order.indexOf(st.zeroAt) + 1) % order.length];
            showZero();
        };
        const save = h("button", { class: "primary" }, "Поставить на карту");
        save.onclick = () => {
            this.stock = { ...st };
            saveStock(this.stock);
            this.el["stockBox"].classList.remove("show");
            this.toast(`Заготовка ${st.width}×${st.depth}×${st.height} мм`);
        };
        const clear = h("button", {}, "Убрать");
        clear.onclick = () => {
            this.stock = undefined;
            saveStock(undefined);
            this.el["stockBox"].classList.remove("show");
        };
        return this.ref(
            "stockBox",
            h(
                "div",
                { class: "stockBox" },
                h("div", { class: "changeTitle" }, "Заготовка"),
                ...rows,
                zero,
                h("div", { class: "changeBtns" }, save, clear),
            ),
        );
    }

    /** Until the machine has found its zero (homing on): say so, and offer «Домой». */
    private initBanner() {
        const button = h("button", {}, "⌂ Домой");
        button.onclick = () => {
            if (!this.machine.home()) this.toast("⚠ Станок занят");
        };
        return this.ref(
            "initBanner",
            h(
                "div",
                { class: "connect initBanner" },
                h(
                    "p",
                    {},
                    h("b", {}, "Станок не инициализирован. "),
                    "Найдите ноль по упорам — до этого координаты машины неизвестны, старт заблокирован.",
                ),
                button,
            ),
        );
    }

    private gearButton() {
        const gear = h("button", { class: "gear", title: "Настройки: Wi-Fi" }, "⚙");
        gear.onclick = () => this.settings.show();
        return gear;
    }

    private dro() {
        const axes = h("div", { class: "axes" });
        for (const a of ["X", "Y", "Z"] as Axis[]) {
            const zero = h("button", { class: "zero" }, `${a} = 0`);
            zero.onclick = () => this.machine.zero([a]);
            axes.append(
                h(
                    "div",
                    { class: "ax" },
                    h("div", { class: "n" }, a),
                    h(
                        "div",
                        { class: "v" },
                        this.ref(`w${a}`, h("span", {}, "—")),
                        this.ref(`m${a}`, h("small")),
                    ),
                    zero,
                ),
            );
        }
        const zeroA = h("button", { class: "zero" }, "A = 0");
        zeroA.onclick = () => this.machine.zeroA();
        axes.append(
            this.ref(
                "axA",
                h(
                    "div",
                    { class: "ax axA" },
                    h("div", { class: "n" }, "A"),
                    h("div", { class: "v" }, this.ref("wA", h("span", {}, "—")), this.ref("mA", h("small"))),
                    zeroA,
                ),
            ),
        );
        return h("div", { class: "dro card" }, h("div", { class: "label" }, "Координаты детали · G54"), axes);
    }

    private jobCard() {
        const ring = h("div", { class: "ring" });
        ring.innerHTML = `<svg viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#ffa24a"/><stop offset="1" stop-color="#f0520a"/></linearGradient></defs>
<circle cx="50" cy="50" r="44" fill="none" stroke="#2b2c32" stroke-width="7"/>
<circle class="rg" cx="50" cy="50" r="44" fill="none" stroke="url(#g)" stroke-width="7" stroke-linecap="round" stroke-dasharray="276.5" stroke-dashoffset="276.5" style="transition:stroke-dashoffset .6s"/></svg>`;
        ring.append(this.ref("pct", h("div", { class: "pct" }, "0%")));
        const gauge = h("div", { class: "gauge" });
        gauge.innerHTML = `<svg viewBox="0 0 100 100"><path d="M14 70 A40 40 0 1 1 86 70" fill="none" stroke="#2b2c32" stroke-width="7" stroke-linecap="round"/>
<path class="ga" d="M14 70 A40 40 0 1 1 86 70" fill="none" stroke="url(#g)" stroke-width="7" stroke-linecap="round" stroke-dasharray="188" stroke-dashoffset="188" style="transition:stroke-dashoffset 1s cubic-bezier(.22,1,.36,1)"/>
<g class="fan spinning"><circle cx="50" cy="46" r="6" fill="none" stroke="#ff7a1a" stroke-width="2"/><path d="M50 40v12M44 46h12" stroke="#ff7a1a" stroke-width="2"/></g></svg>`;
        gauge.append(h("div", { class: "rpm" }, this.ref("rpm", h("b", {}, "0")), h("span", {}, "ОБ/МИН")));
        return h(
            "div",
            { class: "job card" },
            ring,
            h(
                "div",
                { class: "jobinfo" },
                h("div", { class: "label" }, "Задание"),
                this.ref("jobName", h("div", { class: "name" }, "—")),
                this.ref("jobTimes", h("div", { class: "t" })),
                this.jobTools(),
            ),
            gauge,
        );
    }

    /** Under the job's name: «⬚ Обвести», «↦ С строки…», and «Продолжить с N» after a stop. */
    private jobTools() {
        const frame = h("button", { class: "jobBtn" }, "⬚ Обвести");
        frame.onclick = () =>
            this.machine
                .frameJob()
                .then(() => this.toast("Контур обведён на безопасной высоте"))
                .catch((e) => this.toast(`⚠ ${e instanceof Error ? e.message : String(e)}`));
        const from = h("button", { class: "jobBtn" }, "↦ С строки…");
        from.onclick = () => this.openFrom();
        const resume = this.ref("resumeBtn", h("button", { class: "jobBtn resume" }));
        resume.onclick = () => {
            const i = this.machine.interrupted;
            if (i) this.openFrom(i.line);
        };
        return h("div", { class: "jobTools" }, frame, from, resume);
    }

    private fromLine = 0;

    /** The «start from a line» chooser over the view, at `line` (0-based). */
    private openFrom(line?: number) {
        const job = this.machine.snapshot().job;
        if (!job) {
            this.toast("⚠ Нет задания");
            return;
        }
        this.fromLine = Math.max(0, Math.min(job.lines.length - 1, line ?? this.machine.snapshot().doneLine));
        this.renderFrom();
        this.el["fromBox"].classList.add("show");
    }

    private renderFrom() {
        const job = this.machine.snapshot().job;
        const box = this.el["fromBox"];
        if (!job) return box.classList.remove("show");
        const n = this.fromLine;
        const step = (d: number) => {
            const b = h("button", {}, d > 0 ? `+${d}` : String(d));
            b.onclick = () => {
                this.fromLine = Math.max(0, Math.min(job.lines.length - 1, this.fromLine + d));
                this.renderFrom();
            };
            return b;
        };
        const view = h("div", { class: "fromLines" });
        for (let i = Math.max(0, n - 3); i <= Math.min(job.lines.length - 1, n + 3); i++)
            view.append(h("div", { class: i === n ? "cur" : "old" }, `${i + 1}  ${job.lines[i]}`));
        const tool = this.machine.toolAt(n);
        const go = h("button", { class: "primary" }, `Запустить со строки ${n + 1}`);
        const no = h("button", {}, "Отмена");
        no.onclick = () => box.classList.remove("show");
        go.onclick = () => {
            if (!go.classList.contains("armed")) {
                // a second press to be sure: a wrong line cuts where it must not
                go.classList.add("armed");
                go.textContent = "Точно? Нажмите ещё раз";
                setTimeout(() => {
                    go.classList.remove("armed");
                    go.textContent = `Запустить со строки ${n + 1}`;
                }, 4000);
                return;
            }
            box.classList.remove("show");
            if (!this.machine.startFrom(n))
                this.toast(`⚠ ${this.machine.whyNotStart() ?? "Не удалось запустить с этой строки"}`);
        };
        box.replaceChildren(
            h("div", { class: "changeTitle" }, "Запуск с выбранной строки"),
            h(
                "div",
                { class: "stockRow" },
                h("span", {}, "Строка"),
                step(-100),
                step(-10),
                step(-1),
                h("b", {}, String(n + 1)),
                step(1),
                step(10),
                step(100),
            ),
            view,
            h(
                "p",
                { class: "hint" },
                `Станок восстановит режимы строк до неё (единицы, система координат, шпиндель, подача), ` +
                    `подъедет над точкой начала на безопасной высоте и опустится на подаче врезания. ` +
                    (tool ? `Нужна фреза T${tool.tool}${tool.name ? ` · ${tool.name}` : ""}.` : ""),
            ),
            h("div", { class: "changeBtns" }, go, no),
        );
    }

    private jogCard() {
        const steps = h("div", { class: "steps" });
        for (const s of STEPS) {
            const b = h("button", s === this.step ? { class: "on" } : {}, s === 0 ? "∞" : String(s));
            b.onclick = () => {
                this.step = s;
                for (const x of steps.children) x.classList.toggle("on", x === b);
            };
            steps.append(b);
        }
        const key = (label: string, axis?: Axis, dir?: 1 | -1, extra = "") => {
            const b = h("button", { class: `k ${extra}`.trim() }, label);
            if (axis && dir) {
                b.onpointerdown = (e) => {
                    b.setPointerCapture(e.pointerId);
                    this.machine.jog(axis, dir, this.step);
                };
                b.onpointerup = () => {
                    if (this.step === 0) this.machine.jogStop();
                };
            }
            return b;
        };
        const home = key("⌂", undefined, undefined, "c");
        home.onclick = () => this.machine.home();
        const pad = h(
            "div",
            { class: "pad" },
            key("↖", undefined, undefined, "c"),
            key("Y+", "Y", 1),
            key("↗", undefined, undefined, "c"),
            h("span"),
            key("Z+", "Z", 1, "z"),
            key("X−", "X", -1),
            home,
            key("X+", "X", 1),
            h("span"),
            this.probeKey(key("Щуп", undefined, undefined, "z")),
            key("↙", undefined, undefined, "c"),
            key("Y−", "Y", -1),
            key("↘", undefined, undefined, "c"),
            h("span"),
            key("Z−", "Z", -1, "z"),
        );
        const ovr = (kind: "feed" | "spindle", name: string) => {
            const bar = h("i");
            const box = h("div", {}, `${name} `, this.ref(`${kind}Ov`, h("b", {}, "100%")), bar);
            box.onclick = (e) => {
                const r = box.getBoundingClientRect();
                this.machine.override(kind, e.clientX < r.left + r.width / 2 ? -10 : 10);
            };
            box.ondblclick = () => this.machine.override(kind, 0);
            this.el[`${kind}Bar`] = bar;
            return box;
        };
        const aKey = (label: string, dir: 1 | -1) => {
            const b = h("button", { class: "k" }, label);
            b.onpointerdown = (e) => {
                b.setPointerCapture(e.pointerId);
                this.machine.jogA(dir, this.step, Math.min(rotary().maxRate, 1800));
            };
            b.onpointerup = () => {
                if (this.step === 0) this.machine.jogStop();
            };
            return b;
        };
        const aRow = this.ref(
            "aRow",
            h(
                "div",
                { class: "aRow" },
                aKey("A−", -1),
                h("span", { class: "aHint" }, "шаг в градусах"),
                aKey("A+", 1),
            ),
        );
        return h(
            "div",
            { class: "jog card" },
            steps,
            pad,
            aRow,
            h("div", { class: "ovr" }, ovr("feed", "Подача"), ovr("spindle", "Шпиндель")),
        );
    }

    private queueCard() {
        const open = h("button", { class: "openFile" }, "+ Открыть G-code");
        open.onclick = () => this.openFile();
        const list = this.ref("queue", h("div", { class: "qlist" }));
        const box = h("div", { class: "qbox" }, list);
        scrollArrows(box, () => (list.scrollHeight > list.clientHeight + 2 ? list : undefined));
        return h("div", { class: "queue card" }, h("div", { class: "label" }, "Очередь"), box, open);
    }

    private actions() {
        const start = this.ref(
            "start",
            h(
                "button",
                { class: "btn start" },
                h("span", { class: "fill" }),
                this.ref("startText", h("span", {}, "▶ Старт")),
                this.ref("startHint", h("small", {}, "удерживайте 1 с")),
            ),
        );
        let hold: ReturnType<typeof setTimeout> | undefined;
        start.onpointerdown = () => {
            start.classList.add("holding");
            hold = setTimeout(() => {
                start.classList.remove("holding");
                const s = this.machine.snapshot();
                if (s.alarm !== undefined || s.status.state === "Alarm") this.machine.unlock();
                else if (!this.machine.start())
                    this.toast(`⚠ ${this.machine.whyNotStart() ?? "Нечего запускать или станок занят"}`);
            }, 1000);
        };
        const cancel = () => {
            clearTimeout(hold);
            start.classList.remove("holding");
        };
        start.onpointerup = cancel;
        start.onpointerleave = cancel;
        const pause = h("button", { class: "btn" }, "⏸ Пауза", h("small", {}, "Feed hold"));
        pause.onclick = () => this.machine.pause();
        const home = h("button", { class: "btn" }, "⌂ Домой", h("small", {}, "все оси"));
        home.onclick = () => this.machine.home();
        const stop = h("button", { class: "btn stop" }, "■ Стоп", h("small", {}, "сброс"));
        stop.onclick = () => this.machine.stop();
        return h("div", { class: "act card" }, start, pause, home, stop);
    }

    private connectOverlay() {
        const button = h("button", {}, "Подключить");
        button.onclick = () => this.askConnect();
        const text = h(
            "p",
            {},
            h("b", {}, "Контроллер не найден. "),
            "Подключите его по USB и нажмите «Подключить» — порт выбирается один раз.",
        );
        return this.ref("connect", h("div", { class: "connect" }, text, button));
    }

    // ---- live ----------------------------------------------------------------------------------

    /** What changes with events: texts, queue, states. */
    private render() {
        const s = this.machine.snapshot();
        const state = s.connected ? s.status.state : "Offline";
        this.el["linkText"].textContent = s.connected ? "Контроллер · USB" : "Нет связи";
        this.el["link"].className = `chip st-${s.connected ? "Idle" : "Offline"}`;
        this.el["state"].textContent = STATE_TEXT[state] ?? state;
        this.el["state"].className = `chip st-${state}`;
        this.el["connect"].classList.toggle("show", !s.connected);
        this.el["initBanner"].classList.toggle(
            "show",
            s.connected && s.machine.homing && !s.homed && s.status.state !== "Home",
        );
        const alarmed = s.alarm !== undefined || state === "Alarm";
        this.root.classList.toggle("alarmed", alarmed);
        this.el["msg"].textContent = alarmed
            ? `⚠ Тревога${s.alarm !== undefined ? ` ${s.alarm}` : ""}. Устраните причину и удерживайте «Разблокировать».`
            : "";
        this.el["startText"].textContent = alarmed
            ? "🔓 Разблокировать"
            : s.jobState === "paused"
              ? "▶ Продолжить"
              : "▶ Старт";
        this.el["toolChip"].textContent = s.tool
            ? `🛠 T${s.tool.tool}${s.tool.name ? ` · ${s.tool.name}` : ""}`
            : "🛠 фреза не указана";
        this.el["toolChip"].classList.toggle("unknown", !s.tool);
        this.renderJob(s);
        this.renderQueue(s);
        this.renderChange(s);
        if (s.lastError && s.lastError !== this.shownError) this.toast(`⚠ ${grblErrorText(s.lastError)}`);
        this.shownError = s.lastError;
    }

    private renderJob(s: StationSnapshot) {
        const job = s.job;
        const i = this.machine.interrupted;
        const active = s.jobState === "running" || s.jobState === "paused";
        const resume = this.el["resumeBtn"];
        resume.textContent = i ? `⟳ Продолжить со строки ${i.line + 1}` : "";
        resume.classList.toggle("show", i !== undefined && i.jobId === job?.id && !active);
        this.root.classList.toggle("jobActive", active);
        if (job?.id !== this.shownJobId) {
            this.shownJobId = job?.id;
            this.view.setPath(job?.path);
            this.el["gline"].innerHTML = "";
        }
        this.el["jobName"].textContent = job
            ? job.name
            : "Нет задания — откройте G-code или отправьте с ноутбука";
        const p = s.total > 0 ? s.acked / s.total : 0;
        this.el["pct"].textContent = `${Math.round(p * 100)}%`;
        (this.root.querySelector(".rg") as SVGElement).style.strokeDashoffset = String(276.5 * (1 - p));
        const left = job && p > 0 && s.elapsed > 0 ? (s.elapsed / p) * (1 - p) : job?.estimate;
        this.el["jobTimes"].innerHTML = job
            ? `Прошло <b>${clock(s.elapsed)}</b> · осталось <b>${left !== undefined ? clock(left) : "—"}</b><br>` +
              `Подача <b>${Math.round(s.status.feed ?? 0)}</b> мм/мин · строка <b>${s.acked}</b> / ${s.total || job.lines.length}` +
              (s.jobTools.length > 1
                  ? `<br>Инструменты: <b>${s.jobTools.map((t) => `T${t.tool}`).join(" → ")}</b>`
                  : "") +
              (s.offset !== 0
                  ? ` · поправка длины <b>${s.offset > 0 ? "+" : ""}${s.offset.toFixed(3)}</b>`
                  : "")
            : "";
        this.view.setProgress(s.doneLine, s.status.wpos);
        if (job && s.doneLine >= 0) {
            const rows = job.lines
                .slice(Math.max(0, s.doneLine - 8), s.doneLine + 1)
                .filter((l) => !l.startsWith("("))
                .slice(-3);
            this.el["gline"].innerHTML = rows
                .map(
                    (l, i) =>
                        `<div class="${i === rows.length - 1 ? "cur" : "old"}">${l.replace(/</g, "&lt;")}</div>`,
                )
                .join("");
        }
        const ov = s.status.overrides ?? [100, 100, 100];
        this.el["feedOv"].textContent = `${ov[0]}%`;
        this.el["spindleOv"].textContent = `${ov[2]}%`;
        this.el["feedBar"].style.setProperty("--w", `${Math.min(100, ov[0] / 2)}%`);
        this.el["spindleBar"].style.setProperty("--w", `${Math.min(100, ov[2] / 2)}%`);
    }

    private shownChange = "";

    /** The tool change, over the view: what to do now, and the buttons for it. */
    private renderChange(s: StationSnapshot) {
        const active = s.jobState === "running" || s.jobState === "paused";
        this.el["emergency"].classList.toggle("show", active && !s.change);
        const box = this.el["changeBox"];
        const c = s.change;
        const key = c ? `${c.kind}|${c.stage}|${c.tool}|${c.error}|${c.at}` : "";
        box.classList.toggle("show", c !== undefined);
        if (key === this.shownChange) return;
        this.shownChange = key;
        if (!c) {
            box.replaceChildren();
            return;
        }
        const emergency = c.kind === "emergency";
        const tool = emergency ? "Новая фреза" : `T${c.tool ?? "?"}${c.name ? ` · ${c.name}` : ""}`;
        const button = (text: string, action: () => void, cls = "") => {
            const b = h("button", { class: cls }, text);
            b.onclick = action;
            return b;
        };
        const cancel = button("Отменить задание", () => this.machine.stop(), "ghost");
        const done = (text: string) => button(text, () => this.machine.changeDone(), "primary");
        const spin = h("div", { class: "spin" });
        const parts: Record<string, [string, string, HTMLElement[]]> = {
            reference: [
                "Замер фрезы на датчике",
                "Фреза, которой ставили ноль Z, — эталон: по нему выставятся следующие.",
                [spin, cancel],
            ],
            moving: [
                emergency ? "Экстренная замена фрезы" : "Смена инструмента",
                emergency
                    ? "Фрезеровка остановлена. Шпиндель выключается и поднимается, станок едет в ноль по упорам…"
                    : "Шпиндель выключается и поднимается, станок едет в ноль по упорам…",
                [spin, cancel],
            ],
            waiting: [
                emergency ? "Замените фрезу" : `Поставьте ${tool}`,
                `Шпиндель выключен, станок ${c.at === "place" ? "в точке смены (поиск нуля в контроллере выключен)" : "в нуле по упорам"}. ` +
                    "Смените фрезу и нажмите «Фреза сменена» (или «Старт» на джойстике). Затем она замерится на датчике.",
                [done("✓ Фреза сменена"), cancel],
            ],
            measuring: ["Замер новой фрезы", "Фреза касается датчика длины…", [spin, cancel]],
            zero: [
                "Обнулите Z новой фрезой",
                "Датчика длины нет: подведите фрезу к верху детали (джойстик или кнопки), нажмите «Z = 0», потом «Продолжить».",
                [done("▶ Продолжить"), cancel],
            ],
            failed: [
                "Смена не удалась",
                c.error ?? "",
                [button("Закрыть", () => this.machine.stop(), "primary")],
            ],
        };
        const [title, text, controls] = parts[c.stage];
        box.replaceChildren(
            h(
                "div",
                { class: `changeCard ${c.stage}` },
                h("div", { class: "changeIcon" }, emergency ? "🔧" : "🛠"),
                h("div", { class: "changeTitle" }, title),
                h("p", {}, text),
                h("div", { class: "changeBtns" }, ...controls),
            ),
        );
    }

    private renderQueue(s: StationSnapshot) {
        const box = this.el["queue"];
        box.replaceChildren(
            ...s.queue.map((j, i) => {
                const running = s.job?.id === j.id && (s.jobState === "running" || s.jobState === "paused");
                const remove = h("span", { class: "x" }, "✕");
                remove.onclick = (e) => {
                    e.stopPropagation();
                    this.machine.remove(j.id);
                };
                const row = h(
                    "div",
                    { class: `q${running ? " run" : ""}${s.job?.id === j.id ? " sel" : ""}` },
                    h("div", { class: "ic" }, running ? "▶" : String(i + 1)),
                    h(
                        "div",
                        {},
                        j.name,
                        h(
                            "small",
                            {},
                            `${j.source === "network" ? "с ноутбука" : "файл"} · ~${clock(j.estimate)}`,
                        ),
                    ),
                    remove,
                );
                row.onclick = () => this.machine.select(j.id);
                return row;
            }),
        );
    }

    /** Every frame: the numbers glide to where the machine is, the gauge, the 3D view. */
    private animate() {
        const s = this.machine.snapshot();
        const w = s.status.wpos;
        const m = s.status.mpos;
        (["X", "Y", "Z"] as Axis[]).forEach((a, i) => {
            if (w) this.shown[i] += (w[i] - this.shown[i]) * 0.35;
            this.el[`w${a}`].textContent = w ? fmt(this.shown[i]) : "—";
            this.el[`m${a}`].textContent = m ? `маш. ${fmt(m[i])}` : "";
        });
        const a = s.status.a;
        this.el["wA"].textContent = a ? `${a.w.toFixed(2)}°` : "—";
        this.el["mA"].textContent = a ? `маш. ${a.m.toFixed(2)}°` : "";
        const rpm = s.status.spindle ?? 0;
        this.el["rpm"].textContent = Math.round(rpm).toLocaleString("ru");
        (this.root.querySelector(".ga") as SVGElement).style.strokeDashoffset = String(
            188 * (1 - Math.min(1, rpm / MAX_RPM)),
        );
        (this.root.querySelector(".fan") as SVGElement).style.animationPlayState =
            rpm > 100 ? "running" : "paused";
        this.probePanel.tick();
        if (this.showMap) {
            const st = s.status;
            this.mapView.draw({
                travel: s.machine.travel,
                mpos: st.mpos,
                wco:
                    st.mpos && st.wpos
                        ? (st.mpos.map((v, i) => v - st.wpos![i]) as [number, number, number])
                        : undefined,
                path: s.job?.path,
                stock: this.stock,
                homed: s.homed || !s.machine.homing,
                setter: this.machine.probe.setter.enabled ? this.machine.probe.setter : undefined,
                changeAt: s.machine.homing ? undefined : this.machine.probe.change,
            });
        } else this.view.draw();
    }
}
