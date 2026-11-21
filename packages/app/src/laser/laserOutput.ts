// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { download, PubSub } from "@chili3d/core";
import { type GcodeResult, generateGcode } from "./gcode";
import type { LaserJobData } from "./laserData";
import style from "./laserEditor.module.css";
import { button, checkbox, el, heading, numberField, row, select, t } from "./laserUi";
import type { MachineProfile } from "./machineProfile";
import { type GrayImage, grayFromRgba } from "./raster";
import { formatDuration, type Move, parseToolpath, type ToolpathStats, toolpathStats } from "./toolpath";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Pictures larger than this many pixels on a side are read scaled down (40 lines/mm over 100 mm). */
const MAX_IMAGE_SIDE = 4000;

/** Burn shades in the preview, light to dark. */
const POWER_BUCKETS = 8;

export interface LaserOutputHost {
    readonly data: LaserJobData;
    readonly profile: MachineProfile;
    readonly jobName: string;
    readonly previewGroup: SVGGElement;
    setProfile(edit: (p: MachineProfile) => void): void;
    setStatus(text: string): void;
    renderPanel(): void;
}

export interface GeneratedJob extends GcodeResult {
    moves: Move[];
    stats: ToolpathStats;
    /** The pictures' pixels it was made from, by object id. */
    images: ReadonlyMap<string, GrayImage>;
}

/** A picture's pixels as lightness, read through a canvas (scaled down past `MAX_IMAGE_SIDE`). */
export async function readGray(dataUrl: string): Promise<GrayImage | undefined> {
    const image = await new Promise<HTMLImageElement | undefined>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(undefined);
        img.src = dataUrl;
    });
    if (image === undefined || image.naturalWidth === 0) return undefined;
    const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    const w = Math.max(1, Math.round(image.naturalWidth * k));
    const h = Math.max(1, Math.round(image.naturalHeight * k));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext("2d");
    if (context === null) return undefined;
    context.drawImage(image, 0, 0, w, h);
    return grayFromRgba(context.getImageData(0, 0, w, h).data, w, h);
}

/**
 * The job's G-code: generated on request (and again whenever the job or the machine changed),
 * drawn over the bed as the head will move — rapids dashed, burns shaded by power — timed, and
 * saved as a file. Its panel holds the machine values the G-code depends on.
 */
export class LaserOutput {
    private result: GeneratedJob | undefined;
    private readonly grays = new Map<string, GrayImage>();
    private extension: "gcode" | "nc" = "gcode";
    showPreview = true;
    private busy = false;

    constructor(private readonly host: LaserOutputHost) {}

    get current(): GeneratedJob | undefined {
        return this.result;
    }

    /** The job or the machine changed: the G-code no longer matches it. */
    invalidate() {
        if (this.result === undefined) return;
        this.result = undefined;
        this.host.previewGroup.replaceChildren();
    }

    async generate(): Promise<GeneratedJob | undefined> {
        if (this.busy) return undefined;
        this.busy = true;
        try {
            const images = new Map<string, GrayImage>();
            for (const o of this.host.data.objects) {
                if (o.kind !== "image" || o.hidden) continue;
                let gray = this.grays.get(o.dataUrl);
                if (gray === undefined) {
                    gray = await readGray(o.dataUrl);
                    if (gray !== undefined) this.grays.set(o.dataUrl, gray);
                }
                if (gray !== undefined) images.set(o.id, gray);
            }
            const profile = this.host.profile;
            const gcode = generateGcode(this.host.data, profile, images);
            const moves = parseToolpath(gcode.lines, profile.rapid);
            this.result = { ...gcode, moves, stats: toolpathStats(moves, profile), images };
            for (const warning of gcode.warnings) PubSub.default.pub("showToast", warning as never);
            this.drawPreview();
            this.host.setStatus(this.summary());
            this.host.renderPanel();
            return this.result;
        } finally {
            this.busy = false;
        }
    }

    summary(): string {
        const r = this.result;
        if (r === undefined) return "";
        if (this.host.profile.controller === "jcz")
            return t(
                "laser.summary.galvo",
                formatDuration(r.stats.seconds),
                (r.stats.burnLength / 1000).toFixed(2),
                (r.stats.travelLength / 1000).toFixed(2),
            );
        return t(
            "laser.summary",
            formatDuration(r.stats.seconds),
            (r.stats.burnLength / 1000).toFixed(2),
            (r.stats.travelLength / 1000).toFixed(2),
            r.lines.length,
        );
    }

    async save() {
        const r = this.result ?? (await this.generate());
        if (r === undefined) return;
        const name = this.host.jobName.replace(/[\\/:*?"<>|]/g, "_") || "laser";
        download([`${r.lines.join("\n")}\n`], `${name}.${this.extension}`);
    }

    drawPreview() {
        const g = this.host.previewGroup;
        g.replaceChildren();
        const r = this.result;
        if (r === undefined || !this.showPreview) return;
        const maxS = this.host.profile.maxS;
        const rapid: string[] = [];
        const idle: string[] = [];
        const burns: string[][] = Array.from({ length: POWER_BUCKETS }, () => []);
        for (const m of r.moves) {
            const d = `M${m.x0.toFixed(3)} ${m.y0.toFixed(3)}L${m.x1.toFixed(3)} ${m.y1.toFixed(3)}`;
            if (m.rapid) rapid.push(d);
            else if (m.power <= 0) idle.push(d);
            else {
                const bucket = Math.min(POWER_BUCKETS - 1, Math.floor((m.power / maxS) * POWER_BUCKETS));
                burns[bucket].push(d);
            }
        }
        const path = (d: string[], attributes: Record<string, string>) => {
            if (d.length === 0) return;
            const e = document.createElementNS(SVG_NS, "path");
            e.setAttribute("d", d.join(""));
            e.setAttribute("fill", "none");
            e.setAttribute("vector-effect", "non-scaling-stroke");
            for (const [k, v] of Object.entries(attributes)) e.setAttribute(k, v);
            g.append(e);
        };
        path(rapid, { stroke: "#2b8a3e", "stroke-width": "0.8", "stroke-dasharray": "4 3", opacity: "0.8" });
        path(idle, { stroke: "#adb5bd", "stroke-width": "0.8" });
        burns.forEach((d, i) =>
            path(d, {
                stroke: "#c92a2a",
                "stroke-width": "1.2",
                opacity: String(0.25 + (0.75 * (i + 1)) / POWER_BUCKETS),
            }),
        );
    }

    /** The G-code tab: machine values the program depends on, generate / save, and the numbers. */
    panel(): HTMLElement {
        const p = this.host.profile;
        const set = (edit: (q: MachineProfile) => void) => this.host.setProfile(edit);
        const r = this.result;
        const info: HTMLElement[] = [];
        if (r !== undefined) {
            info.push(el("div", { className: style.muted, textContent: this.summary() }));
            for (const w of r.warnings) info.push(el("div", { className: style.warning, textContent: t(w) }));
        } else {
            info.push(el("div", { className: style.muted, textContent: t("laser.output.stale") }));
        }
        const preview = checkbox(this.showPreview, (v) => {
            this.showPreview = v;
            this.drawPreview();
        });
        if (p.controller === "jcz") {
            // a galvo board takes the job itself: no G-code, no GRBL settings — the preview and the time
            return el(
                "div",
                {},
                heading("laser.output.galvo"),
                el(
                    "div",
                    { className: style.buttons },
                    button("laser.output.calculate", () => void this.generate()),
                ),
                row("laser.preview", preview),
                ...info,
            );
        }
        return el(
            "div",
            {},
            heading("laser.output"),
            el(
                "div",
                { className: style.buttons },
                button("laser.generate", () => void this.generate()),
                button("laser.save", () => void this.save()),
                select(
                    [
                        { value: "gcode", label: ".gcode" },
                        { value: "nc", label: ".nc" },
                    ],
                    this.extension,
                    (v) => (this.extension = v),
                ),
            ),
            row("laser.preview", preview),
            ...info,
            heading("laser.machine.settings"),
            row(
                "laser.machine.maxS",
                numberField(p.maxS, (v) => set((q) => (q.maxS = v)), { min: 1, step: 1 }),
            ),
            row(
                "laser.machine.dynamic",
                checkbox(p.dynamicPower, (v) => set((q) => (q.dynamicPower = v))),
            ),
            row(
                "laser.machine.accel",
                numberField(p.accel, (v) => set((q) => (q.accel = v)), { min: 1 }),
            ),
            row(
                "laser.machine.rapid",
                numberField(p.rapid, (v) => set((q) => (q.rapid = v)), { min: 1 }),
            ),
            row(
                "laser.machine.junction",
                numberField(p.junctionDeviation, (v) => set((q) => (q.junctionDeviation = v)), { min: 0 }),
            ),
            row(
                "laser.machine.returnHome",
                checkbox(p.returnHome, (v) => set((q) => (q.returnHome = v))),
            ),
            el("div", { className: style.muted, textContent: t("laser.machine.laserModeHint") }),
        );
    }
}
