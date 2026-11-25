// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Axis } from "@chili3d/app/src/cam/machineControl";
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
    /** Program line index (0-based) of each line GRBL is sent, for drawing the path done. */
    private sentToSource: number[] = [];
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
        display: DisplayApi,
    ) {
        const canvas = h("canvas");
        this.view = new PathView(canvas);
        this.root.append(
            h("div", { class: "alarm" }),
            this.ref("toast", h("div", { class: "toast" })),
            this.ref("msg", h("div", { class: "msg" })),
            this.topBar(),
            this.dro(),
            h("div", { class: "view card" }, canvas, this.ref("gline", h("div", { class: "gline" }))),
            this.jobCard(),
            h("div", { class: "mid card" }, this.jogCard(), this.queueCard()),
            this.actions(),
            this.connectOverlay(),
        );
        document.body.append(this.root);
        this.settings = new SettingsSheet(
            this.root,
            wifi,
            display,
            (layout) => {
                this.layout = layout;
                this.applyLayout();
            },
            (text) => this.toast(text),
        );
        this.applyLayout();
        addEventListener("resize", () => this.applyLayout());
        // ?open=settings: the settings sheet open at start (checks, screenshots)
        if (new URLSearchParams(location.search).get("open") === "settings") this.settings.show();
        machine.onChange(() => this.render());
        this.render();
        const frame = () => {
            this.animate();
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        setInterval(() => (this.el["clock"].textContent = new Date().toTimeString().slice(0, 5)), 1000);
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
        const logo = h("div", { class: "logo" }, "Kern3D ", h("b", {}, "Станок"));
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
            h("div", { class: "sp" }),
            this.ref("clock", h("div", { class: "clock" })),
            this.gearButton(),
        );
    }

    /** Portrait (the Tesla screen standing up) or landscape (a monitor): the grid changes, nothing else. */
    private applyLayout() {
        this.root.dataset["layout"] = resolveLayout(this.layout);
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
            ),
            gauge,
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
            key("Щуп", undefined, undefined, "c z"),
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
        return h(
            "div",
            { class: "jog card" },
            steps,
            pad,
            h("div", { class: "ovr" }, ovr("feed", "Подача"), ovr("spindle", "Шпиндель")),
        );
    }

    private queueCard() {
        const open = h("button", { class: "openFile" }, "+ Открыть G-code");
        open.onclick = () => this.openFile();
        return h(
            "div",
            { class: "queue card" },
            h("div", { class: "label" }, "Очередь"),
            this.ref("queue", h("div")),
            open,
        );
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
                else if (!this.machine.start()) this.toast("Нечего запускать или станок занят");
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
        this.renderJob(s);
        this.renderQueue(s);
        if (s.lastError && s.lastError !== this.shownError) this.toast(`Ошибка контроллера: ${s.lastError}`);
        this.shownError = s.lastError;
    }

    private renderJob(s: StationSnapshot) {
        const job = s.job;
        if (job?.id !== this.shownJobId) {
            this.shownJobId = job?.id;
            this.view.setPath(job?.path);
            this.sentToSource = [];
            job?.lines.forEach((l, i) => {
                if (
                    l
                        .replace(/\([^)]*\)/g, "")
                        .replace(/;.*$/, "")
                        .trim() !== ""
                )
                    this.sentToSource.push(i);
            });
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
              `Подача <b>${Math.round(s.status.feed ?? 0)}</b> мм/мин · строка <b>${s.acked}</b> / ${s.total || job.lines.length}`
            : "";
        const doneLine = s.acked > 0 ? (this.sentToSource[s.acked - 1] ?? -1) : -1;
        this.view.setProgress(doneLine, s.status.wpos);
        if (job && s.acked > 0) {
            const from = Math.max(0, s.acked - 3);
            const rows = job.lines
                .slice(this.sentToSource[from] ?? 0, (this.sentToSource[s.acked - 1] ?? 0) + 1)
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
        const rpm = s.status.spindle ?? 0;
        this.el["rpm"].textContent = Math.round(rpm).toLocaleString("ru");
        (this.root.querySelector(".ga") as SVGElement).style.strokeDashoffset = String(
            188 * (1 - Math.min(1, rpm / MAX_RPM)),
        );
        (this.root.querySelector(".fan") as SVGElement).style.animationPlayState =
            rpm > 100 ? "running" : "paused";
        this.view.draw();
    }
}
