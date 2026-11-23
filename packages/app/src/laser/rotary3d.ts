// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type * as Three from "three";
import type { Pt } from "./geometry";
import style from "./laserEditor.module.css";
import { button, el, t } from "./laserUi";

/** One burned polyline on the part's surface: x along the axis, s round it (mm), its marking time. */
export interface SurfaceLine {
    points: Pt[];
    seconds: number;
}

/** What the 3D view shows: the part (a cylinder) and the job wrapped round it. */
export interface Rotary3DSource {
    diameter: number;
    /** Along the axis, mm: the job's X range. */
    xMin: number;
    xMax: number;
    /** In marking order; Pt.x = along the axis, Pt.y = round the surface (0 … π·D). */
    lines: SurfaceLine[];
}

/** Texture pixels per mm, at most; less for a big part (the canvas stays ≤ 2048 px a side). */
const MAX_PPM = 10;
const MAX_TEXTURE = 2048;
/** «Просмотр» plays the job in this many seconds at most. */
const PREVIEW_SECONDS = 20;

/**
 * The part in the rotary chuck in 3D: a cylinder of the job's diameter with the job wrapped
 * round it (the planned lines black), turning as the job goes so the place being marked is on
 * top under the beam, the burned lines red behind it. Driven by the job's progress — the
 * machine's (the same as the 2D beam) or «Просмотр», which plays it without a machine.
 */
export class Rotary3DView {
    readonly element: HTMLDivElement;
    private readonly host: HTMLDivElement;
    private three?: typeof Three;
    private renderer?: Three.WebGLRenderer;
    private scene?: Three.Scene;
    private camera?: Three.PerspectiveCamera;
    private turn?: Three.Group;
    private beam?: Three.Group;
    private texture?: Three.CanvasTexture;
    private canvas = document.createElement("canvas");
    private source?: Rotary3DSource;
    private starts: number[] = [0];
    private drawn = 0;
    private fraction = 0;
    private ppm = 1;
    private frame = 0;
    private dirty = true;
    private yaw = 0.5;
    private pitch = 0.35;
    private playing = 0;

    /** `onClose`: a close button in the title (none when the view is docked). */
    constructor(
        private readonly onClose: (() => void) | undefined,
        /** More buttons beside «Просмотр» (the chuck's «в 0°» and «Ноль здесь»). */
        extra: HTMLElement[] = [],
    ) {
        this.host = el("div", { className: style.view3dCanvas });
        const play = button("laser.rotary.3d.play", () => this.play());
        this.element = el(
            "div",
            { className: style.view3d },
            el(
                "div",
                { className: style.view3dHead },
                el("span", { textContent: t("laser.rotary.3d") }),
                play,
                ...extra,
                ...(this.onClose === undefined ? [] : [button("laser.close", () => this.onClose?.())]),
            ),
            this.host,
        );
        this.host.addEventListener("pointerdown", (e) => {
            const x0 = e.clientX;
            const y0 = e.clientY;
            const yaw = this.yaw;
            const pitch = this.pitch;
            this.host.setPointerCapture(e.pointerId);
            const move = (ev: PointerEvent) => {
                this.yaw = yaw - (ev.clientX - x0) * 0.01;
                this.pitch = Math.min(1.4, Math.max(-0.2, pitch + (ev.clientY - y0) * 0.01));
                this.dirty = true;
            };
            const up = () => {
                this.host.removeEventListener("pointermove", move);
                this.host.removeEventListener("pointerup", up);
            };
            this.host.addEventListener("pointermove", move);
            this.host.addEventListener("pointerup", up);
        });
    }

    /** Builds the scene for `source` (the job changed, or the view opens). */
    async show(source: Rotary3DSource) {
        this.three ??= await import("three");
        const THREE = this.three;
        this.source = source;
        this.stopPlay();
        const r = Math.max(0.5, source.diameter / 2);
        const circ = Math.PI * 2 * r;
        const len = Math.max(1, source.xMax - source.xMin);
        this.ppm = Math.min(MAX_PPM, MAX_TEXTURE / Math.max(circ, len));
        this.canvas.width = Math.max(2, Math.round(circ * this.ppm));
        this.canvas.height = Math.max(2, Math.round(len * this.ppm));
        this.starts = [0];
        for (const l of source.lines) this.starts.push(this.starts[this.starts.length - 1] + l.seconds);
        this.drawn = 0;
        this.fraction = 0;
        this.paintBase();

        if (this.renderer === undefined) {
            this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
            this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
            this.host.append(this.renderer.domElement);
        }
        this.texture?.dispose();
        this.texture = new THREE.CanvasTexture(this.canvas);
        this.texture.colorSpace = THREE.SRGBColorSpace;
        this.texture.anisotropy = 4;

        const scene = new THREE.Scene();
        scene.add(new THREE.AmbientLight(0xffffff, 0.55));
        const sun = new THREE.DirectionalLight(0xffffff, 1.6);
        sun.position.set(len, r * 4, r * 6);
        scene.add(sun);

        // the part: axis along X, turning about it; its texture's top row is the job's xMin
        this.turn = new THREE.Group();
        const body = new THREE.Mesh(
            new THREE.CylinderGeometry(r, r, len, 128, 1, true),
            new THREE.MeshStandardMaterial({ map: this.texture, metalness: 0.35, roughness: 0.45 }),
        );
        body.rotation.z = Math.PI / 2;
        const capMaterial = new THREE.MeshStandardMaterial({
            color: 0x9aa3ab,
            metalness: 0.4,
            roughness: 0.5,
        });
        for (const side of [-1, 1]) {
            const cap = new THREE.Mesh(new THREE.CircleGeometry(r, 64), capMaterial);
            cap.rotation.y = (side * Math.PI) / 2;
            cap.position.x = (side * len) / 2;
            this.turn.add(cap);
        }
        this.turn.add(body);
        scene.add(this.turn);

        // the chuck at the left end, turning with the part: degree marks round its rim (0° on
        // the part's seam), and a fixed red pointer above it reading the angle
        const chuckR = r * 1.6 + 3;
        const chuckH = Math.max(6, r * 0.8);
        const rim = new THREE.CanvasTexture(dialCanvas());
        rim.colorSpace = THREE.SRGBColorSpace;
        rim.anisotropy = 4;
        const chuckSide = new THREE.MeshStandardMaterial({ map: rim, metalness: 0.5, roughness: 0.45 });
        const chuckFace = new THREE.MeshStandardMaterial({ color: 0x3b4248, metalness: 0.6, roughness: 0.4 });
        const chuck = new THREE.Mesh(new THREE.CylinderGeometry(chuckR, chuckR, chuckH, 96), [
            chuckSide,
            chuckFace,
            chuckFace,
        ]);
        chuck.rotation.z = Math.PI / 2;
        chuck.position.x = -len / 2 - chuckH / 2 - 1;
        this.turn.add(chuck);
        const pointer = new THREE.Mesh(
            new THREE.ConeGeometry(Math.max(1, chuckR * 0.08), Math.max(2, chuckR * 0.22), 16),
            new THREE.MeshBasicMaterial({ color: 0xe03131 }),
        );
        pointer.rotation.z = Math.PI; // tip down, onto the rim
        pointer.position.set(chuck.position.x, chuckR + Math.max(1.2, chuckR * 0.12), 0);
        scene.add(pointer);

        // the beam: a line from above and a bright spot where it meets the part
        this.beam = new THREE.Group();
        const spot = new THREE.Mesh(
            new THREE.SphereGeometry(Math.max(0.3, r * 0.04), 16, 12),
            new THREE.MeshBasicMaterial({ color: 0xfff1b0 }),
        );
        const glow = new THREE.Mesh(
            new THREE.SphereGeometry(Math.max(0.8, r * 0.12), 16, 12),
            new THREE.MeshBasicMaterial({
                color: 0xff8a00,
                transparent: true,
                opacity: 0.35,
                depthWrite: false,
            }),
        );
        const rayLength = r * 3;
        const ray = new THREE.Mesh(
            new THREE.CylinderGeometry(Math.max(0.08, r * 0.01), Math.max(0.08, r * 0.01), rayLength, 8),
            new THREE.MeshBasicMaterial({ color: 0xff5a00, transparent: true, opacity: 0.7 }),
        );
        ray.position.y = rayLength / 2;
        this.beam.add(spot, glow, ray);
        this.beam.position.y = r;
        scene.add(this.beam);

        this.scene = scene;
        this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
        // the app makes Z «up» for every object (CAD); this scene is Y-up
        this.camera.up.set(0, 1, 0);
        this.dirty = true;
        this.setFraction(0);
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(this.loop);
    }

    /** How far the job is, 0..1 (its time): the part turned, the beam placed, the lines burned. */
    setFraction(fraction: number) {
        const source = this.source;
        if (source === undefined || this.turn === undefined || this.beam === undefined) return;
        const f = Math.min(1, Math.max(0, fraction));
        if (f < this.fraction) {
            // back to an earlier point (a new run): start the burn over
            this.drawn = 0;
            this.paintBase();
        }
        this.fraction = f;
        const total = this.starts[this.starts.length - 1];
        const time = f * total;
        // whole lines finished
        const ctx = this.canvas.getContext("2d");
        while (this.drawn < source.lines.length && this.starts[this.drawn + 1] <= time) {
            if (ctx) this.stroke(ctx, source.lines[this.drawn].points, "#e03131", 1.6);
            this.drawn++;
        }
        // the line being marked: its part done so far, and where the beam is on it
        let at: Pt | undefined;
        const line = source.lines[this.drawn];
        if (line !== undefined) {
            const span = line.seconds;
            const k = span > 0 ? (time - this.starts[this.drawn]) / span : 1;
            const partial = partOf(line.points, k);
            at = partial[partial.length - 1];
            if (ctx && partial.length > 1) this.stroke(ctx, partial, "#e03131", 1.6);
        } else {
            const last = source.lines.at(-1)?.points.at(-1);
            at = last;
        }
        if (this.texture) this.texture.needsUpdate = true;
        if (at !== undefined) {
            const r = source.diameter / 2;
            // the surface point s comes to the top: turn by its angle (θ − π/2, θ = s / r)
            this.turn.rotation.x = at.y / r - Math.PI / 2;
            this.beam.position.x = at.x - (source.xMin + source.xMax) / 2;
            this.beam.visible = f < 1;
        }
        this.dirty = true;
    }

    /** «Просмотр»: the whole job played over at most PREVIEW_SECONDS. */
    private play() {
        if (this.source === undefined) return;
        this.stopPlay();
        const total = this.starts[this.starts.length - 1];
        const duration = Math.max(2, Math.min(PREVIEW_SECONDS, total)) * 1000;
        const t0 = performance.now();
        this.setFraction(0);
        this.drawn = 0;
        this.paintBase();
        const step = () => {
            const f = (performance.now() - t0) / duration;
            this.setFraction(f);
            if (f < 1) this.playing = requestAnimationFrame(step);
            else this.playing = 0;
        };
        this.playing = requestAnimationFrame(step);
    }

    private stopPlay() {
        if (this.playing) cancelAnimationFrame(this.playing);
        this.playing = 0;
    }

    /** The bare part with the planned lines faint on it. */
    private paintBase() {
        const ctx = this.canvas.getContext("2d");
        if (ctx === null || this.source === undefined) return;
        ctx.fillStyle = "#c9ced3";
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        for (const l of this.source.lines) this.stroke(ctx, l.points, "#111315", 1.2);
        if (this.texture) this.texture.needsUpdate = true;
    }

    private stroke(ctx: CanvasRenderingContext2D, points: readonly Pt[], color: string, width: number) {
        const source = this.source;
        if (source === undefined || points.length < 2) return;
        const circ = Math.PI * source.diameter;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = "round";
        ctx.beginPath();
        // canvas x round the surface (wrapped), canvas y along the axis from xMin
        let prevU: number | undefined;
        for (const p of points) {
            const s = ((p.y % circ) + circ) % circ;
            const u = s * this.ppm;
            const v = (p.x - source.xMin) * this.ppm;
            // a line crossing the seam starts again on the other side
            if (prevU === undefined || Math.abs(u - prevU) > this.canvas.width / 2) ctx.moveTo(u, v);
            else ctx.lineTo(u, v);
            prevU = u;
        }
        ctx.stroke();
    }

    private readonly loop = () => {
        this.frame = requestAnimationFrame(this.loop);
        const renderer = this.renderer;
        const camera = this.camera;
        if (!renderer || !camera || !this.scene || !this.source) return;
        const w = this.host.clientWidth;
        const h = this.host.clientHeight;
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
        const r = this.source.diameter / 2;
        const len = this.source.xMax - this.source.xMin;
        const distance = Math.max(len, r * 4) * 1.6 + r * 2;
        camera.position.set(
            Math.sin(this.yaw) * Math.cos(this.pitch) * distance,
            Math.sin(this.pitch) * distance,
            Math.cos(this.yaw) * Math.cos(this.pitch) * distance,
        );
        camera.lookAt(0, 0, 0);
        renderer.render(this.scene, camera);
    };

    dispose() {
        this.stopPlay();
        cancelAnimationFrame(this.frame);
        this.texture?.dispose();
        this.renderer?.dispose();
        this.element.remove();
    }
}

/** The first `k` (0..1, by length) of a polyline. */
function partOf(points: readonly Pt[], k: number): Pt[] {
    if (k >= 1) return [...points];
    let total = 0;
    for (let i = 1; i < points.length; i++)
        total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    let left = Math.max(0, k) * total;
    const out: Pt[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d >= left) {
            const f = d > 0 ? left / d : 0;
            out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
            return out;
        }
        out.push(b);
        left -= d;
    }
    return out;
}

/**
 * The chuck's rim: ticks every 10° (long every 30°, figures every 30°) round it, 0° where the
 * part's seam is. The canvas runs round the rim along x (as the part's texture does), across
 * the rim along y.
 */
function dialCanvas(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = 2048;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return canvas;
    ctx.fillStyle = "#4a525a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#f1f3f5";
    ctx.fillStyle = "#f1f3f5";
    ctx.font = "bold 34px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let a = 0; a < 360; a += 5) {
        // same direction round as the part's surface coordinate (u = θ / 2π)
        const u = (a / 360) * canvas.width;
        const long = a % 30 === 0;
        const mid = a % 10 === 0;
        ctx.lineWidth = long ? 4 : 2;
        ctx.beginPath();
        ctx.moveTo(u, 0);
        ctx.lineTo(u, long ? 46 : mid ? 30 : 18);
        ctx.stroke();
        if (long) ctx.fillText(`${a}°`, u, 86);
    }
    return canvas;
}
