// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Corner } from "@chili3d/app/src/cam/camProbe";
import type { StationMachine } from "./stationMachine";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
}

export type ProbeKind = "top" | "corner" | "hole" | "boss" | "plate";

/** What each way of probing asks the person to do first, and does. */
const KINDS: Record<ProbeKind, { name: string; how: string }> = {
    top: {
        name: "Z по верху",
        how: "3D-щуп в шпинделе. Подведите его над заготовкой на 5–10 мм выше верха. Щуп опустится до касания: Z = 0 по верху.",
    },
    corner: {
        name: "Угол",
        how: "3D-щуп над заготовкой рядом с выбранным углом, внутри неё, на 5–10 мм выше верха. Щуп найдёт верх (если «с Z»), затем две грани: X и Y = 0 в углу.",
    },
    hole: {
        name: "Центр отверстия",
        how: "3D-щуп внутри отверстия, ниже его верхнего края. Щуп коснётся стенок по X и Y: X и Y = 0 в центре, покажет диаметр.",
    },
    boss: {
        name: "Центр бобышки",
        how: "3D-щуп над серединой бобышки, на 5–10 мм выше. Укажите её примерный диаметр. Щуп обойдёт её с четырёх сторон: X и Y = 0 в центре.",
    },
    plate: {
        name: "Z пластиной",
        how: "Фреза в шпинделе, пластина на заготовке под фрезой, крокодил на фрезе. Фреза опустится до пластины: Z = 0 по верху заготовки (толщина пластины учтена).",
    },
};

/**
 * «Щуп» over the view: the probe's state live (free / touching — for checking the wiring), the way
 * to probe, its options, what to do first, «Начать», and what was found. The jog pad stays in
 * reach beside it to bring the probe to its place.
 */
export class ProbePanel {
    readonly el = h("div", "probeBox");
    private kind: ProbeKind = "top";
    private corner: Corner = "frontLeft";
    private withZ = true;
    private boss = 20;
    private plate = 10;
    private readonly live = h("div", "probeLive");
    private readonly body = h("div", "probeBody");
    private result = "";

    constructor(
        private readonly machine: StationMachine,
        private readonly toast: (text: string) => void,
        /** The stock's work zero moves with a probed corner or centre. */
        private readonly onZero: (at: Corner | "centre") => void,
    ) {
        const close = h("button", "probeClose", "✕");
        close.onclick = () => this.hide();
        const head = h("div", "probeHead");
        head.append(h("div", "changeTitle", "Щуп"), this.live, close);
        this.el.append(head, this.body);
        this.render();
    }

    show() {
        this.el.classList.add("show");
        this.render();
    }

    hide() {
        this.el.classList.remove("show");
    }

    get open(): boolean {
        return this.el.classList.contains("show");
    }

    /** Every frame while open: the probe input, touched or not. */
    tick() {
        if (!this.open) return;
        const s = this.machine.snapshot();
        const touching = s.status.pins?.includes("P") ?? false;
        this.live.textContent = !s.connected ? "нет связи" : touching ? "● касание" : "○ свободен";
        this.live.classList.toggle("on", touching);
    }

    private render() {
        const busy = this.machine.measuring;
        const kinds = h("div", "choices probeKinds");
        for (const k of Object.keys(KINDS) as ProbeKind[]) {
            const b = h("button", `choice${k === this.kind ? " on" : ""}`, KINDS[k].name);
            b.onclick = () => {
                this.kind = k;
                this.result = "";
                this.render();
            };
            kinds.append(b);
        }
        const opts = h("div", "probeOpts");
        if (this.kind === "corner") {
            const grid = h("div", "probeCorners");
            const names: [Corner, string][] = [
                ["backLeft", "↖ задний левый"],
                ["backRight", "↗ задний правый"],
                ["frontLeft", "↙ передний левый"],
                ["frontRight", "↘ передний правый"],
            ];
            for (const [c, label] of names) {
                const b = h("button", `choice${c === this.corner ? " on" : ""}`, label);
                b.onclick = () => {
                    this.corner = c;
                    this.render();
                };
                grid.append(b);
            }
            const z = h("button", `choice${this.withZ ? " on" : ""}`, this.withZ ? "и Z по верху" : "без Z");
            z.onclick = () => {
                this.withZ = !this.withZ;
                this.render();
            };
            opts.append(grid, z);
        }
        const stepper = (label: string, get: () => number, set: (v: number) => void, steps: number[]) => {
            const row = h("div", "stockRow");
            const value = h("b", "", `${get()}`);
            row.append(h("span", "", label));
            for (const d of steps) {
                const b = h("button", "", d > 0 ? `+${d}` : String(d));
                b.onclick = () => {
                    set(Math.max(0.1, Math.round((get() + d) * 100) / 100));
                    value.textContent = `${get()}`;
                };
                if (d > 0 && !row.contains(value)) row.append(value);
                row.append(b);
            }
            return row;
        };
        if (this.kind === "boss")
            opts.append(
                stepper(
                    "Диаметр, мм",
                    () => this.boss,
                    (v) => (this.boss = v),
                    [-10, -1, 1, 10],
                ),
            );
        if (this.kind === "plate")
            opts.append(
                stepper(
                    "Пластина, мм",
                    () => this.plate,
                    (v) => (this.plate = v),
                    [-1, -0.1, 0.1, 1],
                ),
            );
        const go = h("button", "sheetBtn primary probeGo", busy ? `⏳ ${busy.stage}` : "▶ Начать");
        go.disabled = busy !== undefined;
        go.onclick = () => void this.run();
        this.body.replaceChildren(
            kinds,
            opts,
            h("p", "hint", KINDS[this.kind].how),
            go,
            ...(this.result ? [h("div", "rotaryCalc", this.result)] : []),
        );
    }

    private async run() {
        const k = this.kind;
        const render = setInterval(() => this.render(), 400);
        try {
            const r = await this.machine.probeRun(k, {
                corner: this.corner,
                withZ: this.withZ,
                boss: this.boss,
                plate: this.plate,
            });
            this.result = r;
            this.toast(`Щуп: ${r}`);
            if (k === "corner") this.onZero(this.corner);
            if (k === "hole" || k === "boss") this.onZero("centre");
        } catch (e) {
            this.result = `⚠ ${e instanceof Error ? e.message : String(e)}`;
            this.toast(this.result);
        } finally {
            clearInterval(render);
            this.render();
        }
    }
}
