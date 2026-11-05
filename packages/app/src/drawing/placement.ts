// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { DrawingViewData, Point2 } from "./drawingData";
import type { ViewGeometry } from "./hlr";

/** Maps a view's model 2D frame onto the sheet: centred at the view's position, scaled. */
export interface ViewPlacement {
    view: DrawingViewData;
    geometry: ViewGeometry | undefined;
    cx: number;
    cy: number;
}

export function placementOf(view: DrawingViewData, geometry: ViewGeometry | undefined): ViewPlacement {
    const b = geometry?.bounds;
    const valid = b !== undefined && Number.isFinite(b.minX);
    return {
        view,
        geometry,
        cx: valid ? (b.minX + b.maxX) / 2 : 0,
        cy: valid ? (b.minY + b.maxY) / 2 : 0,
    };
}

export function toSheet(placement: ViewPlacement, x: number, y: number): Point2 {
    const s = placement.view.scale;
    return [placement.view.x + s * (x - placement.cx), placement.view.y + s * (y - placement.cy)];
}

export function fromSheet(placement: ViewPlacement, x: number, y: number): Point2 {
    const s = placement.view.scale;
    return [placement.cx + (x - placement.view.x) / s, placement.cy + (y - placement.view.y) / s];
}
