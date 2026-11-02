// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { CAMERA_FLY_DURATION, I18n, type I18nKeys, type IViewGizmo, XYZ } from "@chili3d/core";
import { Matrix4, Vector3 } from "three";
import type { CameraController } from "./cameraController";
import type { ThreeView } from "./threeView";

const MOUSE_LEFT = 1;

const options = {
    /** Canvas pixels; the element shows it at `displayScale`, so it stays sharp on HiDPI. */
    size: 200,
    displayScale: 0.8,
    /** Canvas pixels per cube half-edge. */
    cubeScale: 47,
    cornerPickRadius: 11,
    fontFamily: "system-ui, sans-serif",
    colors: {
        face: "#dfe3e8",
        faceEdge: "#7d848d",
        text: "#2d3136",
        hover: "#6aa8ff",
        x: "#e5484d",
        y: "#30a46c",
        z: "#3e8ef7",
    },
};

/** One clickable face of the cube: its outward normal, and the axes its label is laid out on. */
export interface CubeFace {
    readonly key: string;
    readonly label: I18nKeys;
    readonly normal: Vector3;
    /** The label's reading direction on the face. */
    readonly right: Vector3;
    /** The camera's up vector when this face is looked at head-on. */
    readonly up: Vector3;
}

/** A pick target under the pointer: a face (look straight at it) or a corner (isometric). */
export type CubeTarget = { kind: "face"; face: CubeFace } | { kind: "corner"; direction: Vector3 };

const FACES: readonly CubeFace[] = [
    { key: "top", label: "viewCube.top", normal: v(0, 0, 1), right: v(1, 0, 0), up: v(0, 1, 0) },
    { key: "bottom", label: "viewCube.bottom", normal: v(0, 0, -1), right: v(1, 0, 0), up: v(0, -1, 0) },
    { key: "front", label: "viewCube.front", normal: v(0, -1, 0), right: v(1, 0, 0), up: v(0, 0, 1) },
    { key: "back", label: "viewCube.back", normal: v(0, 1, 0), right: v(-1, 0, 0), up: v(0, 0, 1) },
    { key: "right", label: "viewCube.right", normal: v(1, 0, 0), right: v(0, 1, 0), up: v(0, 0, 1) },
    { key: "left", label: "viewCube.left", normal: v(-1, 0, 0), right: v(0, -1, 0), up: v(0, 0, 1) },
];

const CORNERS: readonly Vector3[] = [-1, 1].flatMap((x) =>
    [-1, 1].flatMap((y) => [-1, 1].map((z) => v(x, y, z))),
);

/** Where the home button flies to: front-right-top, Z up. */
const HOME_DIRECTION = v(1, -1, 1).normalize();

function v(x: number, y: number, z: number) {
    return new Vector3(x, y, z);
}

interface Point2 {
    x: number;
    y: number;
}

function insidePolygon(p: Point2, polygon: Point2[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i];
        const b = polygon[j];
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * The view cube in the canvas corner: a cube turned with the camera, whose faces fly the view
 * straight onto that side and whose corners fly it to the isometric view from there, with a home
 * button for the default framing and an axis triad along the cube's edges. Dragging it orbits.
 */
export class ViewGizmo extends HTMLElement implements IViewGizmo {
    private readonly _canvas: HTMLCanvasElement;
    private readonly _context: CanvasRenderingContext2D;
    private readonly _home: HTMLElement;
    readonly cameraController: CameraController;
    private _canClick: boolean = true;
    private _hovered?: CubeTarget;
    private _mouse?: Vector3;
    /** World → view rotation of the last frame; the pick test reads the frame the user sees. */
    private _toView = new Matrix4();

    constructor(readonly view: ThreeView) {
        super();
        this.cameraController = view.cameraController;
        this._canvas = this._initCanvas();
        this._context = this._canvas.getContext("2d")!;
        this._home = this._initHome();
        this._initStyle();
    }

    setDom(dom: HTMLElement): void {
        this.remove();
        dom.appendChild(this);
    }

    dispose(): void {
        this.remove();
    }

    get hovered(): CubeTarget | undefined {
        return this._hovered;
    }

    private _initStyle() {
        this.style.zIndex = "999";
        this.style.position = "absolute";
        this.style.top = "8px";
        this.style.right = "8px";
        this.style.cursor = "pointer";
        this.style.userSelect = "none";
        this.style.webkitUserSelect = "none";
    }

    private _initCanvas() {
        const canvas = document.createElement("canvas");
        canvas.width = options.size;
        canvas.height = options.size;
        canvas.style.width = `${options.size * options.displayScale}px`;
        canvas.style.height = `${options.size * options.displayScale}px`;
        canvas.style.display = "block";
        this.append(canvas);
        return canvas;
    }

    private _initHome() {
        const home = document.createElement("div");
        home.setAttribute("role", "button");
        home.dataset["viewcube"] = "home";
        I18n.set(home, "title", "viewCube.home");
        home.innerHTML =
            '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
            '<path d="M8 2 1.5 7.5h2V14h3.5v-4h2v4h3.5V7.5h2z" fill="currentColor"/></svg>';
        Object.assign(home.style, {
            position: "absolute",
            top: "0px",
            left: "0px",
            width: "22px",
            height: "22px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "4px",
            color: "var(--foreground-secondary-color, #888)",
        });
        home.addEventListener("pointerenter", () => {
            home.style.backgroundColor = "var(--hover-background-color, rgba(128,128,128,.25))";
        });
        home.addEventListener("pointerleave", () => {
            home.style.backgroundColor = "transparent";
        });
        home.addEventListener("pointerdown", (e) => e.stopPropagation());
        home.addEventListener("click", this._onHomeClick);
        this.append(home);
        return home;
    }

    connectedCallback() {
        this._canvas.addEventListener("pointermove", this._onPointerMove);
        this._canvas.addEventListener("pointerout", this._onPointerOut);
        this._canvas.addEventListener("click", this._onClick);
        this._canvas.addEventListener("pointerdown", this._onPointerDown);
        this._canvas.addEventListener("pointerup", this._onPointerUp);
    }

    disconnectedCallback() {
        this._canvas.removeEventListener("pointermove", this._onPointerMove);
        this._canvas.removeEventListener("pointerout", this._onPointerOut);
        this._canvas.removeEventListener("click", this._onClick);
        this._canvas.removeEventListener("pointerdown", this._onPointerDown);
        this._canvas.removeEventListener("pointerup", this._onPointerUp);
    }

    private readonly _onPointerMove = (e: PointerEvent) => {
        e.stopPropagation();
        if (e.buttons === MOUSE_LEFT && !(e.movementX === 0 && e.movementY === 0)) {
            this.cameraController.rotate(e.movementX * 4, e.movementY * 4);
            this._canClick = false;
        }
        const rect = this._canvas.getBoundingClientRect();
        const scale = 1 / options.displayScale;
        this._mouse = new Vector3((e.clientX - rect.left) * scale, (e.clientY - rect.top) * scale, 0);
        this.view.update();
    };

    private readonly _onPointerDown = (e: PointerEvent) => {
        e.stopPropagation();
        this._canvas.setPointerCapture(e.pointerId);
        this.cameraController.setRotateCenterToSelected();
    };

    private readonly _onPointerUp = (e: PointerEvent) => {
        e.stopPropagation();
        this._canvas.releasePointerCapture(e.pointerId);
    };

    private readonly _onPointerOut = (e: PointerEvent) => {
        e.stopPropagation();
        this._mouse = undefined;
        this.view.update();
    };

    private readonly _onClick = (e: MouseEvent) => {
        e.stopPropagation();
        if (!this._canClick) {
            this._canClick = true;
            return;
        }
        const target = this._hovered;
        if (target === undefined) return;
        if (target.kind === "face") {
            this.flyTo(target.face.normal, target.face.up);
        } else {
            this.flyTo(target.direction.clone().normalize(), v(0, 0, 1));
        }
    };

    private readonly _onHomeClick = (e: MouseEvent) => {
        e.stopPropagation();
        this.flyTo(HOME_DIRECTION, v(0, 0, 1));
        this.cameraController.fitContent?.({ duration: CAMERA_FLY_DURATION });
        this.view.update();
    };

    private flyTo(direction: Vector3, up: Vector3) {
        const distance = this.cameraController.camera.position.distanceTo(this.cameraController.target);
        const position = direction.clone().multiplyScalar(distance).add(this.cameraController.target);
        this.cameraController.lookAt(position, this.cameraController.target, new XYZ(up), {
            duration: CAMERA_FLY_DURATION,
        });
        this.view.update();
    }

    clear() {
        this._context.clearRect(0, 0, this._canvas.width, this._canvas.height);
    }

    update() {
        this.clear();
        this._toView = new Matrix4().makeRotationFromEuler(this.cameraController.camera.rotation).invert();
        this._hovered = this._mouse && this._canClick ? this.pick(this._mouse) : undefined;
        this.drawAxes();
        for (const face of this.visibleFaces()) this.drawFace(face);
        this.drawHoveredCorner();
    }

    /** Canvas position of a cube-space point (half-edge 1) — y down, z toward the viewer. */
    project(point: Vector3): Vector3 {
        const p = point.clone().applyMatrix4(this._toView);
        const c = options.size / 2;
        return new Vector3(c + p.x * options.cubeScale, c - p.y * options.cubeScale, p.z);
    }

    private visibleFaces(): CubeFace[] {
        return FACES.filter((face) => face.normal.clone().applyMatrix4(this._toView).z > 1e-3);
    }

    private faceCorners(face: CubeFace): Vector3[] {
        const up = face.up;
        const right = face.right;
        return [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
        ].map(([r, u]) =>
            this.project(
                face.normal.clone().add(right.clone().multiplyScalar(r)).add(up.clone().multiplyScalar(u)),
            ),
        );
    }

    /** A corner wins over the face it sits on, so the isometric views stay reachable. */
    pick(mouse: Vector3): CubeTarget | undefined {
        let best: Vector3 | undefined;
        let bestDistance = options.cornerPickRadius;
        for (const corner of CORNERS) {
            const p = this.project(corner);
            if (p.z < 0) continue;
            const distance = Math.hypot(p.x - mouse.x, p.y - mouse.y);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = corner;
            }
        }
        if (best !== undefined) return { kind: "corner", direction: best.clone() };
        const face = this.visibleFaces().find((f) => insidePolygon(mouse, this.faceCorners(f)));
        return face === undefined ? undefined : { kind: "face", face };
    }

    private drawFace(face: CubeFace) {
        const ctx = this._context;
        const corners = this.faceCorners(face);
        const hovered = this._hovered?.kind === "face" && this._hovered.face === face;
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (const p of corners.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.closePath();
        ctx.fillStyle = hovered ? options.colors.hover : options.colors.face;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = options.colors.faceEdge;
        ctx.stroke();
        this.drawLabel(face);
    }

    /**
     * The label is drawn in the face's own plane: the 2D transform maps the face's right/down
     * directions onto their projections, so it foreshortens with the cube.
     */
    private drawLabel(face: CubeFace) {
        const ctx = this._context;
        const center = this.project(face.normal);
        const [right, down] = this.readableAxes(face, center);
        const text = I18n.translate(face.label).toUpperCase();
        ctx.save();
        // Face units are scaled by 100 so the font is a normal pixel size, not a fraction of one.
        const k = 0.01;
        ctx.setTransform(right.x * k, right.y * k, down.x * k, down.y * k, center.x, center.y);
        ctx.font = `600 34px ${options.fontFamily}`;
        const width = ctx.measureText(text).width;
        if (width > 172) ctx.font = `600 ${Math.floor((34 * 172) / width)}px ${options.fontFamily}`;
        ctx.fillStyle = options.colors.text;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, 0, 0);
        ctx.restore();
    }

    /**
     * The label's right and down directions on screen: of the face's four quarter turns, the one
     * that reads most upright, so the top face is not lettered upside down from behind.
     */
    private readableAxes(face: CubeFace, center: Vector3): [Vector3, Vector3] {
        let best: [Vector3, Vector3] | undefined;
        let bestScore = -Infinity;
        let right = face.right.clone();
        let up = face.up.clone();
        for (let turn = 0; turn < 4; turn++) {
            const r = this.project(face.normal.clone().add(right)).sub(center);
            const d = this.project(face.normal.clone().sub(up)).sub(center);
            const score = r.x + d.y;
            if (score > bestScore + 1e-6) {
                bestScore = score;
                best = [r, d];
            }
            [right, up] = [up.clone(), right.clone().negate()];
        }
        return best!;
    }

    private drawHoveredCorner() {
        if (this._hovered?.kind !== "corner") return;
        const p = this.project(this._hovered.direction);
        const ctx = this._context;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8, 0, 2 * Math.PI, false);
        ctx.fillStyle = options.colors.hover;
        ctx.fill();
    }

    /** X/Y/Z along the cube's edges out of its (-x, -y, -z) corner, drawn under the faces. */
    private drawAxes() {
        const ctx = this._context;
        const origin = v(-1, -1, -1);
        const start = this.project(origin);
        const axes: [Vector3, string, string][] = [
            [v(1, 0, 0), "X", options.colors.x],
            [v(0, 1, 0), "Y", options.colors.y],
            [v(0, 0, 1), "Z", options.colors.z],
        ];
        ctx.font = `bold 20px ${options.fontFamily}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (const [direction, label, color] of axes) {
            const end = this.project(origin.clone().add(direction.clone().multiplyScalar(2.2)));
            const tip = this.project(origin.clone().add(direction.clone().multiplyScalar(2.45)));
            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
            ctx.lineWidth = 4;
            ctx.strokeStyle = color;
            ctx.stroke();
            ctx.fillStyle = color;
            ctx.fillText(label, tip.x, tip.y);
        }
    }
}

customElements.define("view-gizmo", ViewGizmo);
