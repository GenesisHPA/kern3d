// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, type IShape, type Matrix4, Plane, ShapeNode, XYZ } from "@chili3d/core";
import {
    type DrawingData,
    type DrawingViewData,
    newDrawingItemId,
    type ProjectionSide,
    type ViewOrientation,
} from "./drawingData";
import { computeViewGeometry, type HlrInput, type ViewGeometry } from "./hlr";
import { extractHlrInput } from "./hlrInput";
import { drawingArea } from "./sheet";
import {
    basisOf,
    fittingScale,
    orientationBasis,
    orientationOf,
    projectedBasis,
    type ViewBasis,
} from "./viewBasis";

/** The shape a view projects, placed in the world. */
export interface ViewSource {
    shape: IShape;
    transform: Matrix4;
}

export function findSourceNode(document: IDocument, id: string): ShapeNode | undefined {
    return document.modelManager.findNodeDeep(
        (node): node is ShapeNode => node instanceof ShapeNode && node.id === id,
    );
}

export function resolveSource(document: IDocument, id: string): ViewSource | undefined {
    const node = findSourceNode(document, id);
    if (node === undefined || !node.shape.isOk) return undefined;
    return { shape: node.shape.value, transform: node.worldTransform() };
}

export function viewBasisOf(view: DrawingViewData): ViewBasis {
    return basisOf(view.u, view.v);
}

/**
 * Projected line work per view, computed on demand and kept while the shape object and the
 * view's direction and options stay the same. A model edit replaces the node's shape object,
 * so the next request after one projects afresh.
 */
export class ViewGeometryCache {
    private readonly inputs = new WeakMap<IShape, { transform: Matrix4; input: HlrInput }>();
    private readonly cuts = new WeakMap<IShape, Map<string, HlrInput>>();
    private readonly geometries = new Map<string, { shape: IShape; key: string; geometry: ViewGeometry }>();

    constructor(private readonly resolve: (sourceId: string) => ViewSource | undefined) {}

    /** The uncut model of a source, in world coordinates: what automatic dimensioning reads. */
    inputFor(sourceId: string): HlrInput | undefined {
        const source = this.resolve(sourceId);
        return source === undefined ? undefined : this.inputOf(source);
    }

    /**
     * The model with everything between the viewer and the section plane cut away: a box on
     * the viewer's side of the plane, far larger than the model, subtracted from it.
     */
    private sectionInputOf(source: ViewSource, view: DrawingViewData, offset: number): HlrInput {
        const key = JSON.stringify([view.u, view.v, offset, source.transform.toArray()]);
        let byKey = this.cuts.get(source.shape);
        if (byKey === undefined) {
            byKey = new Map();
            this.cuts.set(source.shape, byKey);
        }
        const cached = byKey.get(key);
        if (cached !== undefined) return cached;
        const basis = viewBasisOf(view);
        const world = source.shape.transformed(source.transform);
        const box = world.boundingBox();
        const size = Math.max(
            1,
            Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z),
        );
        const L = size * 4 + Math.abs(offset) * 2;
        const xyz = (a: readonly number[]) => new XYZ({ x: a[0], y: a[1], z: a[2] });
        const [u, v, w] = [basis.u, basis.v, basis.w];
        const origin = xyz([0, 1, 2].map((i) => w[i] * offset - L * u[i] - L * v[i]));
        const plane = new Plane({ origin, normal: xyz(w), xvec: xyz(u) });
        let input: HlrInput;
        const cutter = shapeFactory.box(plane, 2 * L, 2 * L, L);
        const cut = cutter.isOk ? shapeFactory.booleanCut([world], [cutter.value]) : undefined;
        input = cut?.isOk ? extractHlrInput(cut.value) : this.inputOf(source);
        byKey.set(key, input);
        return input;
    }

    private inputOf(source: ViewSource): HlrInput {
        const cached = this.inputs.get(source.shape);
        if (cached !== undefined && cached.transform.equals(source.transform)) return cached.input;
        const input = extractHlrInput(source.shape, source.transform);
        this.inputs.set(source.shape, { transform: source.transform, input });
        return input;
    }

    geometryOf(view: DrawingViewData): ViewGeometry | undefined {
        const source = this.resolve(view.sourceId);
        if (source === undefined) return undefined;
        const section = view.section?.offset;
        const key = JSON.stringify([
            view.u,
            view.v,
            view.showHidden,
            view.showTangent,
            section,
            source.transform.toArray(),
        ]);
        const cached = this.geometries.get(view.id);
        if (cached !== undefined && cached.shape === source.shape && cached.key === key)
            return cached.geometry;
        const input =
            section === undefined ? this.inputOf(source) : this.sectionInputOf(source, view, section);
        const geometry = computeViewGeometry(input, viewBasisOf(view), {
            // a section shows what the cut opened, not what lies hidden behind it
            hidden: view.showHidden && section === undefined,
            tangent: view.showTangent,
            section,
        });
        this.geometries.set(view.id, { shape: source.shape, key, geometry });
        return geometry;
    }

    all(data: DrawingData): Map<string, ViewGeometry> {
        const result = new Map<string, ViewGeometry>();
        for (const view of data.views) {
            const geometry = this.geometryOf(view);
            if (geometry !== undefined) result.set(view.id, geometry);
        }
        return result;
    }

    clear() {
        this.geometries.clear();
    }
}

export function newView(sourceId: string, orientation: ViewOrientation, scale: number, x: number, y: number) {
    const basis = orientationBasis(orientation);
    const view: DrawingViewData = {
        id: newDrawingItemId("v"),
        sourceId,
        orientation,
        u: basis.u,
        v: basis.v,
        scale,
        x,
        y,
        showHidden: orientation !== "iso",
        showTangent: orientation === "iso",
        showCenterMarks: orientation !== "iso",
    };
    return view;
}

const VIEW_GAP = 20;

function halfSize(geometry: ViewGeometry | undefined, scale: number): [number, number] {
    if (geometry === undefined || !Number.isFinite(geometry.bounds.minX)) return [20, 15];
    const b = geometry.bounds;
    return [((b.maxX - b.minX) * scale) / 2, ((b.maxY - b.minY) * scale) / 2];
}

/**
 * A view projected from `parent` onto `side` of it, at the parent's scale and aligned with it
 * — rows for a side view, columns for one above or below — placed clear of the parent.
 */
export function projectedView(
    data: DrawingData,
    parent: DrawingViewData,
    side: ProjectionSide,
    geometryOf: (view: DrawingViewData) => ViewGeometry | undefined,
): DrawingViewData {
    const basis = projectedBasis(viewBasisOf(parent), side, data.projection);
    const view: DrawingViewData = {
        ...newView(parent.sourceId, "front", parent.scale, parent.x, parent.y),
        orientation: orientationOf(basis),
        u: basis.u,
        v: basis.v,
        parentId: parent.id,
        side,
        showHidden: parent.showHidden,
        showTangent: parent.showTangent,
        showCenterMarks: parent.showCenterMarks,
    };
    const [pw, ph] = halfSize(geometryOf(parent), parent.scale);
    const [cw, ch] = halfSize(geometryOf(view), view.scale);
    if (side === "right") view.x = parent.x + pw + VIEW_GAP + cw;
    if (side === "left") view.x = parent.x - pw - VIEW_GAP - cw;
    if (side === "up") view.y = parent.y + ph + VIEW_GAP + ch;
    if (side === "down") view.y = parent.y - ph - VIEW_GAP - ch;
    return view;
}

/** An isometric view of the parent's model at its scale, in the drawing area's top-right corner. */
export function isometricView(
    data: DrawingData,
    parent: DrawingViewData,
    geometryOf: (view: DrawingViewData) => ViewGeometry | undefined,
): DrawingViewData {
    const view = newView(parent.sourceId, "iso", parent.scale, 0, 0);
    const [hw, hh] = halfSize(geometryOf(view), view.scale);
    const area = drawingArea(data.sheet, data.titleBlock.kind);
    view.x = area.maxX - hw - 10;
    view.y = area.maxY - hh - 10;
    return view;
}

/** Keeps every projected view on its parent's row or column and at its scale, recursively. */
export function alignProjectedViews(data: DrawingData) {
    const byId = new Map(data.views.map((v) => [v.id, v]));
    const settle = (view: DrawingViewData, depth: number) => {
        if (view.parentId === undefined || depth > 16) return;
        const parent = byId.get(view.parentId);
        if (parent === undefined) {
            view.parentId = undefined;
            view.side = undefined;
            return;
        }
        settle(parent, depth + 1);
        view.scale = parent.scale;
        if (view.side === "right" || view.side === "left") view.y = parent.y;
        else view.x = parent.x;
    };
    for (const view of data.views) settle(view, 0);
}

/** Removes a view, the views projected from it, and the dimensions placed on any of them. */
export function removeView(data: DrawingData, id: string) {
    const doomed = new Set([id]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const v of data.views) {
            if (v.parentId !== undefined && doomed.has(v.parentId) && !doomed.has(v.id)) {
                doomed.add(v.id);
                grew = true;
            }
        }
    }
    data.views = data.views.filter((v) => !doomed.has(v.id));
    data.dimensions = data.dimensions.filter((d) => !doomed.has(d.viewId));
}

/**
 * The standard three views — front, top and the side view — of a source, at the largest
 * ГОСТ scale that fits them into the sheet's drawing area, centred in it.
 */
export function layoutStandardViews(
    data: DrawingData,
    sourceId: string,
    geometryOf: (view: DrawingViewData) => ViewGeometry | undefined,
) {
    const front = newView(sourceId, "front", 1, 0, 0);
    const frontGeometry = geometryOf(front);
    const area = drawingArea(data.sheet, data.titleBlock.kind);
    const b = frontGeometry?.bounds;
    const valid = b !== undefined && Number.isFinite(b.minX);
    const width = valid ? b.maxX - b.minX : 40;
    const height = valid ? b.maxY - b.minY : 30;
    // the side and top views are as deep as the model; front + side across, front + top down
    const top = newView(sourceId, "top", 1, 0, 0);
    const tb = geometryOf(top)?.bounds;
    const depth = tb !== undefined && Number.isFinite(tb.minY) ? tb.maxY - tb.minY : height;
    const roomW = area.maxX - area.minX - 3 * VIEW_GAP;
    const roomH = area.maxY - area.minY - 3 * VIEW_GAP;
    const scale = Math.min(fittingScale(width + depth, roomW), fittingScale(height + depth, roomH));
    front.scale = scale;
    const totalW = (width + depth) * scale + VIEW_GAP;
    const totalH = (height + depth) * scale + VIEW_GAP;
    const cx = (area.minX + area.maxX) / 2;
    const cy = (area.minY + area.maxY) / 2;
    const firstAngle = data.projection === "first";
    front.x = cx - totalW / 2 + (width * scale) / 2;
    front.y = firstAngle ? cy + totalH / 2 - (height * scale) / 2 : cy - totalH / 2 + (height * scale) / 2;
    data.views.push(front);
    data.views.push(projectedView(data, front, firstAngle ? "down" : "up", geometryOf));
    data.views.push(projectedView(data, front, "right", geometryOf));
}
