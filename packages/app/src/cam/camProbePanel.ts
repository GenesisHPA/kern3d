// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { GrblController } from "../laser/grblController";
import { el, t } from "../laser/laserUi";
import style from "./camControl.module.css";
import {
    applyOffsetLines,
    type Corner,
    lengthOffset,
    loadProbeSettings,
    measureTool,
    type ProbeIO,
    type ProbeSettings,
    parsePrb,
    probeBoss,
    probeCorner,
    probeEdge,
    probeHole,
    probeTop,
    storeProbeSettings,
    toChangeLines,
    type Vec3,
} from "./camProbe";
import type { CamTool } from "./camTools";

/** The probing routines over a GRBL connection: lines sent and their `ok`s waited for. */
export class GrblProbeIO implements ProbeIO {
    constructor(private readonly grbl: GrblController) {}

    private run(lines: string[]): Promise<Vec3[]> {
        return new Promise((resolve, reject) => {
            let left = lines.length;
            const touches: Vec3[] = [];
            if (left === 0) {
                resolve(touches);
                return;
            }
            const timer = setTimeout(() => {
                off();
                reject(new Error(t("cnc.probe.timeout")));
            }, 120000);
            const off = this.grbl.on((e) => {
                if (e.type === "in") {
                    const prb = parsePrb(e.text);
                    if (prb) {
                        if (!prb.ok) {
                            off();
                            clearTimeout(timer);
                            reject(new Error(t("cnc.probe.noTouch")));
                            return;
                        }
                        touches.push(prb.pos);
                    } else if (e.text === "ok" && --left === 0) {
                        off();
                        clearTimeout(timer);
                        resolve(touches);
                    } else if (e.text.startsWith("error:")) {
                        off();
                        clearTimeout(timer);
                        reject(new Error(`${e.text}`));
                    }
                } else if (e.type === "alarm") {
                    off();
                    clearTimeout(timer);
                    reject(
                        new Error(e.code === 4 || e.code === 5 ? t("cnc.probe.noTouch") : `ALARM:${e.code}`),
                    );
                }
            });
            for (const l of lines) {
                if (!this.grbl.send(l, true)) {
                    off();
                    clearTimeout(timer);
                    reject(new Error(t("cnc.busy")));
                    return;
                }
            }
        });
    }

    async send(lines: string[]): Promise<void> {
        await this.run(lines);
    }

    async probe(line: string): Promise<Vec3> {
        const [p] = await this.run([line]);
        if (p === undefined) throw new Error(t("cnc.probe.noTouch"));
        return p;
    }
}

/**
 * The tool-length sensor, the 3D probe and tool changes for the control panel. Holds the
 * reference length (the tool the work Z zero was set with) and what each tool measured.
 */
export class ProbeWorkflow {
    settings: ProbeSettings = loadProbeSettings();
    /** Machine Z the reference tool touched the sensor at. */
    reference: number | undefined;
    /** The length offset in force (G43.1), mm. */
    offset = 0;
    /** The tool in the spindle (number; 0 = the 3D probe), what each measured. */
    current: number | undefined;
    readonly measured = new Map<number, number>();
    busy = false;
    result = "";
    private holeZero = true;
    private cornerZ = true;
    private bossDiameter = 30;
    /** A tool change waiting for the operator. */
    waiting: { tool: number; resolve: () => void; reject: (e: Error) => void } | undefined;

    constructor(
        private readonly grbl: () => GrblController | undefined,
        private readonly tools: () => CamTool[],
        private readonly changed: () => void,
        private readonly log: (text: string) => void,
    ) {}

    private save() {
        storeProbeSettings(this.settings);
    }

    /** Run a routine with the panel locked and its result or error shown. */
    private async task(name: string, work: (io: ProbeIO) => Promise<string>) {
        const g = this.grbl();
        if (!g || this.busy) return;
        this.busy = true;
        this.result = `${name}…`;
        this.changed();
        try {
            this.result = `${name}: ${await work(new GrblProbeIO(g))}`;
        } catch (e) {
            this.result = `${name}: ${e instanceof Error ? e.message : String(e)}`;
        } finally {
            this.busy = false;
            this.log(`[probe] ${this.result}`);
            this.changed();
        }
    }

    /** Measure what is in the spindle: the reference if there is none yet, else apply its offset. */
    measure(tool = this.current ?? 1) {
        return this.task(t("cnc.setter.measure"), async (io) => {
            const z = await measureTool(io, this.settings);
            this.measured.set(tool, z);
            this.current = tool;
            if (this.reference === undefined) {
                this.reference = z;
                this.offset = 0;
                return t("cnc.setter.reference", z.toFixed(3));
            }
            this.offset = lengthOffset(z, this.reference);
            await io.send(applyOffsetLines(this.offset));
            return t("cnc.setter.offset", this.offset.toFixed(3));
        });
    }

    resetLengths() {
        this.reference = undefined;
        this.offset = 0;
        this.measured.clear();
        this.grbl()?.send("G49");
        this.result = t("cnc.setter.cleared");
        this.changed();
    }

    /**
     * Between two parts of a program: to the change position, wait for the operator, then the
     * new tool measured on the sensor (when there is one) and its offset applied.
     */
    async toolChange(tool: number): Promise<void> {
        const g = this.grbl();
        if (!g) throw new Error(t("cnc.notConnected"));
        await new GrblProbeIO(g).send(toChangeLines(this.settings));
        await new Promise<void>((resolve, reject) => {
            this.waiting = { tool, resolve, reject };
            this.changed();
        });
        this.waiting = undefined;
        this.current = tool;
        if (this.settings.setter.enabled && this.reference !== undefined) await this.measure(tool);
        this.changed();
    }

    // ---- the panel ----------------------------------------------------------------------------

    private field(label: string, get: () => number, set: (v: number) => void): HTMLElement {
        const input = el("input", { type: "number", step: "any" });
        input.value = String(get());
        input.onchange = () => {
            const v = Number(input.value.replace(",", "."));
            if (Number.isFinite(v)) {
                set(v);
                this.save();
            }
        };
        const l = el("label", {}, el("span", { textContent: label }), input);
        l.className = style.slider;
        return l;
    }

    private b(text: string, action: () => void, cls = "", title = ""): HTMLButtonElement {
        const b = el("button", { textContent: text, title, onclick: action });
        b.className = [style.btn, cls].filter((c) => c).join(" ");
        b.disabled = this.busy || this.grbl() === undefined;
        return b;
    }

    private here(target: { x: number; y: number; z: number }, mpos: Vec3 | undefined) {
        if (!mpos) return;
        target.x = mpos[0];
        target.y = mpos[1];
        target.z = mpos[2];
        this.save();
        this.changed();
    }

    /** The waiting tool change, shown over everything. */
    changeBanner(): HTMLElement | undefined {
        const w = this.waiting;
        if (!w) return undefined;
        const tool = this.tools().find((x) => x.number === w.tool);
        const banner = el(
            "div",
            {},
            el("b", {
                textContent: t("cnc.change.title", w.tool, tool ? `${tool.name} Ø${tool.diameter}` : ""),
            }),
            el("span", {
                textContent: this.settings.setter.enabled
                    ? t("cnc.change.hintSetter")
                    : t("cnc.change.hintManual"),
            }),
            this.b(`✔ ${t("cnc.change.done")}`, () => w.resolve(), style.go),
            this.b(t("cnc.change.cancel"), () => w.reject(new Error(t("cnc.change.cancelled"))), style.halt),
        );
        banner.className = style.banner;
        for (const x of banner.querySelectorAll("button")) x.disabled = false;
        return banner;
    }

    /** The tool table: each tool of the job with what it measured on the sensor. */
    toolTable(): HTMLElement {
        const rows = this.tools().map((tool) => {
            const z = this.measured.get(tool.number);
            const off =
                z !== undefined && this.reference !== undefined ? lengthOffset(z, this.reference) : undefined;
            const r = el(
                "div",
                {},
                el("code", { textContent: `T${tool.number}` }),
                el("span", { textContent: `${tool.name} Ø${tool.diameter}` }),
                el("span", {
                    textContent: off === undefined ? "—" : `${off >= 0 ? "+" : ""}${off.toFixed(3)}`,
                }),
                this.b(t("cnc.setter.measureThis"), () => void this.measure(tool.number), style.small),
            );
            if (tool.number === this.current) r.classList.add(style.on);
            return r;
        });
        const probe = el(
            "div",
            {},
            el("code", { textContent: "T0" }),
            el("span", { textContent: t("cnc.probe3d") }),
            el("span", {
                textContent:
                    this.measured.get(0) !== undefined && this.reference !== undefined
                        ? lengthOffset(this.measured.get(0)!, this.reference).toFixed(3)
                        : "—",
            }),
            this.b(t("cnc.setter.measureThis"), () => void this.measure(0), style.small),
        );
        if (this.current === 0) probe.classList.add(style.on);
        const table = el("div", {}, probe, ...rows);
        table.className = style.toolTable;
        return table;
    }

    /** The probe tab: sensor, 3D probe routines, the change position. */
    tab(mpos: Vec3 | undefined, plate: HTMLElement[]): HTMLElement[] {
        const s = this.settings;
        const out: HTMLElement[] = [];
        if (this.result) {
            const r = el("div", { textContent: this.result });
            r.className = style.result;
            out.push(r);
        }

        // tool length sensor
        const enabled = el("input", { type: "checkbox" });
        enabled.checked = s.setter.enabled;
        enabled.onchange = () => {
            s.setter.enabled = enabled.checked;
            this.save();
        };
        out.push(
            el("h5", { textContent: t("cnc.setter") }),
            el("div", { className: style.caption, textContent: t("cnc.setter.hint") }),
            el(
                "label",
                { className: style.slider },
                el("span", { textContent: t("cnc.setter.enabled") }),
                enabled,
            ),
            this.field(
                t("cnc.setter.x"),
                () => s.setter.x,
                (v) => (s.setter.x = v),
            ),
            this.field(
                t("cnc.setter.y"),
                () => s.setter.y,
                (v) => (s.setter.y = v),
            ),
            this.field(
                t("cnc.setter.z"),
                () => s.setter.z,
                (v) => (s.setter.z = v),
            ),
            el(
                "div",
                { className: style.row },
                this.b(t("cnc.here"), () => this.here(s.setter, mpos), style.small, t("cnc.here.hint")),
                this.b(`⤓ ${t("cnc.setter.measure")}`, () => void this.measure(), style.primary),
                this.b(t("cnc.setter.reset"), () => this.resetLengths(), style.small),
            ),
            el("div", {
                className: style.caption,
                textContent:
                    this.reference === undefined
                        ? t("cnc.setter.noReference")
                        : `${t("cnc.setter.reference", this.reference.toFixed(3))} · ${t("cnc.setter.offset", this.offset.toFixed(3))}`,
            }),
            this.toolTable(),
        );

        // 3D probe
        const corner = (c: Corner, label: string) =>
            this.b(
                label,
                () =>
                    void this.task(t("cnc.probe.corner"), async (io) => {
                        const r = await probeCorner(io, s, c, this.cornerZ, this.offset);
                        return `X ${r.x.toFixed(3)} Y ${r.y.toFixed(3)}${r.z !== undefined ? ` Z ${r.z.toFixed(3)}` : ""}`;
                    }),
            );
        const edge = (axis: "X" | "Y", dir: 1 | -1, label: string) =>
            this.b(
                label,
                () =>
                    void this.task(
                        t("cnc.probe.edge"),
                        async (io) => `${axis} ${(await probeEdge(io, s, axis, dir)).toFixed(3)}`,
                    ),
            );
        const cornerZ = el("input", { type: "checkbox" });
        cornerZ.checked = this.cornerZ;
        cornerZ.onchange = () => (this.cornerZ = cornerZ.checked);
        const holeZero = el("input", { type: "checkbox" });
        holeZero.checked = this.holeZero;
        holeZero.onchange = () => (this.holeZero = holeZero.checked);
        const corners = el(
            "div",
            {},
            corner("backLeft", "↖"),
            el("span"),
            corner("backRight", "↗"),
            el("span"),
            el("span", { textContent: "▢" }),
            el("span"),
            corner("frontLeft", "↙"),
            el("span"),
            corner("frontRight", "↘"),
        );
        corners.className = style.corners;
        out.push(
            el("h5", { textContent: t("cnc.probe3d") }),
            el("div", { className: style.caption, textContent: t("cnc.probe3d.hint") }),
            this.field(
                t("cnc.probe3d.tip"),
                () => s.tip,
                (v) => (s.tip = Math.max(0, v)),
            ),
            this.field(
                t("cnc.probe3d.offsetX"),
                () => s.offsetX,
                (v) => (s.offsetX = v),
            ),
            this.field(
                t("cnc.probe3d.offsetY"),
                () => s.offsetY,
                (v) => (s.offsetY = v),
            ),
            this.field(
                t("cnc.probe3d.clearance"),
                () => s.clearance,
                (v) => (s.clearance = Math.max(0.5, v)),
            ),
            this.field(
                t("cnc.probe3d.depth"),
                () => s.depth,
                (v) => (s.depth = Math.max(0.2, v)),
            ),
            el("div", { className: style.caption, textContent: t("cnc.probe.edges") }),
            el(
                "div",
                { className: style.row },
                edge("X", 1, "X+ →|"),
                edge("X", -1, "|← X−"),
                edge("Y", 1, "Y+ ↑"),
                edge("Y", -1, "Y− ↓"),
                this.b(
                    "Z ↓",
                    () =>
                        void this.task(
                            t("cnc.probe.top"),
                            async (io) => `Z ${(await probeTop(io, s, this.offset)).toFixed(3)}`,
                        ),
                ),
            ),
            el("div", { className: style.caption, textContent: t("cnc.probe.corners") }),
            el(
                "div",
                { className: style.row },
                corners,
                el(
                    "label",
                    { className: style.row },
                    cornerZ,
                    el("span", { textContent: t("cnc.probe.withZ") }),
                ),
            ),
            el("div", { className: style.caption, textContent: t("cnc.probe.centres") }),
            el(
                "div",
                { className: style.row },
                this.b(
                    `◎ ${t("cnc.probe.hole")}`,
                    () =>
                        void this.task(t("cnc.probe.hole"), async (io) => {
                            const r = await probeHole(io, s, this.holeZero);
                            return `X ${r.x.toFixed(3)} Y ${r.y.toFixed(3)} Ø${r.d.toFixed(3)}`;
                        }),
                ),
                this.b(
                    `◉ ${t("cnc.probe.boss")}`,
                    () =>
                        void this.task(t("cnc.probe.boss"), async (io) => {
                            const r = await probeBoss(io, s, this.bossDiameter, this.holeZero);
                            return `X ${r.x.toFixed(3)} Y ${r.y.toFixed(3)} Ø${r.d.toFixed(3)}`;
                        }),
                ),
                el(
                    "label",
                    { className: style.row },
                    holeZero,
                    el("span", { textContent: t("cnc.probe.setZero") }),
                ),
            ),
            this.field(
                t("cnc.probe.bossDiameter"),
                () => this.bossDiameter,
                (v) => (this.bossDiameter = Math.max(1, v)),
            ),
        );

        // speeds, the change position, the plate
        out.push(
            el("h5", { textContent: t("cnc.probe.motion") }),
            this.field(
                t("cnc.probe.seek"),
                () => s.seekFeed,
                (v) => (s.seekFeed = Math.max(1, v)),
            ),
            this.field(
                t("cnc.probe.latch"),
                () => s.latchFeed,
                (v) => (s.latchFeed = Math.max(1, v)),
            ),
            this.field(
                t("cnc.probe.travel"),
                () => s.travel,
                (v) => (s.travel = Math.max(1, v)),
            ),
            this.field(
                t("cnc.probe.retract"),
                () => s.retract,
                (v) => (s.retract = Math.max(0.2, v)),
            ),
            this.field(
                t("cnc.probe.safeZ"),
                () => s.safeZ,
                (v) => (s.safeZ = v),
            ),
            el("h5", { textContent: t("cnc.change") }),
            this.field(
                "X",
                () => s.change.x,
                (v) => (s.change.x = v),
            ),
            this.field(
                "Y",
                () => s.change.y,
                (v) => (s.change.y = v),
            ),
            this.field(
                "Z",
                () => s.change.z,
                (v) => (s.change.z = v),
            ),
            el(
                "div",
                { className: style.row },
                this.b(t("cnc.here"), () => this.here(s.change, mpos), style.small, t("cnc.here.hint")),
                this.b(
                    t("cnc.change.go"),
                    () => {
                        for (const l of toChangeLines(s)) this.grbl()?.send(l);
                    },
                    style.small,
                ),
            ),
            el("h5", { textContent: t("cnc.plate") }),
            ...plate,
        );
        return out;
    }
}
