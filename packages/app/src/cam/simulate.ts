// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CamTool } from "./camTools";
import type { MillMove } from "./toolpath";

/**
 * Material removal on a height map: the stock's top as a grid of heights (Z, mm), every cutting
 * move lowering the cells the tool's shape reaches — flat end, ball and V-bit profiles. Moves are
 * applied a bit at a time so the preview can animate the cut (`advance`), the tool's place and
 * the moves done so far known at every step.
 */
export interface Stock {
    minX: number;
    minY: number;
    width: number;
    height: number;
    /** The stock's top (0) and bottom (−thickness), mm. */
    top: number;
    bottom: number;
}

export class MillSimulation {
    readonly cols: number;
    readonly rows: number;
    readonly cell: number;
    readonly z: Float32Array;
    /** Index of the next move and how far along it (mm) the tool is. */
    private moveIndex = 0;
    private along = 0;
    private pos: { x: number; y: number; z: number };
    /** Cells changed since the last `takeDirty` (for the 3D view to update only that). */
    private dirty = { minC: Infinity, minR: Infinity, maxC: -Infinity, maxR: -Infinity };

    constructor(
        readonly stock: Stock,
        private readonly moves: readonly { move: MillMove; tool: CamTool }[],
        /** Cell size, mm: finer is truer and slower; capped to ~1M cells. */
        cell = 0.2,
    ) {
        const area = stock.width * stock.height;
        this.cell = Math.max(cell, Math.sqrt(area / 1_000_000));
        this.cols = Math.max(2, Math.ceil(stock.width / this.cell) + 1);
        this.rows = Math.max(2, Math.ceil(stock.height / this.cell) + 1);
        this.z = new Float32Array(this.cols * this.rows).fill(stock.top);
        const first = moves[0]?.move;
        this.pos = first
            ? { x: first.x, y: first.y, z: Math.max(first.z, stock.top + 5) }
            : { x: 0, y: 0, z: 5 };
    }

    get done(): boolean {
        return this.moveIndex >= this.moves.length;
    }

    /** The tool's tip now, and which tool. */
    get tool(): { x: number; y: number; z: number; tool: CamTool | undefined } {
        return { ...this.pos, tool: this.moves[Math.min(this.moveIndex, this.moves.length - 1)]?.tool };
    }

    /** How many moves are finished (for drawing the path done). */
    get progress(): number {
        return this.moveIndex;
    }

    /** Height at (x, y), mm (the stock's top outside it). */
    heightAt(x: number, y: number): number {
        const c = Math.round((x - this.stock.minX) / this.cell);
        const r = Math.round((y - this.stock.minY) / this.cell);
        if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return this.stock.top;
        return this.z[r * this.cols + c];
    }

    /** The tool goes on by `distance` mm of travel (rapids too), cutting as it goes. */
    advance(distance: number) {
        let left = distance;
        while (left > 0 && !this.done) {
            const { move, tool } = this.moves[this.moveIndex];
            const dx = move.x - this.pos.x;
            const dy = move.y - this.pos.y;
            const dz = move.z - this.pos.z;
            const length = Math.hypot(dx, dy, dz);
            const remaining = length - this.along;
            const step = Math.min(left, remaining);
            const from = this.along / (length || 1);
            const to = (this.along + step) / (length || 1);
            if (move.type !== "rapid") this.sweep(this.pos, { x: dx, y: dy, z: dz }, from, to, tool);
            this.along += step;
            left -= step;
            if (this.along >= length - 1e-9) {
                this.pos = { x: move.x, y: move.y, z: move.z };
                this.moveIndex++;
                this.along = 0;
            }
        }
        if (!this.done) {
            const { move } = this.moves[this.moveIndex];
            const start = this.pos;
            const length = Math.hypot(move.x - start.x, move.y - start.y, move.z - start.z) || 1;
            const t = this.along / length;
            this.tipCache = {
                x: start.x + (move.x - start.x) * t,
                y: start.y + (move.y - start.y) * t,
                z: start.z + (move.z - start.z) * t,
            };
        } else this.tipCache = this.pos;
    }

    private tipCache: { x: number; y: number; z: number } | undefined;

    /** The tool's tip, between moves too. */
    get tip(): { x: number; y: number; z: number } {
        return this.tipCache ?? this.pos;
    }

    /** The move being made now (its type tells rapid / feed / plunge), or undefined at the end. */
    get current(): MillMove | undefined {
        return this.moves[this.moveIndex]?.move;
    }

    /** Fresh stock, the tool back at the start. */
    reset() {
        this.z.fill(this.stock.top);
        this.moveIndex = 0;
        this.along = 0;
        this.tipCache = undefined;
        const first = this.moves[0]?.move;
        this.pos = first
            ? { x: first.x, y: first.y, z: Math.max(first.z, this.stock.top + 5) }
            : { x: 0, y: 0, z: 5 };
        this.dirty = { minC: 0, minR: 0, maxC: this.cols - 1, maxR: this.rows - 1 };
    }

    /** Jump to the start of move `index` (forward cuts on, backward starts over). */
    seek(index: number) {
        const target = Math.max(0, Math.min(this.moves.length, Math.round(index)));
        if (target < this.moveIndex || (target === this.moveIndex && this.along > 0)) this.reset();
        while (this.moveIndex < target) this.advance(this.remainingInMove());
        this.advance(0);
    }

    private remainingInMove(): number {
        const { move } = this.moves[this.moveIndex];
        return Math.max(
            1e-12,
            Math.hypot(move.x - this.pos.x, move.y - this.pos.y, move.z - this.pos.z) - this.along,
        );
    }

    /** Everything at once (the end result). */
    finish() {
        while (!this.done) this.advance(1e9);
    }

    /** The cell box changed since the last call, or undefined. */
    takeDirty(): { minC: number; minR: number; maxC: number; maxR: number } | undefined {
        const d = this.dirty;
        this.dirty = { minC: Infinity, minR: Infinity, maxC: -Infinity, maxR: -Infinity };
        return Number.isFinite(d.minC) ? d : undefined;
    }

    /** The removed volume so far, mm³. */
    removedVolume(): number {
        let v = 0;
        for (const h of this.z) v += this.stock.top - h;
        return v * this.cell * this.cell;
    }

    /** The tool swept over part [from, to] of a segment starting at `start`. */
    private sweep(
        start: { x: number; y: number; z: number },
        d: { x: number; y: number; z: number },
        from: number,
        to: number,
        tool: CamTool,
    ) {
        const flat = Math.hypot(d.x, d.y) * (to - from);
        const samples = Math.max(1, Math.ceil(flat / (this.cell * 0.5)));
        for (let i = 0; i <= samples; i++) {
            const t = from + ((to - from) * i) / samples;
            this.stamp(start.x + d.x * t, start.y + d.y * t, start.z + d.z * t, tool);
        }
    }

    /** The tool's shape pressed in with its tip at (x, y, z). */
    private stamp(x: number, y: number, z: number, tool: CamTool) {
        if (z >= this.stock.top) return;
        const r = tool.diameter / 2;
        const c0 = Math.max(0, Math.floor((x - r - this.stock.minX) / this.cell));
        const c1 = Math.min(this.cols - 1, Math.ceil((x + r - this.stock.minX) / this.cell));
        const r0 = Math.max(0, Math.floor((y - r - this.stock.minY) / this.cell));
        const r1 = Math.min(this.rows - 1, Math.ceil((y + r - this.stock.minY) / this.cell));
        if (c0 > c1 || r0 > r1) return;
        const half = ((tool.angle > 0 ? tool.angle : 90) * Math.PI) / 360;
        const slope = 1 / Math.tan(half);
        const corner = tool.kind === "ball" ? r : tool.kind === "bull" ? Math.min(r, tool.cornerRadius) : 0;
        for (let row = r0; row <= r1; row++) {
            const cy = this.stock.minY + row * this.cell;
            for (let col = c0; col <= c1; col++) {
                const cx = this.stock.minX + col * this.cell;
                const dist = Math.hypot(cx - x, cy - y);
                if (dist > r) continue;
                let bottom = z;
                if (tool.kind === "vbit" || tool.kind === "chamfer" || tool.kind === "drill")
                    bottom = z + dist * slope;
                else if (corner > 0 && dist > r - corner) {
                    const u = dist - (r - corner);
                    bottom = z + corner - Math.sqrt(Math.max(0, corner * corner - u * u));
                }
                const k = row * this.cols + col;
                const floor = Math.max(this.stock.bottom, bottom);
                if (floor < this.z[k]) {
                    this.z[k] = floor;
                    const dd = this.dirty;
                    if (col < dd.minC) dd.minC = col;
                    if (col > dd.maxC) dd.maxC = col;
                    if (row < dd.minR) dd.minR = row;
                    if (row > dd.maxR) dd.maxR = row;
                }
            }
        }
    }
}
