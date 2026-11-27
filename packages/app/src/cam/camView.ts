// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type * as Three from "three";
import { el, t } from "../laser/laserUi";
import type { MillJob } from "./camData";
import type { MillProgram } from "./camGcode";
import { KNIFE_BLADE, KNIFE_HOLDER, toolProfile } from "./camToolShape";
import { type CamTool, isKnife, knifeOf } from "./camTools";
import { bladeTrace } from "./dragKnife";
import { MillSimulation } from "./simulate";
import type { CamOperation, MillMove } from "./toolpath";

/** One colour per operation kind, the same as the operation cards. */
export const OP_COLORS: Record<string, number> = {
    profile: 0x1c7ed6,
    pocket: 0x7048e8,
    engrave: 0xe8590c,
    drill: 0x2f9e44,
    chamfer: 0xd6336c,
    vcarve: 0xf08c00,
    facing: 0x0c8599,
    helix: 0x5c7cfa,
    thread: 0x868e96,
};
const RAPID = 0xff6b6b;
const PLUNGE = 0xffd43b;

type ViewPreset = "iso" | "top" | "front" | "side";
const PRESETS: Record<ViewPreset, { yaw: number; pitch: number }> = {
    iso: { yaw: -0.6, pitch: 0.75 },
    top: { yaw: 0, pitch: 1.5 },
    front: { yaw: 0, pitch: 0.12 },
    side: { yaw: -Math.PI / 2, pitch: 0.12 },
};

interface Entry {
    move: MillMove;
    tool: CamTool;
    op: CamOperation;
}

/** Wood-like colour by the depth cut: light top, darker and warmer deeper, a dark through-cut. */
function depthColor(depth: number, out: { r: number; g: number; b: number }) {
    const d = Math.max(0, Math.min(1, depth));
    if (d >= 0.999) {
        out.r = 0.16;
        out.g = 0.13;
        out.b = 0.11;
        return;
    }
    // top 0xe3c08a → mid 0xc08a4e → deep 0x7a4a24
    const a = [0.89, 0.75, 0.54];
    const b = [0.75, 0.54, 0.31];
    const c = [0.48, 0.29, 0.14];
    const k = d < 0.5 ? d * 2 : (d - 0.5) * 2;
    const p = d < 0.5 ? a : b;
    const q = d < 0.5 ? b : c;
    out.r = p[0] + (q[0] - p[0]) * k;
    out.g = p[1] + (q[1] - p[1]) * k;
    out.b = p[2] + (q[2] - p[2]) * k;
}

/**
 * The milling preview: the stock as a height map that the cut eats into (coloured by depth), the
 * tool paths (rapids dashed red, plunges yellow, cuts in their operation's colour; the part done
 * bright, the part to come faint), and the real cutter — shank, helical flutes, tip true to the
 * tool, in its collet — animated along the paths. A timeline below scrubs through the job; view
 * buttons turn the camera smoothly to top / front / side / iso. Drag to turn, right-drag to pan,
 * the wheel to zoom.
 */
export class CamView {
    readonly element: HTMLDivElement;
    private three?: typeof Three;
    private renderer?: Three.WebGLRenderer;
    private scene?: Three.Scene;
    private camera?: Three.PerspectiveCamera;
    private world?: Three.Group;
    private stockMesh?: Three.Mesh;
    private stockColors?: Float32Array;
    private pathsDone: Three.LineSegments[] = [];
    private pathPrefix: Uint32Array[] = [];
    private cutter?: Three.Group;
    private spinner?: Three.Group;
    private glow?: Three.Mesh;
    private chips?: Three.Points;
    private chipVel = new Float32Array(0);
    private chipLife = new Float32Array(0);
    private chipNext = 0;
    private section?: Three.Plane;
    private sketch?: Three.Group;
    /** The sketch (the outlines operations cut, the shapes brought in) drawn on the stock top. */
    sketchVisible = true;
    private sim?: MillSimulation;
    private moves: Entry[] = [];
    private frame = 0;
    private view = { yaw: -0.6, pitch: 0.75, zoom: 1, panX: 0, panY: 0 };
    private goal = { yaw: -0.6, pitch: 0.75, zoom: 1, panX: 0, panY: 0 };
    private dirty = true;
    private lastTime = 0;
    private job?: MillJob;
    private program?: MillProgram;
    private readonly reduced =
        typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    private readonly readout = el("div");
    private readonly timeline = Object.assign(el("input"), { type: "range", min: "0", max: "0", value: "0" });
    private readonly timeTrack = el("div");
    private readonly viewButtons = el("div");
    playing = false;
    /** Travel per second of animation, mm. */
    speed = 50;
    onProgress?: (done: number, total: number) => void;

    constructor() {
        this.element = document.createElement("div");
        this.element.style.cssText = "position:absolute;inset:0;overflow:hidden;cursor:grab";
        let drag: { x: number; y: number; pan: boolean } | undefined;
        this.element.addEventListener("contextmenu", (e) => e.preventDefault());
        this.element.addEventListener("pointerdown", (e) => {
            if ((e.target as HTMLElement).closest("button,input")) return;
            drag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey };
            this.element.setPointerCapture(e.pointerId);
            this.element.style.cursor = "grabbing";
        });
        this.element.addEventListener("pointermove", (e) => {
            if (!drag) return;
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            const g = this.goal;
            if (drag.pan) {
                const st = this.stock();
                const k =
                    (Math.max(st.width, st.height) * g.zoom * 2) / Math.max(200, this.element.clientHeight);
                g.panX -= (Math.cos(g.yaw) * dx + Math.sin(g.yaw) * Math.sin(g.pitch) * dy) * k;
                g.panY -= (Math.sin(g.yaw) * dx - Math.cos(g.yaw) * Math.sin(g.pitch) * dy) * k;
            } else {
                g.yaw -= dx * 0.008;
                g.pitch = Math.min(1.55, Math.max(0.02, g.pitch + dy * 0.008));
            }
            // dragging follows the hand at once
            Object.assign(this.view, g);
            drag = { ...drag, x: e.clientX, y: e.clientY };
            this.dirty = true;
        });
        this.element.addEventListener("pointerup", () => {
            drag = undefined;
            this.element.style.cursor = "grab";
        });
        this.element.addEventListener(
            "wheel",
            (e) => {
                e.preventDefault();
                this.goal.zoom = Math.min(
                    10,
                    Math.max(0.05, this.goal.zoom * (e.deltaY > 0 ? 1.12 : 1 / 1.12)),
                );
                this.dirty = true;
            },
            { passive: false },
        );
        this.buildOverlay();
    }

    private stock() {
        return this.job?.stock ?? { minX: 0, minY: 0, width: 100, height: 100, top: 0, bottom: -10 };
    }

    // ---- overlay: view buttons, readout, timeline ----------------------------------------------

    private buildOverlay() {
        const glass =
            "background:color-mix(in srgb,#1b1e23 78%,transparent);color:#e9ecef;border:1px solid #ffffff1f;border-radius:8px;backdrop-filter:blur(6px)";
        this.viewButtons.style.cssText = `position:absolute;top:8px;right:8px;display:flex;gap:2px;padding:3px;${glass}`;
        const btn = (label: string, key: string, action: () => void) => {
            const b = el("button", { textContent: label, title: t(key), onclick: action });
            b.setAttribute("aria-label", t(key));
            b.style.cssText =
                "min-width:28px;height:26px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:inherit;font:600 11px system-ui;cursor:pointer";
            b.onmouseenter = () => (b.style.background = "#ffffff1a");
            b.onmouseleave = () => (b.style.background = b.dataset["on"] ? "#4dabf755" : "transparent");
            return b;
        };
        const sketchBtn = btn("✎", "mill.view.sketch", () => {
            this.sketchVisible = !this.sketchVisible;
            if (this.sketch) this.sketch.visible = this.sketchVisible;
            sketchBtn.dataset["on"] = this.sketchVisible ? "1" : "";
            sketchBtn.style.background = this.sketchVisible ? "#4dabf755" : "transparent";
            this.dirty = true;
        });
        sketchBtn.dataset["on"] = "1";
        sketchBtn.style.background = "#4dabf755";
        const sectionBtn = btn("◧", "mill.view.section", () => {
            this.toggleSection();
            sectionBtn.dataset["on"] = this.section ? "1" : "";
            sectionBtn.style.background = this.section ? "#4dabf755" : "transparent";
        });
        this.viewButtons.append(
            btn(t("mill.view.iso"), "mill.view.iso", () => this.preset("iso")),
            btn(t("mill.view.top"), "mill.view.top", () => this.preset("top")),
            btn(t("mill.view.front"), "mill.view.front", () => this.preset("front")),
            btn(t("mill.view.side"), "mill.view.side", () => this.preset("side")),
            btn("⤢", "mill.view.fit", () => this.fit()),
            sketchBtn,
            sectionBtn,
        );
        this.readout.style.cssText = `position:absolute;left:8px;bottom:44px;padding:5px 9px;font:11px/1.45 ui-monospace,Consolas,monospace;white-space:pre;pointer-events:none;${glass}`;
        const bar = el("div");
        bar.style.cssText = `position:absolute;left:8px;right:8px;bottom:8px;height:28px;display:flex;align-items:center;padding:0 8px;${glass}`;
        this.timeTrack.style.cssText =
            "position:absolute;left:14px;right:14px;top:50%;height:6px;margin-top:-3px;border-radius:3px;opacity:.75;pointer-events:none";
        this.timeline.style.cssText =
            "position:relative;width:100%;margin:0;background:transparent;cursor:pointer";
        this.timeline.setAttribute("aria-label", t("mill.timeline"));
        this.timeline.title = t("mill.timeline");
        let pending = 0;
        this.timeline.addEventListener("input", () => {
            // coalesce the drag into one seek per frame
            cancelAnimationFrame(pending);
            pending = requestAnimationFrame(() => this.seek(Number(this.timeline.value)));
        });
        bar.append(this.timeTrack, this.timeline);
        this.element.append(this.viewButtons, this.readout, bar);
    }

    /** Turn the camera to a preset (smoothly, unless motion is reduced). */
    preset(name: ViewPreset) {
        Object.assign(this.goal, PRESETS[name], { panX: 0, panY: 0 });
        this.dirty = true;
    }

    /** The whole stock in view again. */
    fit() {
        Object.assign(this.goal, { zoom: 1, panX: 0, panY: 0 });
        this.dirty = true;
    }

    private toggleSection() {
        const THREE = this.three;
        const renderer = this.renderer;
        if (!THREE || !renderer || !this.stockMesh) return;
        const st = this.stock();
        this.section = this.section
            ? undefined
            : new THREE.Plane(new THREE.Vector3(0, 1, 0), -(st.minY + st.height / 2));
        renderer.localClippingEnabled = this.section !== undefined;
        const planes = this.section ? [this.section] : [];
        this.world?.traverse((o) => {
            const m = (o as Three.Mesh).material as Three.Material | undefined;
            if (m && o !== this.cutter && !this.cutter?.getObjectById(o.id)) m.clippingPlanes = planes;
        });
        this.dirty = true;
    }

    private timelineTrack() {
        const total = this.moves.length;
        if (total === 0) {
            this.timeTrack.style.background = "#495057";
            return;
        }
        const stops: string[] = [];
        let i = 0;
        while (i < total) {
            const op = this.moves[i].op;
            let j = i;
            while (j < total && this.moves[j].op === op) j++;
            const c = `#${(OP_COLORS[op.kind] ?? 0x4dabf7).toString(16).padStart(6, "0")}`;
            stops.push(`${c} ${((100 * i) / total).toFixed(2)}%`, `${c} ${((100 * j) / total).toFixed(2)}%`);
            i = j;
        }
        this.timeTrack.style.background = `linear-gradient(90deg,${stops.join(",")})`;
    }

    private showReadout() {
        const s = this.sim;
        if (!s) {
            this.readout.textContent = "";
            return;
        }
        const tip = s.tip;
        const now = this.moves[Math.min(s.progress, this.moves.length - 1)];
        const f = (v: number) => v.toFixed(2).padStart(8);
        const type = s.done ? t("mill.move.done") : t(`mill.move.${s.current?.type ?? "rapid"}`);
        const tool = now?.tool;
        const op = now?.op;
        this.readout.textContent = [
            `X${f(tip.x)}  Y${f(tip.y)}  Z${f(tip.z)}`,
            tool ? `T${tool.number} ${tool.name}` : "",
            op ? `${op.name || t(`mill.op.${op.kind}`)} · ${type}` : type,
        ]
            .filter((x) => x)
            .join("\n");
        this.timeline.value = String(s.progress);
    }

    // ---- scene -----------------------------------------------------------------------------------

    async init() {
        if (this.three) return;
        this.three = await import("three");
        const THREE = this.three;
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
        this.renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
        this.element.prepend(this.renderer.domElement);
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x24282e);
        this.scene.add(new THREE.HemisphereLight(0xf1f3f5, 0x3b3125, 0.9));
        const sun = new THREE.DirectionalLight(0xffffff, 1.4);
        sun.position.set(-1, -2, 3);
        this.scene.add(sun);
        const rim = new THREE.DirectionalLight(0x9ec5ff, 0.5);
        rim.position.set(2, 3, 1.5);
        this.scene.add(rim);
        this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100000);
        // the stock lies in X Y, Z up (as the machine)
        this.camera.up.set(0, 0, 1);
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(this.loop);
    }

    dispose() {
        cancelAnimationFrame(this.frame);
        this.renderer?.dispose();
    }

    private disposeWorld() {
        if (!this.world || !this.scene) return;
        this.scene.remove(this.world);
        this.world.traverse((o) => {
            const m = o as Three.Mesh;
            m.geometry?.dispose();
            const mat = m.material as Three.Material | Three.Material[] | undefined;
            if (Array.isArray(mat)) for (const x of mat) x.dispose();
            else mat?.dispose();
        });
        this.world = undefined;
    }

    /** A new program: the stock fresh, the paths drawn, the cutter at the start. */
    async show(job: MillJob, program: MillProgram) {
        await this.init();
        const THREE = this.three!;
        const scene = this.scene!;
        const first = this.job === undefined;
        this.job = job;
        this.program = program;
        this.disposeWorld();
        this.cutterTool = undefined;
        this.section = undefined;
        this.renderer!.localClippingEnabled = false;
        const world = new THREE.Group();
        this.world = world;
        scene.add(world);
        this.moves = program.moves.flatMap((m) => m.moves.map((move) => ({ move, tool: m.tool, op: m.op })));
        this.sim = new MillSimulation(job.stock, this.moves, 0.25);
        const s = this.sim;
        const st = job.stock;

        // the stock: the height-map top coloured by depth, walls and a base
        const geometry = new THREE.PlaneGeometry(st.width, st.height, s.cols - 1, s.rows - 1);
        geometry.translate(st.minX + st.width / 2, st.minY + st.height / 2, 0);
        this.stockColors = new Float32Array(s.cols * s.rows * 3);
        geometry.setAttribute("color", new THREE.BufferAttribute(this.stockColors, 3));
        this.stockMesh = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }),
        );
        world.add(this.stockMesh);
        const thick = Math.max(0.01, st.top - st.bottom);
        const walls = new THREE.Mesh(
            new THREE.BoxGeometry(st.width, st.height, thick * 0.999).translate(
                st.minX + st.width / 2,
                st.minY + st.height / 2,
                st.bottom + (thick * 0.999) / 2,
            ),
            [
                ...[0, 1, 2, 3].map(
                    () =>
                        new THREE.MeshStandardMaterial({
                            color: 0xb98b55,
                            roughness: 0.9,
                            side: THREE.DoubleSide,
                        }),
                ),
                new THREE.MeshBasicMaterial({ visible: false }),
                new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.9 }),
            ],
        );
        world.add(walls);
        // the machine table: a grid under the stock, the work zero marked
        const span = Math.max(st.width, st.height) * 1.6;
        const step = span > 400 ? 50 : span > 100 ? 10 : 5;
        const grid = new THREE.GridHelper(
            Math.ceil(span / step) * step,
            Math.ceil(span / step),
            0x5c636a,
            0x3a3f45,
        );
        grid.rotation.x = Math.PI / 2;
        grid.position.set(st.minX + st.width / 2, st.minY + st.height / 2, st.bottom - 0.05);
        world.add(grid);
        const axes = new THREE.AxesHelper(Math.max(5, Math.min(st.width, st.height) * 0.15));
        axes.position.set(0, 0, st.top + 0.02);
        world.add(axes);
        this.applyHeights(true);

        this.buildSketch(world, job);
        this.buildPaths(world);
        this.buildKnifeCuts(world, program, job.stock.top);

        this.cutter = new THREE.Group();
        this.spinner = new THREE.Group();
        this.cutter.add(this.spinner);
        world.add(this.cutter);
        this.glow = new THREE.Mesh(
            new THREE.RingGeometry(0.5, 1, 32),
            new THREE.MeshBasicMaterial({
                color: 0xff922b,
                transparent: true,
                opacity: 0,
                depthWrite: false,
            }),
        );
        world.add(this.glow);
        this.buildChips(world);
        this.buildCutter(this.moves[0]?.tool);
        this.timeline.max = String(this.moves.length);
        this.timelineTrack();
        if (first) this.fit();
        this.playing = false;
        this.placeCutter();
        this.dirty = true;
        this.report();
    }

    /**
     * The sketch on the stock: each shown operation's outlines and hole centres in its colour, the
     * shapes no operation uses in grey — a thin line just above the top, seen through the cut too.
     */
    private buildSketch(world: Three.Group, job: MillJob) {
        const THREE = this.three!;
        const z = job.stock.top + 0.05;
        const pos: number[] = [];
        const col: number[] = [];
        const color = new THREE.Color();
        const seg = (a: { x: number; y: number }, b: { x: number; y: number }) => {
            pos.push(a.x, a.y, z, b.x, b.y, z);
            col.push(color.r, color.g, color.b, color.r, color.g, color.b);
        };
        const ring = (r: readonly { x: number; y: number }[], closed: boolean) => {
            for (let i = 1; i < r.length; i++) seg(r[i - 1], r[i]);
            if (closed && r.length >= 3) seg(r.at(-1)!, r[0]);
        };
        const mark = (c: { x: number; y: number }, d: number) => {
            const k = Math.max(0.5, d / 2);
            seg({ x: c.x - k, y: c.y }, { x: c.x + k, y: c.y });
            seg({ x: c.x, y: c.y - k }, { x: c.x, y: c.y + k });
            for (let i = 0; i < 24; i++) {
                const a = (i / 24) * Math.PI * 2;
                const b = ((i + 1) / 24) * Math.PI * 2;
                seg(
                    { x: c.x + Math.cos(a) * k, y: c.y + Math.sin(a) * k },
                    { x: c.x + Math.cos(b) * k, y: c.y + Math.sin(b) * k },
                );
            }
        };
        const used = new Set<string>();
        for (const op of job.operations) {
            if (op.shapeId) used.add(op.shapeId);
            if (op.hidden) continue;
            color.setHex(OP_COLORS[op.kind] ?? 0x4dabf7);
            // engraving follows open lines as they are; the other kinds cut closed outlines
            for (const r of op.rings) ring(r, op.kind !== "engrave");
            const tool = job.tools.find((t) => t.id === op.toolId);
            for (const c of op.points) mark(c, op.holeDiameter ?? tool?.diameter ?? 3);
        }
        color.setHex(0xadb5bd);
        for (const sh of job.shapes) {
            if (used.has(sh.id)) continue;
            for (const r of sh.rings) ring(r, false);
            for (const c of sh.points) mark(c, 3);
        }
        const group = new THREE.Group();
        group.visible = this.sketchVisible;
        this.sketch = group;
        world.add(group);
        if (pos.length === 0) return;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        geometry.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
        // seen through the cut: a faint copy drawn over everything, a solid one where it is on top
        const behind = new THREE.LineSegments(
            geometry,
            new THREE.LineBasicMaterial({
                vertexColors: true,
                transparent: true,
                opacity: 0.35,
                depthTest: false,
                depthWrite: false,
            }),
        );
        behind.renderOrder = 2;
        const front = new THREE.LineSegments(
            geometry,
            new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }),
        );
        front.renderOrder = 2;
        group.add(behind, front);
    }

    /** Paths per kind, a faint full copy (to come) and a bright copy drawn up to the progress. */
    private buildPaths(world: Three.Group) {
        const THREE = this.three!;
        this.pathsDone = [];
        this.pathPrefix = [];
        const n = this.moves.length;
        const kinds = ["rapid", "plunge", "feed"] as const;
        const pos: number[][] = [[], [], []];
        const col: number[][] = [[], [], []];
        const prefix = kinds.map(() => new Uint32Array(n + 1));
        const color = new THREE.Color();
        let prev: MillMove | undefined;
        this.moves.forEach(({ move, op }, i) => {
            const k = move.type === "rapid" ? 0 : move.type === "plunge" ? 1 : 2;
            if (prev) {
                pos[k].push(prev.x, prev.y, prev.z, move.x, move.y, move.z);
                color.setHex(k === 0 ? RAPID : k === 1 ? PLUNGE : (OP_COLORS[op.kind] ?? 0x4dabf7));
                col[k].push(color.r, color.g, color.b, color.r, color.g, color.b);
            }
            for (let c = 0; c < 3; c++) prefix[c][i + 1] = pos[c].length / 6;
            prev = move;
        });
        kinds.forEach((kind, k) => {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos[k], 3));
            geometry.setAttribute("color", new THREE.Float32BufferAttribute(col[k], 3));
            const make = (opacity: number) =>
                kind === "rapid"
                    ? new THREE.LineDashedMaterial({
                          vertexColors: true,
                          transparent: true,
                          opacity,
                          dashSize: 1.5,
                          gapSize: 1.2,
                      })
                    : new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity });
            const ahead = new THREE.LineSegments(geometry, make(kind === "rapid" ? 0.25 : 0.3));
            const done = new THREE.LineSegments(geometry, make(kind === "rapid" ? 0.6 : 1));
            if (kind === "rapid") {
                ahead.computeLineDistances();
                done.computeLineDistances();
            }
            done.renderOrder = 1;
            world.add(ahead, done);
            this.pathsDone.push(done);
            this.pathPrefix.push(prefix[k]);
        });
    }

    private updatePathsDone() {
        const p = Math.min(this.sim?.progress ?? 0, this.moves.length);
        this.pathsDone.forEach((line, k) => line.geometry.setDrawRange(0, this.pathPrefix[k][p] * 2));
    }

    private buildChips(world: Three.Group) {
        const THREE = this.three!;
        const count = this.reduced ? 0 : 160;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            "position",
            new THREE.BufferAttribute(new Float32Array(count * 3).fill(1e6), 3),
        );
        this.chipVel = new Float32Array(count * 3);
        this.chipLife = new Float32Array(count);
        this.chips = new THREE.Points(
            geometry,
            new THREE.PointsMaterial({ color: 0xe3c08a, size: 2.5, sizeAttenuation: false }),
        );
        this.chips.frustumCulled = false;
        world.add(this.chips);
    }

    private stepChips(dt: number, cutting: boolean) {
        const chips = this.chips;
        const n = this.chipLife.length;
        if (!chips || n === 0) return;
        const pos = chips.geometry.getAttribute("position") as Three.BufferAttribute;
        const a = pos.array as Float32Array;
        const tip = this.sim!.tip;
        const r = (this.cutterTool?.diameter ?? 3) / 2;
        if (cutting)
            for (let e = 0; e < 3; e++) {
                const i = this.chipNext;
                this.chipNext = (this.chipNext + 1) % n;
                const ang = Math.random() * Math.PI * 2;
                a[i * 3] = tip.x + Math.cos(ang) * r;
                a[i * 3 + 1] = tip.y + Math.sin(ang) * r;
                a[i * 3 + 2] = Math.max(tip.z, this.stock().top - 0.2);
                const v = 8 + Math.random() * 20;
                // flung out tangentially, as the spindle turns
                this.chipVel[i * 3] = -Math.sin(ang) * v;
                this.chipVel[i * 3 + 1] = Math.cos(ang) * v;
                this.chipVel[i * 3 + 2] = 6 + Math.random() * 14;
                this.chipLife[i] = 0.6 + Math.random() * 0.5;
            }
        const floor = this.stock().top;
        for (let i = 0; i < n; i++) {
            if (this.chipLife[i] <= 0) continue;
            this.chipLife[i] -= dt;
            if (this.chipLife[i] <= 0) {
                a[i * 3 + 2] = 1e6;
                continue;
            }
            this.chipVel[i * 3 + 2] -= 60 * dt;
            a[i * 3] += this.chipVel[i * 3] * dt;
            a[i * 3 + 1] += this.chipVel[i * 3 + 1] * dt;
            a[i * 3 + 2] = Math.max(floor, a[i * 3 + 2] + this.chipVel[i * 3 + 2] * dt);
        }
        pos.needsUpdate = true;
    }

    private cutterTool?: CamTool;
    private cutterKey = "";
    private buildCutter(tool: CamTool | undefined) {
        const THREE = this.three!;
        if (!this.cutter || !this.spinner) return;
        const key = tool
            ? `${tool.id}|${tool.kind}|${tool.diameter}|${tool.cornerRadius}|${tool.angle}|${tool.fluteLength}|${tool.flutes}|${tool.knife?.offset ?? ""}`
            : "";
        if (tool === this.cutterTool && key === this.cutterKey) return;
        this.cutterTool = tool;
        this.cutterKey = key;
        for (const o of [...this.cutter.children]) if (o !== this.spinner) this.cutter.remove(o);
        this.spinner.clear();
        if (!tool) return;
        if (isKnife(tool)) {
            this.buildKnife(tool);
            return;
        }
        const p = toolProfile(tool, 16);
        const segs = 40;
        const lathe = (pts: { r: number; z: number }[]) => {
            const g = new THREE.LatheGeometry(
                pts.map((q) => new THREE.Vector2(q.r, q.z)),
                segs,
            );
            g.rotateX(Math.PI / 2);
            return g;
        };
        // the cutting part, with a helical flute texture; the shank plain
        const cutPts = p.points.filter((q) => q.z <= p.fluteEnd + 1e-6);
        cutPts.push({ r: 0, z: p.fluteEnd });
        const cut = lathe(cutPts);
        const pos = cut.getAttribute("position") as Three.BufferAttribute;
        const uv = cut.getAttribute("uv") as Three.BufferAttribute;
        for (let i = 0; i < uv.count; i++) uv.setY(i, pos.getZ(i) / p.fluteEnd);
        const helix = Math.max(1, p.fluteEnd / (Math.PI * tool.diameter * 0.55));
        const fluteMap = this.fluteTexture(tool.flutes, helix);
        const flutes = new THREE.MeshStandardMaterial({
            color: 0xe9ecef,
            metalness: 0.85,
            roughness: 0.28,
            map: fluteMap,
            bumpMap: fluteMap,
            bumpScale: 2,
        });
        this.spinner.add(new THREE.Mesh(cut, flutes));
        const shankPts = p.points.filter((q) => q.z >= p.fluteEnd - 1e-6);
        shankPts.unshift({ r: 0, z: p.fluteEnd });
        this.spinner.add(
            new THREE.Mesh(
                lathe(shankPts),
                new THREE.MeshStandardMaterial({ color: 0xadb5bd, metalness: 0.9, roughness: 0.22 }),
            ),
        );
        // collet nut and the spindle above (do not turn with the tool)
        const nutR = p.shankRadius * 2.2 + 4;
        const nutH = Math.max(6, nutR * 0.8);
        const dark = new THREE.MeshStandardMaterial({ color: 0x495057, metalness: 0.7, roughness: 0.35 });
        const nut = new THREE.Mesh(new THREE.CylinderGeometry(nutR, nutR * 0.8, nutH, 6), dark);
        nut.rotation.x = Math.PI / 2;
        nut.position.z = p.length + nutH / 2;
        const spindleR = nutR * 1.35;
        const spindle = new THREE.Mesh(
            new THREE.CylinderGeometry(spindleR, spindleR, spindleR * 3, 32),
            new THREE.MeshStandardMaterial({ color: 0x343a40, metalness: 0.4, roughness: 0.5 }),
        );
        spindle.rotation.x = Math.PI / 2;
        spindle.position.z = p.length + nutH + spindleR * 1.5;
        this.cutter.add(nut, spindle);
        this.glow?.scale.set(p.radius * 1.15, p.radius * 1.15, 1);
    }

    /**
     * A drag knife: the holder (it does not turn) and a thin blade below it whose tip is the
     * offset off the axis; the blade turned (`placeCutter`) to trail the way the knife goes.
     */
    private buildKnife(tool: CamTool) {
        const THREE = this.three!;
        const offset = knifeOf(tool).offset;
        const steel = new THREE.MeshStandardMaterial({ color: 0xe9ecef, metalness: 0.85, roughness: 0.25 });
        const body = new THREE.MeshStandardMaterial({ color: 0x868e96, metalness: 0.7, roughness: 0.35 });
        // the blade: a thin plate, back edge up the axis, the edge sloping to the tip at x = −offset
        const shape = new THREE.Shape();
        const w = Math.max(0.5, offset + 0.4);
        shape.moveTo(-offset, 0);
        shape.lineTo(w * 0.5, KNIFE_BLADE * 0.45);
        shape.lineTo(w * 0.5, KNIFE_BLADE + 1);
        shape.lineTo(-w * 0.6, KNIFE_BLADE + 1);
        shape.lineTo(-w * 0.6, KNIFE_BLADE * 0.3);
        shape.closePath();
        const blade = new THREE.ExtrudeGeometry(shape, { depth: 0.25, bevelEnabled: false });
        blade.translate(0, 0, -0.125);
        blade.rotateX(Math.PI / 2);
        this.spinner!.add(new THREE.Mesh(blade, steel));
        const nose = (KNIFE_HOLDER / 2) * 0.45;
        const cyl = (r0: number, r1: number, h: number, z: number, m: Three.Material) => {
            const c = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, h, 32), m);
            c.rotation.x = Math.PI / 2;
            c.position.z = z + h / 2;
            return c;
        };
        this.cutter!.add(
            cyl(nose, nose, 3, KNIFE_BLADE, body),
            cyl(nose, KNIFE_HOLDER / 2, 2, KNIFE_BLADE + 3, body),
            cyl(KNIFE_HOLDER / 2, KNIFE_HOLDER / 2, 30, KNIFE_BLADE + 5, body),
        );
        this.glow?.scale.set(0.6, 0.6, 1);
    }

    /** The lines the knife's blade cuts (its tip, trailing the path): red, just above the top. */
    private buildKnifeCuts(world: Three.Group, program: MillProgram, top: number) {
        const THREE = this.three!;
        const pos: number[] = [];
        for (const m of program.moves) {
            if (!isKnife(m.tool)) continue;
            const trace = bladeTrace(m.moves, knifeOf(m.tool).offset, 0.02);
            for (let i = 1; i < trace.length; i++)
                if (trace[i].cutting && trace[i - 1].z <= 0)
                    pos.push(trace[i - 1].x, trace[i - 1].y, top + 0.08, trace[i].x, trace[i].y, top + 0.08);
        }
        if (pos.length === 0) return;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        const lines = new THREE.LineSegments(
            geometry,
            new THREE.LineBasicMaterial({ color: 0xff4d4f, transparent: true, opacity: 0.9 }),
        );
        lines.renderOrder = 3;
        world.add(lines);
    }

    private readonly textures = new Map<string, Three.CanvasTexture>();
    /** Stripes slanted once round per `turns` along the flutes: reads as a helix on the lathe. */
    private fluteTexture(flutes: number, turns: number): Three.Texture {
        const THREE = this.three!;
        const key = `${flutes}|${turns.toFixed(2)}`;
        const known = this.textures.get(key);
        if (known) return known;
        const c = document.createElement("canvas");
        c.width = 128;
        c.height = 128;
        const g = c.getContext("2d")!;
        g.fillStyle = "#f1f3f5";
        g.fillRect(0, 0, 128, 128);
        g.strokeStyle = "#343a40";
        g.lineWidth = 128 / Math.max(1, flutes) / 2.6;
        for (let k = -2; k <= 2; k++) {
            g.beginPath();
            g.moveTo(k * 128, 128);
            g.lineTo(k * 128 + 128, 0);
            g.stroke();
        }
        const tex = new THREE.CanvasTexture(c);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(Math.max(1, Math.min(8, flutes)), turns);
        this.textures.set(key, tex);
        return tex;
    }

    /** The heights (and depth colours) into the stock mesh (all, or only the cells changed). */
    private applyHeights(all = false) {
        const s = this.sim;
        const mesh = this.stockMesh;
        const colors = this.stockColors;
        if (!s || !mesh || !colors) return;
        const d = all ? { minC: 0, minR: 0, maxC: s.cols - 1, maxR: s.rows - 1 } : s.takeDirty();
        if (!d) return;
        if (all) s.takeDirty();
        const pos = mesh.geometry.getAttribute("position") as Three.BufferAttribute;
        const col = mesh.geometry.getAttribute("color") as Three.BufferAttribute;
        const top = s.stock.top;
        const span = Math.max(1e-6, top - s.stock.bottom);
        const c = { r: 0, g: 0, b: 0 };
        // PlaneGeometry rows run from +y down: row 0 is the top edge
        for (let r = d.minR; r <= d.maxR; r++)
            for (let cc = d.minC; cc <= d.maxC; cc++) {
                const k = (s.rows - 1 - r) * s.cols + cc;
                const z = s.z[r * s.cols + cc];
                pos.setZ(k, z);
                depthColor((top - z) / span, c);
                colors[k * 3] = c.r;
                colors[k * 3 + 1] = c.g;
                colors[k * 3 + 2] = c.b;
            }
        pos.needsUpdate = true;
        col.needsUpdate = true;
        mesh.geometry.computeVertexNormals();
        this.dirty = true;
    }

    play() {
        if (this.sim?.done) this.restart();
        this.playing = true;
        this.lastTime = performance.now();
    }

    pause() {
        this.playing = false;
    }

    /** The cut back to the start. */
    restart() {
        if (!this.sim) return;
        this.sim.reset();
        this.applyHeights(true);
        this.placeCutter();
        this.report();
    }

    /** Jump to move `index` of the job (the timeline). */
    seek(index: number) {
        if (!this.sim) return;
        this.sim.seek(index);
        this.applyHeights(true);
        this.placeCutter();
        this.report();
    }

    /** The finished part at once. */
    finish() {
        this.sim?.finish();
        this.applyHeights(true);
        this.placeCutter();
        this.report();
    }

    private report() {
        this.updatePathsDone();
        this.showReadout();
        this.onProgress?.(this.sim?.progress ?? 0, this.moves.length);
    }

    private placeCutter() {
        const s = this.sim;
        if (!s || !this.cutter) return;
        const tip = s.tip;
        this.buildCutter(s.tool.tool);
        this.cutter.position.set(tip.x, tip.y, tip.z);
        // a knife's blade turned to trail towards its tip (the blade drawn with its tip at −x)
        const blade = s.blade;
        if (blade && this.spinner && Math.hypot(blade.x - tip.x, blade.y - tip.y) > 1e-6)
            this.spinner.rotation.z = Math.atan2(tip.y - blade.y, tip.x - blade.x);
        this.dirty = true;
    }

    private readonly loop = (now: number) => {
        this.frame = requestAnimationFrame(this.loop);
        const renderer = this.renderer;
        const camera = this.camera;
        if (!renderer || !camera || !this.scene) return;
        const dt = Math.min(0.1, (now - this.lastTime) / 1000);
        this.lastTime = now;
        let cutting = false;
        if (this.playing && this.sim) {
            this.sim.advance(this.speed * dt);
            this.applyHeights();
            this.placeCutter();
            this.report();
            const tip = this.sim.tip;
            cutting = !this.sim.done && this.sim.current?.type !== "rapid" && tip.z < this.stock().top;
            if (this.sim.done) this.playing = false;
        }
        if (this.spinner && this.playing && !this.reduced && !isKnife(this.cutterTool)) {
            this.spinner.rotation.z -= dt * 40;
            this.dirty = true;
        }
        if (this.glow && this.sim) {
            const tip = this.sim.tip;
            const m = this.glow.material as Three.MeshBasicMaterial;
            const target = cutting ? (this.reduced ? 0.6 : 0.45 + 0.25 * Math.sin(now / 70)) : 0;
            if (Math.abs(m.opacity - target) > 0.01) this.dirty = true;
            m.opacity = target;
            this.glow.position.set(tip.x, tip.y, Math.max(tip.z, this.sim.heightAt(tip.x, tip.y)) + 0.05);
        }
        const chipping = cutting && !isKnife(this.cutterTool);
        if (this.chips && this.chipLife.length > 0 && (chipping || this.chipLife.some((l) => l > 0))) {
            this.stepChips(dt, chipping);
            this.dirty = true;
        }
        // ease the camera toward its goal
        const v = this.view;
        const g = this.goal;
        const k = this.reduced ? 1 : 1 - Math.exp(-dt * 9);
        let moving = false;
        for (const key of ["yaw", "pitch", "zoom", "panX", "panY"] as const) {
            const diff = g[key] - v[key];
            if (Math.abs(diff) > 1e-4 * (key === "panX" || key === "panY" ? 100 : 1)) {
                v[key] += diff * k;
                moving = true;
            } else v[key] = g[key];
        }
        if (moving) this.dirty = true;
        const w = this.element.clientWidth;
        const h = this.element.clientHeight;
        if (w === 0 || h === 0) return;
        const size = renderer.getSize(new this.three!.Vector2());
        if (size.x !== w || size.y !== h) {
            renderer.setSize(w, h, false);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            this.dirty = true;
        }
        if (!this.dirty) return;
        this.dirty = false;
        const st = this.stock();
        const cx = st.minX + st.width / 2 + v.panX;
        const cy = st.minY + st.height / 2 + v.panY;
        const distance = Math.max(st.width, st.height) * 1.9 * v.zoom;
        camera.position.set(
            cx + Math.sin(v.yaw) * Math.cos(v.pitch) * distance,
            cy - Math.cos(v.yaw) * Math.cos(v.pitch) * distance,
            st.bottom / 2 + Math.sin(v.pitch) * distance,
        );
        camera.lookAt(cx, cy, st.bottom / 2);
        renderer.render(this.scene, camera);
    };
}
