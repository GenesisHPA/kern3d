// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    CurveUtils,
    type IEdge,
    type IFace,
    type IVertex,
    type IView,
    Plane,
    ShapeTypes,
    type XYZ,
} from "@chili3d/core";

/** How a sketch frame is fitted to a picked face (the sketch command's two options). */
export interface FaceFrameOptions {
    /** The origin goes to the clicked point, snapped to a nearby vertex, edge midpoint or arc centre. */
    originAtPick: boolean;
    /** The axes turn to the nearest straight edge of the face. */
    axesAlongEdge: boolean;
}

/** How close, in screen pixels, a click has to be to a vertex/midpoint/centre to snap onto it. */
const SNAP_PIXELS = 12;

/**
 * The sketch frame for a face picked at `pick`, Fusion-style: the origin where the user
 * clicked (snapped onto a feature point nearby) and the axes along the face's nearest
 * straight edge. `base` is the face's default frame (`sketchPlaneOfFace`); `face` must be in
 * world coordinates. Options off, or no pick point, give `base` back unchanged.
 */
export function faceSketchFrame(
    face: IFace,
    base: Plane,
    pick: XYZ | undefined,
    view: IView | undefined,
    options: FaceFrameOptions,
): Plane {
    if (pick === undefined || (!options.originAtPick && !options.axesAlongEdge)) return base;
    const point = base.project(pick);
    const edges = face.findSubShapes(ShapeTypes.edge) as IEdge[];
    const origin = options.originAtPick
        ? snapOrigin(face, edges, base, point, snapDistance(view, point, base))
        : base.origin;
    const xvec = options.axesAlongEdge ? (edgeAlignedXVec(edges, base, point) ?? base.xvec) : base.xvec;
    return new Plane({ origin, normal: base.normal, xvec });
}

/** World length of SNAP_PIXELS at `point`; zero (no snapping) without a view. */
function snapDistance(view: IView | undefined, point: XYZ, base: Plane): number {
    if (view === undefined) return 0;
    const probe = 100;
    const a = view.worldToScreen(point);
    // Both in-plane axes: on a face seen at a slant one of them is foreshortened.
    const pixelsPerUnit = Math.max(
        ...[base.xvec, base.yvec].map((axis) => {
            const b = view.worldToScreen(point.add(axis.multiply(probe)));
            return Math.hypot(b.x - a.x, b.y - a.y) / probe;
        }),
    );
    return pixelsPerUnit > 0 ? SNAP_PIXELS / pixelsPerUnit : 0;
}

/** The face's feature points a click can snap onto: vertices, line midpoints, arc centres. */
function snapCandidates(face: IFace, edges: IEdge[]): XYZ[] {
    const points = (face.findSubShapes(ShapeTypes.vertex) as IVertex[]).map((v) => v.point());
    for (const edge of edges) {
        // An edge's curve is the trimmed window; its basis says what kind of curve it is.
        const curve = edge.curve;
        const basis = curve.basisCurve;
        if (CurveUtils.isLine(basis)) {
            const mid = (curve.firstParameter() + curve.lastParameter()) / 2;
            points.push(curve.value(mid));
        } else if (CurveUtils.isCircle(basis)) {
            points.push(basis.center);
        }
    }
    return points;
}

function snapOrigin(face: IFace, edges: IEdge[], base: Plane, point: XYZ, tolerance: number): XYZ {
    let best = point;
    let bestDistance = tolerance;
    for (const candidate of snapCandidates(face, edges)) {
        const projected = base.project(candidate);
        const distance = projected.distanceTo(point);
        if (distance <= bestDistance) {
            best = projected;
            bestDistance = distance;
        }
    }
    return best;
}

/**
 * The base x axis turned onto the straight edge nearest `point`. Of the four turns that put
 * an axis on the edge, the smallest is taken: the edge becomes X or Y, whichever keeps the
 * sketch closest to upright in the view. Undefined when the face has no straight edge.
 */
function edgeAlignedXVec(edges: IEdge[], base: Plane, point: XYZ): XYZ | undefined {
    let direction: XYZ | undefined;
    let bestDistance = Infinity;
    for (const edge of edges) {
        const curve = edge.curve;
        if (!CurveUtils.isLine(curve.basisCurve)) continue;
        const start = base.project(curve.value(curve.firstParameter()));
        const end = base.project(curve.value(curve.lastParameter()));
        const distance = segmentDistance(point, start, end);
        const dir = end.sub(start).normalize();
        if (dir !== undefined && distance < bestDistance) {
            bestDistance = distance;
            direction = dir;
        }
    }
    if (direction === undefined) return undefined;
    const angle = Math.atan2(direction.dot(base.yvec), direction.dot(base.xvec));
    const quarter = Math.PI / 2;
    const turn = angle - Math.round(angle / quarter) * quarter;
    return base.xvec.multiply(Math.cos(turn)).add(base.yvec.multiply(Math.sin(turn)));
}

function segmentDistance(point: XYZ, start: XYZ, end: XYZ): number {
    const segment = end.sub(start);
    const lengthSq = segment.dot(segment);
    if (lengthSq === 0) return point.distanceTo(start);
    const t = Math.min(1, Math.max(0, point.sub(start).dot(segment) / lengthSq));
    return point.distanceTo(start.add(segment.multiply(t)));
}
