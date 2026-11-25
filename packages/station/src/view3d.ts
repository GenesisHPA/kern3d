// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Point3, ProgramPath } from "./gcodePath";

/**
 * The job drawn in a fixed isometric view on a 2D canvas: the stock's box round the cuts, the
 * path still to go faint, the path done bright orange, the tool where the controller says it
 * is. Light enough for any station PC; no WebGL.
 */
export class PathView {
    private readonly ctx: CanvasRenderingContext2D;
    private path?: ProgramPath;
    /** Program line (0-based) up to which the path is done. */
    private doneLine = -1;
    private tool: Point3 = [0, 0, 0];
    private scale = 1;
    private centre: Point3 = [0, 0, 0];

    constructor(private readonly canvas: HTMLCanvasElement) {
        this.ctx = canvas.getContext("2d")!;
        new ResizeObserver(() => this.resize()).observe(canvas);
    }

    setPath(path: ProgramPath | undefined) {
        this.path = path;
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
                ctx.strokeStyle = done
                    ? "rgba(255,150,50,.95)"
                    : s.rapid
                      ? "rgba(255,255,255,.07)"
                      : "rgba(255,255,255,.22)";
                ctx.lineWidth = (done ? 2.2 : 1) * dpr;
                ctx.beginPath();
                ctx.moveTo(...this.iso(s.from));
                ctx.lineTo(...this.iso(s.to));
                ctx.stroke();
            }
        }
        this.drawTool(dpr);
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
