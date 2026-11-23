// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Pt } from "./geometry";
import type { Move } from "./toolpath";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Burned moves per SVG path: the one being drawn is rewritten each frame, the full ones never. */
const CHUNK = 400;
/** How far ahead of the last reported position the beam may run on its own, s (GRBL: 4 reports/s). */
const POSITION_LEAD = 0.35;
/** How many moves ahead of the current one a reported position is looked for. */
const SEARCH_AHEAD = 400;

export interface BeamProgress {
    /** 0..1 of the job's time. */
    fraction: number;
    /** Seconds left by the estimate. */
    remaining: number;
}

/**
 * The beam drawn over the preview while the job runs on the machine: a bright point where the
 * head is, the path burned so far lit behind it.
 *
 * - `"time"` (a JCZ galvo board: it reports no position while marking) — the point follows the
 *   job's own timeline (each move's length at its speed, scaled to the job's estimated time),
 *   started with the job, held while paused, and never ahead of the lists the board has taken.
 * - `"position"` (GRBL) — the point goes to where the machine says the head is (4 times a
 *   second) and runs on along the path between the reports.
 *
 * The coordinates are the preview's (the moves'), so the beam lies on the drawn toolpath.
 */
export class BeamAnimation {
    private readonly root: SVGGElement;
    private readonly burned: SVGGElement;
    private readonly current: SVGPathElement;
    private readonly halo: SVGCircleElement;
    private readonly core: SVGCircleElement;
    private moves: readonly Move[] = [];
    /** Start time of each move on the job's timeline, s; last entry is the total. */
    private starts: number[] = [0];
    private mode: "time" | "position" = "time";
    private t = 0;
    private running = false;
    private lastFrame = 0;
    /** Upper bound from the board's progress (lists taken), s. */
    private ceiling = Number.POSITIVE_INFINITY;
    /** GRBL: the timeline point of the last reported position, s. */
    private anchor = 0;
    private drawnUpTo = 0;
    private chunk: SVGPathElement | undefined;
    private chunkD = "";
    private chunkCount = 0;
    private frame = 0;

    constructor(
        parent: SVGGElement,
        private readonly onProgress?: (p: BeamProgress) => void,
    ) {
        const make = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>) => {
            const e = document.createElementNS(SVG_NS, tag);
            for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
            return e;
        };
        this.root = make("g", { "pointer-events": "none", display: "none" });
        this.burned = make("g", {});
        this.current = make("path", this.burnStyle());
        this.halo = make("circle", { r: "2.5", fill: "#ff7a00", opacity: "0.35" });
        this.core = make("circle", { r: "0.9", fill: "#fff4c2", stroke: "#ff7a00", "stroke-width": "1.5" });
        this.core.setAttribute("vector-effect", "non-scaling-stroke");
        this.root.append(this.burned, this.current, this.halo, this.core);
        parent.append(this.root);
    }

    private burnStyle(): Record<string, string> {
        return {
            fill: "none",
            stroke: "#ff9f1a",
            "stroke-width": "2",
            "stroke-linecap": "round",
            "vector-effect": "non-scaling-stroke",
        };
    }

    get active(): boolean {
        return this.root.getAttribute("display") !== "none";
    }

    /** A job started: the beam at its first move, the clock running. */
    start(moves: readonly Move[], seconds: number, mode: "time" | "position") {
        this.clear();
        this.moves = moves;
        this.mode = mode;
        const raw: number[] = [0];
        for (const m of moves) {
            const len = Math.hypot(m.x1 - m.x0, m.y1 - m.y0);
            const speed = Math.max(1e-6, m.feed / 60);
            raw.push(raw[raw.length - 1] + len / speed);
        }
        const total = raw[raw.length - 1];
        // scaled to the estimate, which also counts acceleration and corners
        const k = total > 0 && seconds > 0 ? seconds / total : 1;
        this.starts = raw.map((x) => x * k);
        this.root.setAttribute("display", "");
        this.running = true;
        this.lastFrame = performance.now();
        this.tick();
    }

    pause() {
        this.running = false;
    }

    resume() {
        if (!this.active) return;
        this.running = true;
        this.lastFrame = performance.now();
    }

    /** JCZ: `done` of `total` lists handed to the board — the beam is never further than that. */
    lists(done: number, total: number) {
        if (total <= 0) return;
        this.ceiling = done >= total ? Number.POSITIVE_INFINITY : (done / total) * this.total;
    }

    /** GRBL: where the machine says the head is. */
    position(p: Pt) {
        if (this.mode !== "position" || this.moves.length === 0) return;
        const i0 = this.indexAt(this.t);
        let best = i0;
        let bestD = Number.POSITIVE_INFINITY;
        let bestF = 0;
        for (let i = i0; i < Math.min(this.moves.length, i0 + SEARCH_AHEAD); i++) {
            const m = this.moves[i];
            const dx = m.x1 - m.x0;
            const dy = m.y1 - m.y0;
            const l2 = dx * dx + dy * dy;
            const f = l2 > 0 ? Math.min(1, Math.max(0, ((p.x - m.x0) * dx + (p.y - m.y0) * dy) / l2)) : 0;
            const d = Math.hypot(m.x0 + dx * f - p.x, m.y0 + dy * f - p.y);
            if (d < bestD - 1e-9) {
                bestD = d;
                best = i;
                bestF = f;
            }
            if (d < 1e-3) break;
        }
        const at = this.starts[best] + (this.starts[best + 1] - this.starts[best]) * bestF;
        this.anchor = Math.max(this.anchor, at);
        this.t = Math.max(this.t, this.anchor);
    }

    /** The job finished: the whole path lit, the point gone after a moment. */
    finish() {
        this.t = this.total;
        this.ceiling = Number.POSITIVE_INFINITY;
        this.render();
        this.running = false;
        this.halo.setAttribute("display", "none");
        this.core.setAttribute("display", "none");
    }

    /** Stopped or failed: what was burned stays lit, the point stays where it stopped. */
    halt() {
        this.running = false;
    }

    clear() {
        cancelAnimationFrame(this.frame);
        this.running = false;
        this.t = 0;
        this.anchor = 0;
        this.ceiling = Number.POSITIVE_INFINITY;
        this.drawnUpTo = 0;
        this.chunk = undefined;
        this.chunkD = "";
        this.chunkCount = 0;
        this.burned.replaceChildren();
        this.current.setAttribute("d", "");
        this.halo.removeAttribute("display");
        this.core.removeAttribute("display");
        this.root.setAttribute("display", "none");
    }

    dispose() {
        this.clear();
        this.root.remove();
    }

    private get total(): number {
        return this.starts[this.starts.length - 1] ?? 0;
    }

    private indexAt(t: number): number {
        // the last move starting at or before t (binary search)
        let lo = 0;
        let hi = this.moves.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.starts[mid] <= t) lo = mid;
            else hi = mid - 1;
        }
        return Math.max(0, lo);
    }

    private readonly tick = () => {
        const now = performance.now();
        const dt = (now - this.lastFrame) / 1000;
        this.lastFrame = now;
        if (this.running) {
            let next = this.t + dt;
            if (this.mode === "position") next = Math.min(next, this.anchor + POSITION_LEAD);
            this.t = Math.min(this.total, Math.max(this.t, Math.min(next, this.ceiling)));
        }
        this.render();
        if (this.active) this.frame = requestAnimationFrame(this.tick);
    };

    private render() {
        if (this.moves.length === 0) return;
        const i = this.indexAt(this.t);
        // moves finished since the last frame go into the burned chunks
        for (; this.drawnUpTo < i; this.drawnUpTo++) this.burn(this.moves[this.drawnUpTo]);
        this.flush();
        const m = this.moves[i];
        const span = this.starts[i + 1] - this.starts[i];
        const f = span > 0 ? Math.min(1, Math.max(0, (this.t - this.starts[i]) / span)) : 1;
        const x = m.x0 + (m.x1 - m.x0) * f;
        const y = m.y0 + (m.y1 - m.y0) * f;
        if (this.t >= this.total && this.drawnUpTo === i) {
            this.burn(m);
            this.flush();
            this.drawnUpTo++;
            this.current.setAttribute("d", "");
        } else {
            this.current.setAttribute(
                "d",
                !m.rapid && m.power > 0
                    ? `M${m.x0.toFixed(3)} ${m.y0.toFixed(3)}L${x.toFixed(3)} ${y.toFixed(3)}`
                    : "",
            );
        }
        const on = !m.rapid && m.power > 0;
        for (const c of [this.halo, this.core]) {
            c.setAttribute("cx", x.toFixed(3));
            c.setAttribute("cy", y.toFixed(3));
        }
        this.halo.setAttribute("opacity", on ? "0.45" : "0.15");
        this.core.setAttribute("fill", on ? "#fff4c2" : "#ffd8a8");
        const total = this.total;
        this.onProgress?.({
            fraction: total > 0 ? this.t / total : 1,
            remaining: Math.max(0, total - this.t),
        });
    }

    private burn(m: Move) {
        if (m.rapid || m.power <= 0) return;
        if (this.chunk === undefined || this.chunkCount >= CHUNK) {
            // the full chunk gets its last moves before a new one starts
            this.chunk?.setAttribute("d", this.chunkD);
            this.dirty.clear();
            this.chunk = document.createElementNS(SVG_NS, "path");
            for (const [k, v] of Object.entries(this.burnStyle())) this.chunk.setAttribute(k, v);
            this.burned.append(this.chunk);
            this.chunkD = "";
            this.chunkCount = 0;
        }
        this.chunkD += `M${m.x0.toFixed(3)} ${m.y0.toFixed(3)}L${m.x1.toFixed(3)} ${m.y1.toFixed(3)}`;
        this.chunkCount++;
        this.dirty.add(this.chunk);
    }

    private readonly dirty = new Set<SVGPathElement>();
    /** Chunk paths changed this frame rewritten once each (not once per move). */
    private flush() {
        if (this.chunk !== undefined && this.dirty.has(this.chunk)) this.chunk.setAttribute("d", this.chunkD);
        this.dirty.clear();
    }
}
