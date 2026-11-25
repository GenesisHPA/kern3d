// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Point3, ProgramPath } from "./gcodePath";

/** Colours of the depths, shallowest first — none of them orange, which is the path done. */
const DEPTH_COLOURS = [
    "#4fd1ff",
    "#7cff6b",
    "#c38bff",
    "#ff6bd6",
    "#5b8cff",
    "#3dffc5",
    "#fff38a",
    "#ff5a5a",
];

/** The depths the cuts are made at, deepest last (to 0.01 mm), and a colour for each. */
export function depthLevels(path: ProgramPath): { z: number; colour: string }[] {
    const zs = new Set<number>();
    for (const s of path.segments) {
        if (s.rapid || Math.abs(s.from[2] - s.to[2]) > 0.005) continue; // plunges take the level they reach
        zs.add(Math.round(s.to[2] * 100) / 100);
    }
    const sorted = [...zs].sort((a, b) => b - a);
    return sorted.map((z, i) => ({
        z,
        colour:
            sorted.length <= DEPTH_COLOURS.length
                ? DEPTH_COLOURS[i]
                : `hsl(${190 + (110 * i) / Math.max(1, sorted.length - 1)} 90% 65%)`,
    }));
}

/**
 * The job drawn in a fixed isometric view on a 2D canvas: the stock's box round the cuts, the
 * path still to go coloured by its depth (a legend in the corner), rapids faint and dashed, the
 * path done bright orange, the tool where the controller says it is. Light enough for any
 * station PC; no WebGL.
 */
export class PathView {
    private readonly ctx: CanvasRenderingContext2D;
    private path?: ProgramPath;
    /** Program line (0-based) up to which the path is done. */
    private doneLine = -1;
    private tool: Point3 = [0, 0, 0];
    private scale = 1;
    private centre: Point3 = [0, 0, 0];
    private levels: { z: number; colour: string }[] = [];

    constructor(private readonly canvas: HTMLCanvasElement) {
        this.ctx = canvas.getContext("2d")!;
        new ResizeObserver(() => this.resize()).observe(canvas);
    }

    setPath(path: ProgramPath | undefined) {
        this.path = path;
        this.levels = path ? depthLevels(path) : [];
        this.doneLine = -1;
        this.fit();
    }

    setProgress(doneLine: number, tool: Point3 | undefined) {
        this.doneLine = doneLine;
        if (tool) this.tool = tool;
    }

    private resize() {
        const r = this.canvas.getBoundingClientRect();
        this.canvas.width = Math.max(1, r.width * devicePixelRatio);
        this.canvas.height = Math.max(1, r.height * devicePixelRatio);
        this.fit();
    }

    private fit() {
        const p = this.path;
        const size = p ? Math.max(p.max[0] - p.min[0], p.max[1] - p.min[1], 20) : 100;
        this.centre = p ? [(p.min[0] + p.max[0]) / 2, (p.min[1] + p.max[1]) / 2, p.max[2]] : [0, 0, 0];
        this.scale = Math.min(this.canvas.width / (size * 1.9), this.canvas.height / (size * 1.25));
    }

    private iso(p: Point3): [number, number] {
        const x = p[0] - this.centre[0];
        const y = p[1] - this.centre[1];
        const z = p[2] - this.centre[2];
        return [
            this.canvas.width / 2 + (x - y) * 0.87 * this.scale,
            this.canvas.height * 0.5 + (-(x + y) * 0.5 - z * 1.2) * this.scale,
        ];
    }

    draw() {
        const { ctx, canvas } = this;
        const dpr = devicePixelRatio;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const p = this.path;
        if (p) this.drawStock(p);
        if (p) {
            ctx.lineCap = "round";
            for (const s of p.segments) {
                const done = s.line <= this.doneLine;
                if (s.rapid) {
                    ctx.strokeStyle = done ? "rgba(255,150,50,.45)" : "rgba(255,255,255,.18)";
                    ctx.lineWidth = dpr;
                    ctx.setLineDash([4 * dpr, 4 * dpr]);
                } else {
                    ctx.strokeStyle = done ? "rgba(255,150,50,.95)" : this.colourAt(s.to[2]);
                    ctx.lineWidth = (done ? 2.4 : 1.4) * dpr;
                    ctx.setLineDash([]);
                }
                ctx.globalAlpha = done || s.rapid ? 1 : 0.8;
                ctx.beginPath();
                ctx.moveTo(...this.iso(s.from));
                ctx.lineTo(...this.iso(s.to));
                ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
        }
        this.drawTool(dpr);
        this.drawLegend(dpr);
    }

    /** The colour of the depth nearest to z. */
    private colourAt(z: number): string {
        let best = this.levels[0];
        for (const l of this.levels) if (Math.abs(l.z - z) < Math.abs(best.z - z)) best = l;
        return best?.colour ?? "rgba(255,255,255,.4)";
    }

    /** Depth → colour, top left; with many depths only every few are named. */
    private drawLegend(dpr: number) {
        const levels = this.levels;
        if (levels.length < 2) return;
        const { ctx } = this;
        const step = Math.ceil(levels.length / 8);
        const shown = levels.filter((_, i) => i % step === 0 || i === levels.length - 1);
        const size = Math.max(14 * dpr, this.canvas.height * 0.034);
        ctx.font = `600 ${size}px system-ui, sans-serif`;
        ctx.textBaseline = "middle";
        let y = size * 1.3;
        for (const l of shown) {
            ctx.fillStyle = l.colour;
            ctx.fillRect(size, y - size * 0.15, size * 1.6, size * 0.3);
            ctx.fillStyle = "rgba(255,255,255,.75)";
            ctx.fillText(`Z ${l.z > 0 ? "+" : ""}${l.z.toFixed(2).replace(/\.?0+$/, "")}`, size * 3, y);
            y += size * 1.45;
        }
    }

    private drawStock(p: ProgramPath) {
        const margin = 5;
        const [x0, y0] = [p.min[0] - margin, p.min[1] - margin];
        const [x1, y1] = [p.max[0] + margin, p.max[1] + margin];
        const top = p.max[2] > 0 ? 0 : p.max[2];
        const bottom = Math.min(p.min[2], top) - 3;
        const face = (pts: Point3[], fill: string) => {
            this.ctx.beginPath();
            pts.forEach((q, i) => (i ? this.ctx.lineTo(...this.iso(q)) : this.ctx.moveTo(...this.iso(q))));
            this.ctx.closePath();
            this.ctx.fillStyle = fill;
            this.ctx.fill();
        };
        face(
            [
                [x1, y0, bottom],
                [x1, y1, bottom],
                [x1, y1, top],
                [x1, y0, top],
            ],
            "#3a332d",
        );
        face(
            [
                [x0, y0, bottom],
                [x1, y0, bottom],
                [x1, y0, top],
                [x0, y0, top],
            ],
            "#2f2925",
        );
        face(
            [
                [x0, y0, top],
                [x1, y0, top],
                [x1, y1, top],
                [x0, y1, top],
            ],
            "#4b423a",
        );
    }

    private drawTool(dpr: number) {
        const { ctx } = this;
        const tip = this.iso(this.tool);
        const shank = this.iso([this.tool[0], this.tool[1], this.tool[2] + 25]);
        ctx.strokeStyle = "#cfd3d8";
        ctx.lineWidth = 5 * dpr;
        ctx.beginPath();
        ctx.moveTo(...shank);
        ctx.lineTo(...tip);
        ctx.stroke();
        const glow = ctx.createRadialGradient(tip[0], tip[1], 0, tip[0], tip[1], 24 * dpr);
        glow.addColorStop(0, "rgba(255,170,80,.9)");
        glow.addColorStop(1, "rgba(255,122,26,0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(tip[0], tip[1], 24 * dpr, 0, Math.PI * 2);
        ctx.fill();
    }
}
