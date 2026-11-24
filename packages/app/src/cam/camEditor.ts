// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Id, PubSub, ShapeNode, Transaction, workspaceTabs } from "@chili3d/core";
import { bodyOutline, type ModelView } from "../laser/fromModel";
import style from "../laser/laserEditor.module.css";
import { button, checkbox, el, heading, numberField, row, select, t } from "../laser/laserUi";
import { importSvg } from "../laser/svgImport";
import { MachineControl } from "./camControl";
import { type MillJob, type MillNode, parseMillJob } from "./camData";
import { millProgram, POST_KINDS } from "./camGcode";
import { type CamTool, loadTools, newToolId, storeTools, TOOL_KINDS } from "./camTools";
import { CamView } from "./camView";
import type { Pt } from "./offset";
import { ringArea } from "./offset";
import { type CamOperation, OPERATION_KINDS, type OperationKind, PROFILE_SIDES } from "./toolpath";
import { commandFrames, VFD_PRESETS, VfdSpindle, type VfdTransport } from "./vfd";

type Panel = "ops" | "tools" | "machine" | "spindle";

/** Kinds that work on hole centres rather than outlines. */
const POINT_KINDS: OperationKind[] = ["drill", "helix", "thread"];

/** Circles among the rings: their centres (for drilling), from round closed outlines. */
function circleCentres(rings: Pt[][]): Pt[] {
    const out: Pt[] = [];
    for (const r of rings) {
        if (r.length < 8) continue;
        const c = {
            x: r.reduce((s, p) => s + p.x, 0) / r.length,
            y: r.reduce((s, p) => s + p.y, 0) / r.length,
        };
        const d = r.map((p) => Math.hypot(p.x - c.x, p.y - c.y));
        const mean = d.reduce((s, x) => s + x, 0) / d.length;
        if (mean > 0 && Math.max(...d.map((x) => Math.abs(x - mean))) < mean * 0.05) out.push(c);
    }
    return out;
}

/**
 * The milling editor: the stock, operations in order with their tools, the machine and the
 * spindle's inverter on the left; the stock in 3D with the paths and the cut animated on the
 * right; G-code out. It covers the model as the laser editor does.
 */
export class MillEditor {
    private static readonly editors = new Map<string, MillEditor>();
    private readonly dialog = document.createElement("dialog");
    private readonly left = el("div", { className: style.panel });
    private readonly view = new CamView();
    private readonly status = el("span", { className: style.muted });
    private data: MillJob;
    private panel: Panel = "ops";
    private selected: string | undefined;
    private regen = 0;
    private vfd?: VfdSpindle;
    private vfdPort?: { close(): Promise<void> };
    private readonly control = new MachineControl({
        machine: () => this.data.machine,
        programLines: () =>
            this.program()
                .gcode.split("\n")
                .map((l) => l.trim())
                .filter((l) => l !== "" && !l.startsWith("(")),
        vfd: () => (this.data.vfd.enabled ? this.vfd : undefined),
    });
    private stage!: HTMLElement;
    private mode: "prepare" | "control" = "prepare";
    private readonly body = el("div");
    readonly tab;

    static open(node: MillNode) {
        let e = MillEditor.editors.get(node.id);
        if (e === undefined) {
            e = new MillEditor(node);
            MillEditor.editors.set(node.id, e);
        }
        workspaceTabs.open(e.tab);
    }

    static lastOpened: string | undefined;

    private constructor(private readonly node: MillNode) {
        this.data = node.data;
        this.tab = {
            id: node.id,
            title: () => this.node.name,
            icon: "icon-layer-group",
            show: () => this.reveal(),
            hide: () => {
                if (this.dialog.open) this.dialog.close();
            },
            close: () => this.close(),
        };
        this.dialog.className = style.dialog;
        this.left.style.cssText = "width:380px;flex:none;overflow:auto;height:100%;box-sizing:border-box";
        const stage = el("div");
        stage.style.cssText = "position:relative;flex:1;min-width:0;height:100%";
        stage.append(this.view.element);
        this.stage = stage;
        this.body.style.cssText = "display:flex;flex:1;min-height:0";
        this.body.append(this.left, stage);
        const frame = el("div", {}, this.topBar(), this.body);
        frame.style.cssText = "display:flex;flex-direction:column;height:100%";
        this.dialog.append(frame);
        this.node.onPropertyChanged(this.onNodeChanged);
        this.view.onProgress = (done, total) => {
            this.progressText = `${done} / ${total}`;
            this.showStatus();
        };
    }

    private progressText = "";
    private programText = "";
    private showStatus() {
        this.status.textContent = [this.programText, this.progressText].filter((x) => x).join(" · ");
    }

    private reveal() {
        MillEditor.lastOpened = this.node.id;
        if (!this.dialog.isConnected) document.body.append(this.dialog);
        if (!this.dialog.open) this.dialog.show();
        this.render();
        this.schedule();
    }

    /** Undo / redo replaced the job under us; a rename shows on the tab. */
    private readonly onNodeChanged = (property: string | number | symbol) => {
        if (property === "name") workspaceTabs.changed();
        if (property === "content" && this.node.content !== JSON.stringify(this.data)) this.reload();
    };

    private close() {
        this.node.removePropertyChanged(this.onNodeChanged);
        this.view.dispose();
        this.control.dispose();
        void this.vfdPort?.close();
        this.dialog.close();
        this.dialog.remove();
        MillEditor.editors.delete(this.node.id);
        workspaceTabs.remove(this.node.id);
    }

    /** The job changed: stored (one undo step), the panel and the preview again. */
    private commit(rerender = true) {
        const content = JSON.stringify(this.data);
        if (content !== this.node.content)
            Transaction.execute(this.node.document, "mill.edit", () => {
                this.node.content = content;
            });
        if (rerender) this.render();
        this.schedule();
    }

    private schedule() {
        clearTimeout(this.regen);
        this.regen = window.setTimeout(() => void this.preview(), 250);
    }

    private program() {
        return millProgram(this.data.operations, this.data.tools, this.data.machine);
    }

    private async preview() {
        const p = this.program();
        const min = Math.floor(p.seconds / 60);
        const sec = Math.round(p.seconds % 60);
        this.programText = t("mill.estimate", `${min}:${String(sec).padStart(2, "0")}`);
        if (p.skipped.length > 0) this.programText += ` · ${t("mill.skipped", p.skipped.length)}`;
        this.showStatus();
        await this.view.show(this.data, p);
    }

    private readonly modeButtons = el("span");

    private setMode(mode: "prepare" | "control") {
        this.mode = mode;
        if (mode === "control") {
            this.control.element.style.cssText = "flex:1.4;min-width:0;height:100%";
            this.control.show();
            this.body.replaceChildren(this.control.element, this.stage);
        } else this.body.replaceChildren(this.left, this.stage);
        this.showModes();
    }

    private showModes() {
        const make = (m: "prepare" | "control") => {
            const b = button(m === "prepare" ? "cnc.mode.prepare" : "cnc.mode.control", () =>
                this.setMode(m),
            );
            b.style.fontWeight = "800";
            if (m === this.mode) {
                b.style.background = "var(--primary-color)";
                b.style.color = "#fff";
            }
            return b;
        };
        this.modeButtons.style.cssText = "display:inline-flex;gap:4px;margin-right:8px";
        this.modeButtons.replaceChildren(make("prepare"), make("control"));
    }

    // ---- top bar ----------------------------------------------------------------------------

    private topBar(): HTMLElement {
        const speeds = [10, 50, 200, 1000, 5000];
        const speed = select(
            speeds.map((v) => ({ value: String(v), label: `×${v / 50}` })),
            "50",
            (v) => (this.view.speed = Number(v)),
        );
        const bar = el(
            "div",
            {},
            button("mill.toModel", () => workspaceTabs.activate(undefined)),
            this.modeButtons,
            button("mill.importSvg", () => void this.importSvgFile()),
            button("mill.saveGcode", () => this.saveGcode()),
            el("span", { textContent: "  " }),
            button("mill.play", () => this.view.play()),
            button("mill.pause", () => this.view.pause()),
            button("mill.restart", () => this.view.restart()),
            button("mill.finish", () => this.view.finish()),
            el("span", { textContent: t("mill.speed") }),
            speed,
            this.status,
        );
        this.showModes();
        bar.className = style.panel;
        bar.style.cssText =
            "display:flex;flex-direction:row;width:auto;border-left:none;gap:6px;align-items:center;flex:none;min-height:44px;padding:6px 10px;box-sizing:border-box;flex-wrap:wrap";
        return bar;
    }

    private async importSvgFile() {
        const input = el("input", { type: "file", accept: ".svg,image/svg+xml" });
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            const svg = importSvg(await file.text());
            if (!svg || svg.paths.length === 0) {
                PubSub.default.pub("showToast", "mill.svgEmpty" as never);
                return;
            }
            this.addShape(
                file.name.replace(/\.svg$/i, ""),
                svg.paths.map((p) => p.points),
            );
        };
        input.click();
    }

    private addFromModel(bodyId: string, view: ModelView) {
        const outline = bodyOutline(this.node.document, bodyId, view);
        const node = this.node.document.modelManager.findNode((n) => n.id === bodyId);
        if (!outline || outline.paths.length === 0) {
            PubSub.default.pub("showToast", "mill.modelEmpty" as never);
            return;
        }
        this.addShape(
            node?.name ?? "",
            outline.paths.map((p) => p.points),
        );
    }

    /** A shape onto the stock (at its corner), and the stock grown to hold it if it must. */
    private addShape(name: string, rings: Pt[][]) {
        const id = Id.generate();
        const s = this.data.stock;
        const margin = 5;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const r of rings)
            for (const p of r) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            }
        const dx = s.minX + margin - minX;
        const dy = s.minY + margin - minY;
        const moved = rings.map((r) => r.map((p) => ({ x: p.x + dx, y: p.y + dy })));
        s.width = Math.max(s.width, maxX - minX + 2 * margin);
        s.height = Math.max(s.height, maxY - minY + 2 * margin);
        this.data.shapes.push({ id, name, rings: moved, points: circleCentres(moved) });
        this.commit();
    }

    private saveGcode() {
        const p = this.program();
        const blob = new Blob([p.gcode], { type: "text/plain" });
        const a = el("a", { href: URL.createObjectURL(blob), download: `${this.node.name}.nc` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    // ---- left panel -------------------------------------------------------------------------

    private render() {
        const tabs = el(
            "div",
            { className: style.buttons },
            ...(["ops", "tools", "machine", "spindle"] as Panel[]).map((p) => {
                const b = button(`mill.panel.${p}`, () => {
                    this.panel = p;
                    this.render();
                });
                if (p === this.panel) b.style.fontWeight = "700";
                return b;
            }),
        );
        const content =
            this.panel === "ops"
                ? this.opsPanel()
                : this.panel === "tools"
                  ? this.toolsPanel()
                  : this.panel === "machine"
                    ? this.machinePanel()
                    : this.spindlePanel();
        this.left.replaceChildren(tabs, ...content);
    }

    private opsPanel(): HTMLElement[] {
        const out: HTMLElement[] = [heading("mill.shapes")];
        const bodies = this.node.document.modelManager.findNodes(
            (n) => n instanceof ShapeNode && !n.isReferenceGeometry && n.shape.isOk,
        );
        if (bodies.length > 0) {
            let body = bodies[0].id;
            let view: ModelView = "top";
            out.push(
                el(
                    "div",
                    { className: style.pair },
                    select(
                        bodies.map((b) => ({ value: b.id, label: b.name })),
                        body,
                        (v) => (body = v),
                    ),
                    select(
                        (["top", "front", "right"] as ModelView[]).map((v) => ({
                            value: v,
                            label: t(`laser.fromModel.${v}`),
                        })),
                        view,
                        (v) => (view = v),
                    ),
                ),
                el(
                    "div",
                    { className: style.buttons },
                    button("mill.fromModel", () => this.addFromModel(body, view)),
                ),
            );
        }
        if (this.data.shapes.length === 0)
            out.push(el("div", { className: style.muted, textContent: t("mill.shapes.none") }));
        for (const s of this.data.shapes)
            out.push(
                el(
                    "div",
                    { className: style.pair },
                    el("span", {
                        textContent: `${s.name} (${s.rings.length}${s.points.length ? `, ⌀×${s.points.length}` : ""})`,
                    }),
                    button("mill.delete", () => {
                        this.data.shapes = this.data.shapes.filter((x) => x.id !== s.id);
                        this.commit();
                    }),
                ),
            );

        out.push(heading("mill.operations"));
        out.push(
            el(
                "div",
                { className: style.buttons },
                ...OPERATION_KINDS.map((k) =>
                    button(`mill.op.${k}`, () => this.addOperation(k), `mill.op.${k}.hint`),
                ),
            ),
        );
        this.data.operations.forEach((op, i) => {
            const tool = this.data.tools.find((x) => x.id === op.toolId);
            const line = el(
                "div",
                { className: style.pair },
                el("span", {
                    textContent: `${i + 1}. ${op.name || t(`mill.op.${op.kind}`)} — ${tool ? `T${tool.number}` : "?"} ${op.hidden ? "(откл.)" : ""}`,
                    onclick: () => {
                        this.selected = this.selected === op.id ? undefined : op.id;
                        this.render();
                    },
                }),
                button("mill.up", () => this.moveOp(i, -1)),
                button("mill.down", () => this.moveOp(i, 1)),
            );
            line.style.cursor = "pointer";
            if (op.id === this.selected) line.style.fontWeight = "700";
            out.push(line);
            if (op.id === this.selected) out.push(...this.opEditor(op));
        });
        return out;
    }

    private moveOp(i: number, d: number) {
        const list = this.data.operations;
        const j = i + d;
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        this.commit();
    }

    private addOperation(kind: OperationKind) {
        const shape = this.data.shapes.at(-1);
        const tool =
            this.data.tools.find((x) =>
                kind === "drill"
                    ? x.kind === "drill"
                    : kind === "chamfer" || kind === "vcarve"
                      ? x.kind === "vbit" || x.kind === "chamfer"
                      : x.kind === "flat",
            ) ?? this.data.tools[0];
        const op: CamOperation = {
            id: Id.generate(),
            name: "",
            kind,
            toolId: tool?.id ?? "",
            depth: kind === "facing" ? 0.5 : kind === "chamfer" ? 0 : kind === "vcarve" ? 2 : 3,
            side: kind === "pocket" ? "inside" : "outside",
            climb: true,
            ramp: kind === "profile" || kind === "pocket",
            allowance: 0,
            tabs: { count: 0, width: 4, height: 1 },
            peck: kind === "drill" ? 2 : 0,
            rings: [],
            points: [],
            holeDiameter: kind === "helix" ? 8 : kind === "thread" ? 8 : undefined,
            pitch: kind === "thread" ? 1.25 : undefined,
            chamferWidth: kind === "chamfer" ? 0.5 : undefined,
        };
        if (kind === "facing") {
            const s = this.data.stock;
            op.rings = [
                [
                    { x: s.minX, y: s.minY },
                    { x: s.minX + s.width, y: s.minY },
                    { x: s.minX + s.width, y: s.minY + s.height },
                    { x: s.minX, y: s.minY + s.height },
                ],
            ];
        } else if (shape) this.useShape(op, shape.id);
        this.data.operations.push(op);
        this.selected = op.id;
        this.commit();
    }

    private useShape(op: CamOperation, shapeId: string) {
        const shape = this.data.shapes.find((s) => s.id === shapeId);
        op.shapeId = shapeId;
        if (!shape) return;
        op.rings = shape.rings.map((r) => r.map((p) => ({ ...p })));
        op.points = POINT_KINDS.includes(op.kind)
            ? shape.points.length > 0
                ? shape.points.map((p) => ({ ...p }))
                : shape.rings
                      .filter((r) => Math.abs(ringArea(r)) > 0)
                      .map((r) => ({
                          x: r.reduce((s, p) => s + p.x, 0) / r.length,
                          y: r.reduce((s, p) => s + p.y, 0) / r.length,
                      }))
            : [];
    }

    private opEditor(op: CamOperation): HTMLElement[] {
        const edit = (f: () => void) => {
            f();
            this.commit();
        };
        const tool = this.data.tools.find((x) => x.id === op.toolId);
        const optional = (
            key: string,
            value: number | undefined,
            fallback: number | undefined,
            set: (v: number | undefined) => void,
        ) =>
            row(
                key,
                numberField(value ?? fallback ?? 0, (v) => edit(() => set(v > 0 ? v : undefined)), {
                    min: 0,
                }),
            );
        const rows: HTMLElement[] = [
            row(
                "mill.name",
                Object.assign(el("input", { type: "text", value: op.name }), {
                    onchange: (e: Event) => edit(() => (op.name = (e.target as HTMLInputElement).value)),
                }),
            ),
            row(
                "mill.tool",
                select(
                    this.data.tools.map((x) => ({ value: x.id, label: `T${x.number} ${x.name}` })),
                    op.toolId,
                    (v) => edit(() => (op.toolId = v)),
                ),
            ),
        ];
        if (op.kind !== "facing")
            rows.push(
                row(
                    "mill.shape",
                    select(
                        [
                            { value: "", label: "—" },
                            ...this.data.shapes.map((s) => ({ value: s.id, label: s.name })),
                        ],
                        op.shapeId ?? "",
                        (v) => edit(() => this.useShape(op, v)),
                    ),
                ),
            );
        rows.push(
            row(
                "mill.depth",
                numberField(op.depth, (v) => edit(() => (op.depth = Math.max(0, v))), { min: 0 }),
            ),
        );
        if (op.kind === "profile" || op.kind === "chamfer")
            rows.push(
                row(
                    "mill.side",
                    select(
                        PROFILE_SIDES.map((s) => ({ value: s, label: t(`mill.side.${s}`) })),
                        op.side,
                        (v) => edit(() => (op.side = v)),
                    ),
                ),
            );
        if (op.kind === "profile" || op.kind === "pocket" || op.kind === "chamfer" || op.kind === "vcarve")
            rows.push(
                row(
                    "mill.climb",
                    checkbox(op.climb, (v) => edit(() => (op.climb = v))),
                ),
            );
        if (op.kind === "profile" || op.kind === "pocket")
            rows.push(
                row(
                    "mill.ramp",
                    checkbox(op.ramp, (v) => edit(() => (op.ramp = v))),
                ),
                row(
                    "mill.allowance",
                    numberField(op.allowance, (v) => edit(() => (op.allowance = v))),
                ),
            );
        if (op.kind === "profile")
            rows.push(
                el(
                    "div",
                    { className: style.pair },
                    row(
                        "mill.tabs.count",
                        numberField(
                            op.tabs.count,
                            (v) => edit(() => (op.tabs.count = Math.max(0, Math.round(v)))),
                            { min: 0, step: 1 },
                        ),
                    ),
                    row(
                        "mill.tabs.width",
                        numberField(op.tabs.width, (v) => edit(() => (op.tabs.width = v))),
                    ),
                    row(
                        "mill.tabs.height",
                        numberField(op.tabs.height, (v) => edit(() => (op.tabs.height = v))),
                    ),
                ),
            );
        if (op.kind === "drill")
            rows.push(
                row(
                    "mill.peck",
                    numberField(op.peck, (v) => edit(() => (op.peck = Math.max(0, v)))),
                ),
            );
        if (op.kind === "helix" || op.kind === "thread")
            rows.push(
                row(
                    "mill.hole",
                    numberField(op.holeDiameter ?? 8, (v) => edit(() => (op.holeDiameter = v))),
                ),
            );
        if (op.kind === "thread")
            rows.push(
                row(
                    "mill.pitch",
                    numberField(op.pitch ?? 1.25, (v) => edit(() => (op.pitch = v))),
                ),
            );
        if (op.kind === "chamfer")
            rows.push(
                row(
                    "mill.chamferWidth",
                    numberField(op.chamferWidth ?? 0.5, (v) => edit(() => (op.chamferWidth = v))),
                ),
            );
        rows.push(
            heading("mill.cutting"),
            el(
                "div",
                { className: style.pair },
                optional("mill.rpm", op.rpm, tool?.rpm, (v) => (op.rpm = v)),
                optional("mill.feed", op.feed, tool?.feed, (v) => (op.feed = v)),
            ),
            el(
                "div",
                { className: style.pair },
                optional("mill.plunge", op.plunge, tool?.plunge, (v) => (op.plunge = v)),
                optional("mill.stepDown", op.stepDown, tool?.stepDown, (v) => (op.stepDown = v)),
                optional("mill.stepOver", op.stepOver, tool?.stepOver, (v) => (op.stepOver = v)),
            ),
            el(
                "div",
                { className: style.buttons },
                button(op.hidden ? "mill.enable" : "mill.disable", () =>
                    edit(() => (op.hidden = op.hidden ? undefined : true)),
                ),
                button("mill.delete", () => {
                    this.data.operations = this.data.operations.filter((x) => x.id !== op.id);
                    this.selected = undefined;
                    this.commit();
                }),
            ),
        );
        return rows;
    }

    private toolsPanel(): HTMLElement[] {
        const out: HTMLElement[] = [
            heading("mill.panel.tools"),
            el(
                "div",
                { className: style.buttons },
                button("mill.tools.add", () => {
                    const n = Math.max(0, ...this.data.tools.map((x) => x.number)) + 1;
                    this.data.tools.push({
                        ...this.data.tools[0],
                        id: newToolId(),
                        number: n,
                        name: `${t("mill.tool")} ${n}`,
                    });
                    this.commit();
                }),
                button(
                    "mill.tools.save",
                    () => {
                        storeTools(this.data.tools);
                        PubSub.default.pub("showToast", "mill.tools.saved" as never);
                    },
                    "mill.tools.save.hint",
                ),
                button(
                    "mill.tools.load",
                    () => {
                        this.data.tools = loadTools();
                        this.commit();
                    },
                    "mill.tools.load.hint",
                ),
            ),
        ];
        for (const tool of this.data.tools) {
            const edit = (f: (x: CamTool) => void) => {
                f(tool);
                this.commit();
            };
            const num = (key: string, get: (x: CamTool) => number, set: (x: CamTool, v: number) => void) =>
                row(
                    key,
                    numberField(get(tool), (v) => edit((x) => set(x, v)), { min: 0 }),
                );
            out.push(
                el("h3", { textContent: `T${tool.number} ${tool.name}` }),
                row(
                    "mill.name",
                    Object.assign(el("input", { type: "text", value: tool.name }), {
                        onchange: (e: Event) => edit((x) => (x.name = (e.target as HTMLInputElement).value)),
                    }),
                ),
                el(
                    "div",
                    { className: style.pair },
                    num(
                        "mill.tool.number",
                        (x) => x.number,
                        (x, v) => (x.number = Math.round(v)),
                    ),
                    row(
                        "mill.tool.kind",
                        select(
                            TOOL_KINDS.map((k) => ({ value: k, label: t(`mill.tool.kind.${k}`) })),
                            tool.kind,
                            (v) => edit((x) => (x.kind = v)),
                        ),
                    ),
                ),
                el(
                    "div",
                    { className: style.pair },
                    num(
                        "mill.tool.diameter",
                        (x) => x.diameter,
                        (x, v) => (x.diameter = Math.max(0.01, v)),
                    ),
                    num(
                        "mill.tool.flutes",
                        (x) => x.flutes,
                        (x, v) => (x.flutes = Math.max(1, Math.round(v))),
                    ),
                    num(
                        "mill.tool.fluteLength",
                        (x) => x.fluteLength,
                        (x, v) => (x.fluteLength = v),
                    ),
                ),
                el(
                    "div",
                    { className: style.pair },
                    num(
                        "mill.tool.angle",
                        (x) => x.angle,
                        (x, v) => (x.angle = v),
                    ),
                    num(
                        "mill.tool.corner",
                        (x) => x.cornerRadius,
                        (x, v) => (x.cornerRadius = v),
                    ),
                ),
                el(
                    "div",
                    { className: style.pair },
                    num(
                        "mill.rpm",
                        (x) => x.rpm,
                        (x, v) => (x.rpm = v),
                    ),
                    num(
                        "mill.feed",
                        (x) => x.feed,
                        (x, v) => (x.feed = v),
                    ),
                    num(
                        "mill.plunge",
                        (x) => x.plunge,
                        (x, v) => (x.plunge = v),
                    ),
                ),
                el(
                    "div",
                    { className: style.pair },
                    num(
                        "mill.stepDown",
                        (x) => x.stepDown,
                        (x, v) => (x.stepDown = v),
                    ),
                    num(
                        "mill.stepOver",
                        (x) => x.stepOver,
                        (x, v) => (x.stepOver = v),
                    ),
                ),
                el(
                    "div",
                    { className: style.buttons },
                    button("mill.delete", () => {
                        if (this.data.tools.length <= 1) return;
                        this.data.tools = this.data.tools.filter((x) => x.id !== tool.id);
                        this.commit();
                    }),
                ),
            );
        }
        return out;
    }

    private machinePanel(): HTMLElement[] {
        const m = this.data.machine;
        const s = this.data.stock;
        const edit = (f: () => void) => {
            f();
            this.commit();
        };
        return [
            heading("mill.stock"),
            el(
                "div",
                { className: style.pair },
                row(
                    "mill.stock.width",
                    numberField(s.width, (v) => edit(() => (s.width = Math.max(1, v)))),
                ),
                row(
                    "mill.stock.height",
                    numberField(s.height, (v) => edit(() => (s.height = Math.max(1, v)))),
                ),
                row(
                    "mill.stock.thickness",
                    numberField(-s.bottom, (v) => edit(() => (s.bottom = -Math.abs(v)))),
                ),
            ),
            el(
                "div",
                { className: style.pair },
                row(
                    "mill.stock.x",
                    numberField(s.minX, (v) => edit(() => (s.minX = v))),
                ),
                row(
                    "mill.stock.y",
                    numberField(s.minY, (v) => edit(() => (s.minY = v))),
                ),
            ),
            el("div", { className: style.muted, textContent: t("mill.stock.hint") }),
            heading("mill.cnc"),
            el(
                "div",
                { className: style.buttons },
                button("cnc.open", () => this.setMode("control")),
            ),
            heading("mill.machine"),
            row(
                "mill.post",
                select(
                    POST_KINDS.map((p) => ({ value: p, label: t(`mill.post.${p}`) })),
                    m.post,
                    (v) => edit(() => (m.post = v)),
                ),
            ),
            row(
                "mill.toolChange",
                select(
                    (["pause", "m6"] as const).map((v) => ({ value: v, label: t(`mill.toolChange.${v}`) })),
                    m.toolChange,
                    (v) => edit(() => (m.toolChange = v)),
                ),
            ),
            row(
                "mill.air",
                select(
                    (["off", "m7", "m8"] as const).map((v) => ({ value: v, label: t(`mill.air.${v}`) })),
                    m.air,
                    (v) => edit(() => (m.air = v)),
                ),
            ),
            el(
                "div",
                { className: style.pair },
                row(
                    "mill.safeZ",
                    numberField(m.heights.safeZ, (v) => edit(() => (m.heights.safeZ = v))),
                ),
                row(
                    "mill.clearance",
                    numberField(m.heights.clearance, (v) => edit(() => (m.heights.clearance = v))),
                ),
            ),
            el(
                "div",
                { className: style.pair },
                row(
                    "mill.spindleDelay",
                    numberField(m.spindleDelay, (v) => edit(() => (m.spindleDelay = Math.max(0, v)))),
                ),
                row(
                    "mill.rapidFeed",
                    numberField(m.rapidFeed, (v) => edit(() => (m.rapidFeed = Math.max(1, v)))),
                ),
            ),
        ];
    }

    private spindlePanel(): HTMLElement[] {
        const v = this.data.vfd;
        const edit = (f: () => void) => {
            f();
            this.commit();
            if (this.vfd) this.vfd.settings = v;
        };
        let rpm = 12000;
        const connected = this.vfd !== undefined;
        return [
            heading("mill.vfd"),
            el("div", { className: style.muted, textContent: t("mill.vfd.hint") }),
            row(
                "mill.vfd.enabled",
                checkbox(v.enabled, (x) => edit(() => (v.enabled = x))),
            ),
            row(
                "mill.vfd.preset",
                select(
                    [
                        { value: "", label: "—" },
                        ...Object.keys(VFD_PRESETS).map((k) => ({ value: k, label: k })),
                    ],
                    "",
                    (k) => edit(() => Object.assign(v, VFD_PRESETS[k] ?? {})),
                ),
            ),
            row(
                "mill.vfd.protocol",
                select(
                    (["huanyang", "modbus"] as const).map((p) => ({
                        value: p,
                        label: t(`mill.vfd.protocol.${p}`),
                    })),
                    v.protocol,
                    (x) => edit(() => (v.protocol = x)),
                ),
            ),
            el(
                "div",
                { className: style.pair },
                row(
                    "mill.vfd.address",
                    numberField(v.address, (x) => edit(() => (v.address = Math.round(x))), {
                        min: 1,
                        step: 1,
                    }),
                ),
                row(
                    "mill.vfd.baud",
                    numberField(v.baudRate, (x) => edit(() => (v.baudRate = Math.round(x))), { step: 1 }),
                ),
            ),
            el(
                "div",
                { className: style.pair },
                row(
                    "mill.vfd.maxRpm",
                    numberField(v.maxRpm, (x) => edit(() => (v.maxRpm = x))),
                ),
                row(
                    "mill.vfd.maxHz",
                    numberField(v.maxHz, (x) => edit(() => (v.maxHz = x))),
                ),
                row(
                    "mill.vfd.minRpm",
                    numberField(v.minRpm, (x) => edit(() => (v.minRpm = x))),
                ),
            ),
            ...(v.protocol === "modbus"
                ? [
                      el(
                          "div",
                          { className: style.pair },
                          row(
                              "mill.vfd.controlReg",
                              numberField(
                                  v.controlRegister,
                                  (x) => edit(() => (v.controlRegister = Math.round(x))),
                                  { step: 1 },
                              ),
                          ),
                          row(
                              "mill.vfd.freqReg",
                              numberField(
                                  v.frequencyRegister,
                                  (x) => edit(() => (v.frequencyRegister = Math.round(x))),
                                  { step: 1 },
                              ),
                          ),
                          row(
                              "mill.vfd.scale",
                              numberField(v.frequencyScale, (x) => edit(() => (v.frequencyScale = x))),
                          ),
                      ),
                      el(
                          "div",
                          { className: style.pair },
                          row(
                              "mill.vfd.fwd",
                              numberField(v.runForward, (x) => edit(() => (v.runForward = Math.round(x))), {
                                  step: 1,
                              }),
                          ),
                          row(
                              "mill.vfd.rev",
                              numberField(v.runReverse, (x) => edit(() => (v.runReverse = Math.round(x))), {
                                  step: 1,
                              }),
                          ),
                          row(
                              "mill.vfd.stopValue",
                              numberField(v.stop, (x) => edit(() => (v.stop = Math.round(x))), { step: 1 }),
                          ),
                      ),
                  ]
                : []),
            heading("mill.vfd.test"),
            row(
                "mill.rpm",
                numberField(rpm, (x) => (rpm = x)),
            ),
            el(
                "div",
                { className: style.buttons },
                connected
                    ? button("mill.vfd.disconnect", () => void this.disconnectVfd())
                    : button("mill.vfd.connect", () => void this.connectVfd()),
                button("mill.vfd.run", () => void this.vfd?.run(rpm)),
                button("mill.vfd.stop", () => void this.vfd?.stop()),
                button("mill.vfd.read", async () => {
                    const r = await this.vfd?.readRpm();
                    PubSub.default.pub("showToast", "mill.vfd.speed" as never, r ?? "—");
                }),
            ),
            el("div", {
                className: style.muted,
                textContent: `${t("mill.vfd.frames")}: ${commandFrames(v, { kind: "run", rpm })
                    .map((f) => [...f].map((b) => b.toString(16).padStart(2, "0")).join(" "))
                    .join(" | ")}`,
            }),
        ];
    }

    /** The RS485 adapter's serial port, bytes in and out with a time limit per reply. */
    private async connectVfd() {
        const serial = (navigator as unknown as { serial?: { requestPort(): Promise<any> } }).serial;
        if (!serial) {
            PubSub.default.pub("showToast", "mill.vfd.noSerial" as never);
            return;
        }
        try {
            const port = await serial.requestPort();
            await port.open({ baudRate: this.data.vfd.baudRate, dataBits: 8, stopBits: 1, parity: "none" });
            const writer = port.writable.getWriter();
            const reader = port.readable.getReader();
            let buffer: number[] = [];
            let waiting: (() => void) | undefined;
            void (async () => {
                for (;;) {
                    const { value, done } = await reader
                        .read()
                        .catch(() => ({ value: undefined, done: true }));
                    if (done) break;
                    if (value) buffer.push(...value);
                    waiting?.();
                }
            })();
            const transport: VfdTransport = {
                write: async (bytes) => {
                    buffer = [];
                    await writer.write(bytes);
                },
                read: (ms) =>
                    new Promise((resolve) => {
                        const timer = setTimeout(() => {
                            waiting = undefined;
                            resolve(buffer.length > 0 ? Uint8Array.from(buffer) : undefined);
                        }, ms);
                        waiting = () => {
                            if (buffer.length >= 7) {
                                clearTimeout(timer);
                                waiting = undefined;
                                resolve(Uint8Array.from(buffer));
                            }
                        };
                    }),
            };
            this.vfd = new VfdSpindle(transport, this.data.vfd);
            this.vfdPort = {
                close: async () => {
                    reader.releaseLock();
                    writer.releaseLock();
                    await port.close();
                },
            };
            this.render();
        } catch (e) {
            PubSub.default.pub("showToast", "mill.vfd.failed" as never, String(e));
        }
    }

    private async disconnectVfd() {
        await this.vfd?.stop().catch(() => {});
        await this.vfdPort?.close().catch(() => {});
        this.vfd = undefined;
        this.vfdPort = undefined;
        this.render();
    }

    /** Called by the undo stack: the job replaced under us. */
    reload() {
        this.data = parseMillJob(this.node.content);
        this.render();
        this.schedule();
    }
}
