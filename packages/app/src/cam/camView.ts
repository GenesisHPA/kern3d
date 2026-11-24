// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type * as Three from "three";
import type { MillJob } from "./camData";
import type { MillProgram } from "./camGcode";
import type { CamTool } from "./camTools";
import { MillSimulation } from "./simulate";
import type { MillMove } from "./toolpath";

/**
 * The milling preview: the stock as a height map that the cut eats into, the tool paths (rapids
 * thin red, cuts blue) and the cutter itself, animated along the paths at a chosen speed. Drag
 * to turn the view, the wheel to zoom.
 */
export class CamView {
    readonly element: HTMLDivElement;
    private three?: typeof Three;
    private renderer?: Three.WebGLRenderer;
    private scene?: Three.Scene;
    private camera?: Three.PerspectiveCamera;
    private stockMesh?: Three.Mesh;
    private paths?: Three.Group;
    private cutter?: Three.Group;
    private sim?: MillSimulation;
    private moves: { move: MillMove; tool: CamTool }[] = [];
    private frame = 0;
    private yaw = -0.6;
    private pitch = 0.75;
    private zoom = 1;
    private dirty = true;
    private lastTime = 0;
    private job?: MillJob;
    private program?: MillProgram;
    playing = false;
    /** Travel per second of animation, mm. */
    speed = 50;
    onProgress?: (done: number, total: number) => void;

    constructor() {
        this.element = document.createElement("div");
        this.element.style.cssText = "position:absolute;inset:0;overflow:hidden;cursor:grab";
        let drag: { x: number; y: number } | undefined;
        this.element.addEventListener("pointerdown", (e) => {
            drag = { x: e.clientX, y: e.clientY };
            this.element.setPointerCapture(e.pointerId);
        });
        this.element.addEventListener("pointermove", (e) => {
            if (!drag) return;
            this.yaw -= (e.clientX - drag.x) * 0.008;
            this.pitch = Math.min(1.5, Math.max(0.05, this.pitch + (e.clientY - drag.y) * 0.008));
            drag = { x: e.clientX, y: e.clientY };
            this.dirty = true;
        });
        this.element.addEventListener("pointerup", () => {
            drag = undefined;
        });
        this.element.addEventListener(
            "wheel",
            (e) => {
                e.preventDefault();
                this.zoom = Math.min(10, Math.max(0.1, this.zoom * (e.deltaY > 0 ? 1.12 : 1 / 1.12)));
                this.dirty = true;
            },
            { passive: false },
        );
    }

    async init() {
        if (this.three) return;
        this.three = await import("three");
        const THREE = this.three;
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
        this.element.append(this.renderer.domElement);
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x2b2f36);
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
        const sun = new THREE.DirectionalLight(0xffffff, 1.1);
        sun.position.set(-1, -2, 3);
        this.scene.add(sun);
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

    /** A new program: the stock fresh, the paths drawn, the cutter at the start. */
    async show(job: MillJob, program: MillProgram) {
        await this.init();
        const THREE = this.three!;
        const scene = this.scene!;
        this.job = job;
        this.program = program;
        if (this.stockMesh) scene.remove(this.stockMesh);
        if (this.paths) scene.remove(this.paths);
        if (this.cutter) scene.remove(this.cutter);
        this.moves = program.moves.flatMap((m) => m.moves.map((move) => ({ move, tool: m.tool })));
        this.sim = new MillSimulation(job.stock, this.moves, 0.25);
        const s = this.sim;
        const geometry = new THREE.PlaneGeometry(job.stock.width, job.stock.height, s.cols - 1, s.rows - 1);
        geometry.translate(job.stock.minX + job.stock.width / 2, job.stock.minY + job.stock.height / 2, 0);
        this.stockMesh = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({
                color: 0xc8a165,
                roughness: 0.8,
                flatShading: false,
                side: THREE.DoubleSide,
            }),
        );
        scene.add(this.stockMesh);
        this.applyHeights(true);

        this.paths = new THREE.Group();
        const rapid: number[] = [];
        const cut: number[] = [];
        let prev: MillMove | undefined;
        for (const { move } of this.moves) {
            if (prev)
                (move.type === "rapid" ? rapid : cut).push(prev.x, prev.y, prev.z, move.x, move.y, move.z);
            prev = move;
        }
        const lines = (data: number[], color: number, opacity: number) => {
            const g = new THREE.BufferGeometry();
            g.setAttribute("position", new THREE.Float32BufferAttribute(data, 3));
            return new THREE.LineSegments(
                g,
                new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
            );
        };
        this.paths.add(lines(rapid, 0xff5050, 0.45), lines(cut, 0x4dabf7, 0.85));
        scene.add(this.paths);

        this.cutter = new THREE.Group();
        scene.add(this.cutter);
        this.buildCutter(this.moves[0]?.tool);
        this.playing = false;
        this.dirty = true;
        this.report();
    }

    private cutterTool?: CamTool;
    private buildCutter(tool: CamTool | undefined) {
        const THREE = this.three!;
        if (!this.cutter || tool === this.cutterTool) return;
        this.cutterTool = tool;
        this.cutter.clear();
        if (!tool) return;
        const r = tool.diameter / 2;
        const flute = Math.max(tool.fluteLength, r * 2);
        const metal = new THREE.MeshStandardMaterial({ color: 0xdee2e6, metalness: 0.8, roughness: 0.3 });
        const v = tool.kind === "vbit" || tool.kind === "chamfer" || tool.kind === "drill";
        const tip = v ? r / Math.tan(((tool.angle || 90) * Math.PI) / 360) : 0;
        if (v) {
            const cone = new THREE.Mesh(new THREE.ConeGeometry(r, tip, 24), metal);
            cone.rotation.x = -Math.PI / 2;
            cone.position.z = tip / 2;
            this.cutter.add(cone);
        }
        const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, flute, 24), metal);
        body.rotation.x = Math.PI / 2;
        body.position.z = tip + flute / 2;
        this.cutter.add(body);
        if (tool.kind === "ball") {
            const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 12), metal);
            ball.position.z = r;
            body.position.z = r + flute / 2;
            this.cutter.add(ball);
        }
        const shank = new THREE.Mesh(
            new THREE.CylinderGeometry(r * 1.05, r * 1.05, flute * 1.5, 24),
            new THREE.MeshStandardMaterial({ color: 0x868e96, metalness: 0.6, roughness: 0.4 }),
        );
        shank.rotation.x = Math.PI / 2;
        shank.position.z = tip + flute * 1.75;
        this.cutter.add(shank);
    }

    /** The heights into the stock mesh (all, or only the cells changed). */
    private applyHeights(all = false) {
        const s = this.sim;
        const mesh = this.stockMesh;
        if (!s || !mesh) return;
        const d = all ? { minC: 0, minR: 0, maxC: s.cols - 1, maxR: s.rows - 1 } : s.takeDirty();
        if (!d) return;
        if (all) s.takeDirty();
        const pos = mesh.geometry.getAttribute("position") as Three.BufferAttribute;
        // PlaneGeometry rows run from +y down: row 0 is the top edge
        for (let r = d.minR; r <= d.maxR; r++)
            for (let c = d.minC; c <= d.maxC; c++) {
                const k = (s.rows - 1 - r) * s.cols + c;
                pos.setZ(k, s.z[r * s.cols + c]);
            }
        pos.needsUpdate = true;
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
        if (this.job && this.program) void this.show(this.job, this.program);
    }

    /** The finished part at once. */
    finish() {
        this.sim?.finish();
        this.applyHeights(true);
        this.placeCutter();
        this.report();
    }

    private report() {
        this.onProgress?.(this.sim?.progress ?? 0, this.moves.length);
    }

    private placeCutter() {
        const s = this.sim;
        if (!s || !this.cutter) return;
        const tip = s.tip;
        this.buildCutter(s.tool.tool);
        this.cutter.position.set(tip.x, tip.y, tip.z);
        this.dirty = true;
    }

    private readonly loop = (now: number) => {
        this.frame = requestAnimationFrame(this.loop);
        const renderer = this.renderer;
        const camera = this.camera;
        if (!renderer || !camera || !this.scene) return;
        if (this.playing && this.sim) {
            const dt = Math.min(0.1, (now - this.lastTime) / 1000);
            this.lastTime = now;
            this.sim.advance(this.speed * dt);
            this.applyHeights();
            this.placeCutter();
            this.report();
            if (this.sim.done) this.playing = false;
        }
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
        const st = this.job?.stock ?? { minX: 0, minY: 0, width: 100, height: 100, top: 0, bottom: -10 };
        const cx = st.minX + st.width / 2;
        const cy = st.minY + st.height / 2;
        const distance = Math.max(st.width, st.height) * 1.9 * this.zoom;
        camera.position.set(
            cx + Math.sin(this.yaw) * Math.cos(this.pitch) * distance,
            cy - Math.cos(this.yaw) * Math.cos(this.pitch) * distance,
            Math.sin(this.pitch) * distance,
        );
        camera.lookAt(cx, cy, st.bottom / 2);
        renderer.render(this.scene, camera);
    };
}
