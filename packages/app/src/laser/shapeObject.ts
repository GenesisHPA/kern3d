// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { FontOutline } from "@chili3d/core";
import { apply, type Pt } from "./geometry";
import { defaultOperation, type LaserVectorObject, newLaserId, placement } from "./laserData";
import { type LaserShape, needsFont, type ShapeGeometry, shapeGeometry } from "./shapes";

/**
 * A drawn figure as a laser object, and its outlines made anew after a change of parameters:
 * the object keeps its centre on the bed, its turn and its stretch (the size it was scaled to
 * over the figure's own size), so editing the text of a word laid out at an angle leaves it
 * where it was.
 */

export function applyGeometry(o: LaserVectorObject, g: ShapeGeometry) {
    const sx = o.sourceWidth > 0 ? o.width / o.sourceWidth : 1;
    const sy = o.sourceHeight > 0 ? o.height / o.sourceHeight : 1;
    const centre = apply(placement(o), { x: o.width / 2, y: o.height / 2 });
    o.paths = g.paths;
    o.sourceWidth = g.width;
    o.sourceHeight = g.height;
    o.width = g.width * sx;
    o.height = g.height * sy;
    o.x = centre.x - o.width / 2;
    o.y = centre.y - o.height / 2;
}

/**
 * The object's outlines from its shape again. False — the object left as it was — for a text
 * whose font is not at hand, or a barcode its data does not fit (`error` says which).
 */
export function regenerate(o: LaserVectorObject, font?: FontOutline): { ok: boolean; error?: string } {
    if (o.shape === undefined) return { ok: false };
    if (o.shape.type === "text" && font === undefined) return { ok: false };
    const g = shapeGeometry(o.shape, needsFont(o.shape) ? font : undefined);
    if (g.paths.length === 0) return { ok: false, error: g.error };
    applyGeometry(o, g);
    return { ok: true };
}

/**
 * A rectangle or an ellipse scaled on the bed takes the new size as its own, so its round
 * corners stay round instead of being stretched with it. Other figures keep the stretch (a
 * text squeezed narrower is a narrower text). True when the outlines were made again.
 */
export function bakeSize(o: LaserVectorObject): boolean {
    const s = o.shape;
    if (s === undefined) return false;
    const same = Math.abs(o.width - o.sourceWidth) < 1e-9 && Math.abs(o.height - o.sourceHeight) < 1e-9;
    if (same) return false;
    if (s.type === "rect") {
        s.width = o.width;
        s.height = o.height;
    } else if (s.type === "ellipse") {
        s.rx = o.width / 2;
        s.ry = o.height / 2;
    } else return false;
    const g = shapeGeometry(s);
    o.paths = g.paths;
    o.sourceWidth = g.width;
    o.sourceHeight = g.height;
    o.width = g.width;
    o.height = g.height;
    return true;
}

/**
 * A new object of `shape`, its box's lower-left corner at `corner` on the bed (or, with
 * `centre`, its middle there), turned `angle` degrees. Undefined when it has no outlines.
 */
export function shapeObject(
    shape: LaserShape,
    name: string,
    at: { corner?: Pt; centre?: Pt; angle?: number },
    font?: FontOutline,
): LaserVectorObject | undefined {
    const g = shapeGeometry(shape, font);
    if (g.paths.length === 0) return undefined;
    const x = at.centre !== undefined ? at.centre.x - g.width / 2 : (at.corner?.x ?? 0);
    const y = at.centre !== undefined ? at.centre.y - g.height / 2 : (at.corner?.y ?? 0);
    return {
        id: newLaserId(),
        name,
        kind: "vector",
        x,
        y,
        width: g.width,
        height: g.height,
        angle: at.angle ?? 0,
        lockAspect: shape.type === "text" || shape.type === "polygon" || shape.type === "barcode",
        paths: g.paths,
        sourceWidth: g.width,
        sourceHeight: g.height,
        shape,
        // a barcode's modules are areas: filled, as EzCAD hatches them
        op: defaultOperation(shape.type === "barcode" ? "fill" : "line"),
    };
}
