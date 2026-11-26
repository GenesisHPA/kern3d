// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Point3, ProgramPath } from "./gcodePath";

/** What the controller says about the machine ($$): travel, homing, soft limits. */
export interface MachineSettings {
    /** Travel per axis, mm ($130–$132): the machine space is [−travel, 0] after homing (GRBL). */
    travel?: Point3;
    homing: boolean;
    softLimits: boolean;
    hardLimits: boolean;
}

/** `$130=200.000` and the like, collected into the settings. */
export function readSetting(settings: Map<number, number>, line: string): boolean {
    const m = /^\$(\d+)=(-?[\d.]+)/.exec(line.trim());
    if (!m) return false;
    settings.set(Number(m[1]), Number(m[2]));
    return true;
}

export function machineSettings(s: Map<number, number>): MachineSettings {
    const t = [s.get(130), s.get(131), s.get(132)];
    return {
        travel: t.every((v) => v !== undefined && v > 0) ? (t as unknown as Point3) : undefined,
        homing: s.get(22) === 1,
        softLimits: s.get(20) === 1,
        hardLimits: s.get(21) === 1,
    };
}

/** The stock on the table: its size and where the work zero sits on it. */
export interface Stock {
    width: number; // X
    depth: number; // Y
    height: number; // Z
    /** The work zero on the stock's top: its front-left corner, or its centre. */
    zeroAt: "frontLeft" | "centre";
}

const STOCK_KEY = "kern3d.station.stock";

export function savedStock(): Stock | undefined {
    try {
        const s = JSON.parse(localStorage.getItem(STOCK_KEY) ?? "null") as Stock | null;
        if (s && s.width > 0 && s.depth > 0 && s.height > 0) return s;
    } catch {}
    return undefined;
}

export function saveStock(s: Stock | undefined) {
    if (s) localStorage.setItem(STOCK_KEY, JSON.stringify(s));
    else localStorage.removeItem(STOCK_KEY);
}

/** The stock's box in work coordinates. */
export function stockBox(s: Stock): { min: Point3; max: Point3 } {
    const [x0, y0] = s.zeroAt === "centre" ? [-s.width / 2, -s.depth / 2] : [0, 0];
    return { min: [x0, y0, -s.height], max: [x0 + s.width, y0 + s.depth, 0] };
}

/** One axis the program would leave the travel on: by how much, and to which side. */
export interface Overrun {
    axis: "X" | "Y" | "Z";
    by: number;
    side: "min" | "max";
}

/**
 * Whether the program, at the current work zero (`wco` = machine − work), stays inside the machine
 * space [−travel, 0] on every axis; the axes it leaves and by how much (0.01 mm slack).
 */
export function travelOverruns(
    path: Pick<ProgramPath, "min" | "max">,
    wco: Point3,
    travel: Point3,
): Overrun[] {
    const out: Overrun[] = [];
    (["X", "Y", "Z"] as const).forEach((axis, i) => {
        const lo = path.min[i] + wco[i];
        const hi = path.max[i] + wco[i];
        if (lo < -travel[i] - 0.01) out.push({ axis, by: -travel[i] - lo, side: "min" });
        if (hi > 0.01) out.push({ axis, by: hi, side: "max" });
    });
    return out;
}

/** «X на 12.5 мм за левым краем…» for the screen. */
export function overrunText(o: readonly Overrun[]): string {
    const side: Record<string, string> = {
        Xmin: "за левым краем",
        Xmax: "за правым краем",
        Ymin: "ближе переднего края",
        Ymax: "дальше заднего края",
        Zmin: "ниже нижнего предела",
        Zmax: "выше верхнего предела",
    };
    return o.map((x) => `${x.axis} на ${x.by.toFixed(1)} мм ${side[x.axis + x.side]}`).join(", ");
}

const ORANGE = "#ff7a1a";

/**
 * The table seen from above in machine coordinates: the travel (what the spindle can reach),
 * a 50 mm grid, the stock, the program's outline (green inside the travel, red where it leaves
 * it), the work zero and the spindle. X to the right, Y away from the operator.
 */
export class MapView {
    private readonly ctx: CanvasRenderingContext2D;

    constructor(private readonly canvas: HTMLCanvasElement) {
        this.ctx = canvas.getContext("2d")!;
        new ResizeObserver(() => {
            const r = canvas.getBoundingClientRect();
            canvas.width = Math.max(1, r.width * devicePixelRatio);
            canvas.height = Math.max(1, r.height * devicePixelRatio);
        }).observe(canvas);
    }

    draw(p: {
        travel?: Point3;
        mpos?: Point3;
        wco?: Point3;
        path?: Pick<ProgramPath, "min" | "max">;
        stock?: Stock;
        homed: boolean;
        /** The fixed tool length sensor (machine X, Y), when there is one. */
        setter?: { x: number; y: number };
        /** Where the machine waits for a cutter change when it cannot home (machine X, Y). */
        changeAt?: { x: number; y: number };
    }) {
        const { ctx, canvas } = this;
        const dpr = devicePixelRatio;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // labels sized to the view, readable on a big monitor and on the Tesla screen alike
        const fs = Math.max(13 * dpr, canvas.height * 0.032);
        ctx.font = `600 ${fs}px system-ui, sans-serif`;
        if (!p.travel) {
            ctx.fillStyle = "rgba(255,255,255,.6)";
            ctx.textAlign = "center";
            ctx.fillText(
                "Ход станка неизвестен — подключите контроллер",
                canvas.width / 2,
                canvas.height / 2,
            );
            return;
        }
        const [tx, ty] = p.travel;
        const pad = fs * 3;
        const s = Math.min((canvas.width - 2 * pad) / tx, (canvas.height - 2 * pad) / ty);
        const ox = (canvas.width - tx * s) / 2;
        const oy = (canvas.height + ty * s) / 2;
        // machine (x, y) ∈ [−tx, 0] × [−ty, 0] → screen
        const X = (x: number) => ox + (x + tx) * s;
        const Y = (y: number) => oy - (y + ty) * s;
        // the travel
        ctx.fillStyle = "rgba(255,255,255,.04)";
        ctx.fillRect(X(-tx), Y(0), tx * s, ty * s);
        ctx.strokeStyle = "rgba(255,255,255,.18)";
        ctx.lineWidth = dpr;
        for (let g = 50; g < tx; g += 50) {
            ctx.beginPath();
            ctx.moveTo(X(-tx + g), Y(-ty));
            ctx.lineTo(X(-tx + g), Y(0));
            ctx.stroke();
        }
        for (let g = 50; g < ty; g += 50) {
            ctx.beginPath();
            ctx.moveTo(X(-tx), Y(-ty + g));
            ctx.lineTo(X(0), Y(-ty + g));
            ctx.stroke();
        }
        ctx.strokeStyle = p.homed ? "rgba(255,255,255,.7)" : "rgba(255,180,60,.9)";
        ctx.lineWidth = 2 * dpr;
        ctx.setLineDash(p.homed ? [] : [6 * dpr, 6 * dpr]);
        ctx.strokeRect(X(-tx), Y(0), tx * s, ty * s);
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(255,255,255,.55)";
        ctx.textAlign = "center";
        ctx.fillText(`ход X ${tx.toFixed(0)} мм`, X(-tx / 2), Y(-ty) + fs * 1.5);
        ctx.save();
        ctx.translate(X(-tx) - fs * 0.8, Y(-ty / 2));
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(`ход Y ${ty.toFixed(0)} мм`, 0, 0);
        ctx.restore();
        const wco = p.wco;
        if (wco) {
            // the stock
            if (p.stock) {
                const b = stockBox(p.stock);
                ctx.fillStyle = "rgba(255,122,26,.18)";
                ctx.strokeStyle = ORANGE;
                ctx.lineWidth = 1.5 * dpr;
                const x0 = X(b.min[0] + wco[0]);
                const y0 = Y(b.max[1] + wco[1]);
                const w = (b.max[0] - b.min[0]) * s;
                const h = (b.max[1] - b.min[1]) * s;
                ctx.fillRect(x0, y0, w, h);
                ctx.strokeRect(x0, y0, w, h);
                ctx.fillStyle = ORANGE;
                ctx.textAlign = "left";
                ctx.fillText(
                    `заготовка ${p.stock.width}×${p.stock.depth}×${p.stock.height}`,
                    x0 + 4 * dpr,
                    y0 - 6 * dpr,
                );
            }
            // the program's outline
            if (p.path) {
                const out = travelOverruns(p.path, wco, p.travel);
                ctx.strokeStyle = out.length > 0 ? "#ff5a5a" : "#4ade80";
                ctx.lineWidth = 2 * dpr;
                ctx.setLineDash([5 * dpr, 4 * dpr]);
                const x0 = X(p.path.min[0] + wco[0]);
                const y0 = Y(p.path.max[1] + wco[1]);
                ctx.strokeRect(
                    x0,
                    y0,
                    (p.path.max[0] - p.path.min[0]) * s,
                    (p.path.max[1] - p.path.min[1]) * s,
                );
                ctx.setLineDash([]);
            }
            // the work zero
            const zx = X(wco[0]);
            const zy = Y(wco[1]);
            ctx.strokeStyle = "#4fd1ff";
            ctx.lineWidth = 2 * dpr;
            ctx.beginPath();
            ctx.moveTo(zx - 10 * dpr, zy);
            ctx.lineTo(zx + 10 * dpr, zy);
            ctx.moveTo(zx, zy - 10 * dpr);
            ctx.lineTo(zx, zy + 10 * dpr);
            ctx.stroke();
            ctx.fillStyle = "#4fd1ff";
            ctx.textAlign = "left";
            ctx.fillText("ноль детали", zx + fs * 0.6, zy + fs * 1.3);
        }
        // the tool length sensor: a fixed place on the table
        const mark = (pt: { x: number; y: number }, colour: string, label: string, square: boolean) => {
            const mx = X(pt.x);
            const my = Y(pt.y);
            const inside = pt.x >= -tx - 0.01 && pt.x <= 0.01 && pt.y >= -ty - 0.01 && pt.y <= 0.01;
            ctx.strokeStyle = inside ? colour : "#ff5a5a";
            ctx.fillStyle = inside ? colour : "#ff5a5a";
            ctx.lineWidth = 2 * dpr;
            const r = fs * 0.45;
            ctx.beginPath();
            if (square) ctx.rect(mx - r, my - r, 2 * r, 2 * r);
            else ctx.arc(mx, my, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.textAlign = "left";
            ctx.fillText(inside ? label : `${label} — вне хода!`, mx + r + 4 * dpr, my - r);
        };
        if (p.setter) mark(p.setter, "#c38bff", "датчик длины", false);
        if (p.changeAt) mark(p.changeAt, "rgba(255,255,255,.6)", "смена фрезы", true);
        // the spindle
        if (p.mpos) {
            const sx = X(p.mpos[0]);
            const sy = Y(p.mpos[1]);
            const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 18 * dpr);
            glow.addColorStop(0, "rgba(255,170,80,.95)");
            glow.addColorStop(1, "rgba(255,122,26,0)");
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(sx, sy, 18 * dpr, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#fff";
            ctx.beginPath();
            ctx.arc(sx, sy, 3.5 * dpr, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}
