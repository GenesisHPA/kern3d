// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ARROW_HOVER_TOLERANCE,
    ARROW_LENGTH,
    type AsyncController,
    arrowMeshes,
    distanceToSegment,
    type IDocument,
    type IView,
    Line,
    Plane,
    PubSub,
    pxSizedArrowLength,
    type ShapeMeshData,
    XYZ,
} from "@chili3d/core";
import { PlacementPreviewHandler, type PlacementSource } from "./placementPreview";

/** A placement whose translation the gizmo drags: the offsets and where they are measured from. */
export interface DraggablePlacement extends PlacementSource {
    /** The point the arrows stand on before the move (the selection's centre or the pivot). */
    pivot(): XYZ;
    /** The translation so far, world millimetres. */
    offset(): XYZ;
    /** Writes a new translation; the command shows it in its panel and redraws. */
    setOffset(offset: XYZ): void;
}

const AXES = [XYZ.unitX, XYZ.unitY, XYZ.unitZ];
/** X red, Y green, Z blue — the colours of the view cube and the grid axes. */
const AXIS_COLORS = [0xe53935, 0x43a047, 0x1e88e5];
const AXIS_HOVER_COLORS = [0xff8a80, 0xa5d6a7, 0x90caf9];
const DRAG_THRESHOLD_SQ = 9;
/** Dragged offsets land on a tenth of a millimetre. */
const STEP = 0.1;

function snap(value: number): number {
    return Math.round(value / STEP) * STEP;
}

/**
 * The moved bodies' preview with a move gizmo on them (Fusion's Move): three arrows at the
 * moved centre — drag one to slide along its axis; drag anywhere else to slide in the world
 * plane that faces the screen most. The offsets go to the command as they change, so its
 * panel follows the hand and a typed value moves the gizmo.
 */
export class MoveGizmoHandler extends PlacementPreviewHandler {
    private _ids: number[] = [];
    private _hover: number | undefined;
    private _down: { x: number; y: number } | undefined;
    private _drag:
        | { kind: "axis"; axis: number; start: XYZ; grab: number }
        | { kind: "plane"; plane: Plane; start: XYZ; grab: XYZ }
        | undefined;
    private _length = ARROW_LENGTH;
    private readonly _cache = new Map<string, ShapeMeshData[]>();

    constructor(
        document: IDocument,
        controller: AsyncController,
        private readonly placement: DraggablePlacement,
    ) {
        super(document, controller, placement);
        // the base draws the preview from its constructor, before this class's fields exist:
        // the arrows go up now that they do
        this.refreshHandle(document.application.activeView);
    }

    private origin(): XYZ {
        return this.placement.pivot().add(this.placement.offset());
    }

    private segment(axis: number): { start: XYZ; end: XYZ } {
        const start = this.origin();
        return { start, end: start.add(AXES[axis].multiply(this._length)) };
    }

    private axisAt(view: IView, event: PointerEvent): number | undefined {
        let best: { axis: number; d: number } | undefined;
        for (let axis = 0; axis < 3; axis++) {
            const { start, end } = this.segment(axis);
            const d = distanceToSegment(
                event.offsetX,
                event.offsetY,
                view.worldToScreen(start),
                view.worldToScreen(end),
            );
            if (d <= ARROW_HOVER_TOLERANCE && (best === undefined || d < best.d)) best = { axis, d };
        }
        return best?.axis;
    }

    // ------------------------------------------------------------------ The arrows

    protected override refreshHandle(view?: IView): void {
        if (this.placement === undefined || this._ids === undefined) return;
        const v = view ?? this.document.application.activeView;
        if (v !== undefined) {
            const length = pxSizedArrowLength(v, this.origin(), XYZ.unitZ);
            if (length !== undefined) this._length = length;
        }
        this.removeHandle();
        const context = this.document.visual.context;
        const scale = this._length / ARROW_LENGTH;
        const origin = this.origin();
        for (let axis = 0; axis < 3; axis++) {
            const active = this._hover === axis || (this._drag?.kind === "axis" && this._drag.axis === axis);
            const color = active ? AXIS_HOVER_COLORS[axis] : AXIS_COLORS[axis];
            const key = `${axis}:${color}`;
            let meshes = this._cache.get(key);
            if (meshes === undefined) {
                meshes = arrowMeshes(XYZ.zero, AXES[axis], ARROW_LENGTH, color);
                this._cache.set(key, meshes);
            }
            for (const mesh of meshes) {
                const position = new Float32Array(mesh.position.length);
                for (let i = 0; i < position.length; i += 3) {
                    position[i] = mesh.position[i] * scale + origin.x;
                    position[i + 1] = mesh.position[i + 1] * scale + origin.y;
                    position[i + 2] = mesh.position[i + 2] * scale + origin.z;
                }
                this._ids.push(context.displayMesh([{ ...mesh, position }], { meshOpacity: 1, onTop: true }));
            }
        }
        this.document.visual.update();
    }

    protected override removeHandle(): void {
        if (this._ids === undefined) return;
        for (const id of this._ids) this.document.visual.context.removeMesh(id);
        this._ids = [];
    }

    // ------------------------------------------------------------------ The gesture

    override pointerMove(view: IView, event: PointerEvent): void {
        if (this._down !== undefined && this._drag === undefined) {
            const dx = event.offsetX - this._down.x;
            const dy = event.offsetY - this._down.y;
            if (dx * dx + dy * dy > DRAG_THRESHOLD_SQ) this.beginDrag(view, event);
        }
        if (this._drag !== undefined) {
            this.updateDrag(view, event);
            return;
        }
        const hover = this.axisAt(view, event);
        if (hover !== this._hover) {
            this._hover = hover;
            this.refreshHandle(view);
        }
    }

    override pointerDown(view: IView, event: PointerEvent): void {
        if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
        this._down = { x: event.offsetX, y: event.offsetY };
        this._hover = this.axisAt(view, event);
    }

    override pointerUp(view: IView, _event: PointerEvent): void {
        const dragged = this._drag !== undefined;
        this._down = undefined;
        this._drag = undefined;
        if (dragged) {
            PubSub.default.pub("clearFloatTip");
            this.refreshHandle(view);
        }
    }

    private beginDrag(view: IView, event: PointerEvent): void {
        const start = this.placement.offset();
        const origin = this.origin();
        if (this._hover !== undefined) {
            const axis = this._hover;
            this._drag = { kind: "axis", axis, start, grab: this.alongAxis(view, event, axis, origin) };
            return;
        }
        // the world plane through the centre that faces the screen most
        const toward = view.direction();
        const n = [Math.abs(toward.x), Math.abs(toward.y), Math.abs(toward.z)];
        const k = n.indexOf(Math.max(...n));
        const normal = AXES[k];
        const plane = new Plane({ origin, normal, xvec: AXES[(k + 1) % 3] });
        const grab = plane.intersectRay(view.rayAt(event.offsetX, event.offsetY));
        if (grab !== undefined) this._drag = { kind: "plane", plane, start, grab };
    }

    private alongAxis(view: IView, event: PointerEvent, axis: number, origin: XYZ): number {
        const ray = view.rayAt(event.offsetX, event.offsetY);
        const line = new Line({ point: origin, direction: AXES[axis] });
        return line.nearestTo(ray.toLine()).sub(origin).dot(AXES[axis]);
    }

    private updateDrag(view: IView, event: PointerEvent): void {
        const drag = this._drag!;
        let offset: XYZ;
        if (drag.kind === "axis") {
            const base = this.placement.pivot().add(drag.start);
            const along = this.alongAxis(view, event, drag.axis, base) - drag.grab;
            const values = [drag.start.x, drag.start.y, drag.start.z];
            values[drag.axis] = snap(values[drag.axis] + along);
            offset = new XYZ({ x: values[0], y: values[1], z: values[2] });
        } else {
            const at = drag.plane.intersectRay(view.rayAt(event.offsetX, event.offsetY));
            if (at === undefined) return;
            const d = at.sub(drag.grab);
            offset = new XYZ({
                x: snap(drag.start.x + d.x),
                y: snap(drag.start.y + d.y),
                z: snap(drag.start.z + d.z),
            });
        }
        this.placement.setOffset(offset);
        const f = (x: number) => (Math.round(x * 10) / 10).toString();
        // the command redraws the preview (and this gizmo) as its values change
        PubSub.default.pub("showFloatTip", {
            level: "info",
            msg: `ΔX ${f(offset.x)}  ΔY ${f(offset.y)}  ΔZ ${f(offset.z)}`,
        });
        void view;
    }

    protected override onCleanupStart(): void {
        PubSub.default.pub("clearFloatTip");
    }
}
