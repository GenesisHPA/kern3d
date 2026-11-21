// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { FontOutline } from "@chili3d/core";
import { apply, type Pt, pathsBounds } from "./geometry";
import { defaultOperation, type LaserVectorObject, newLaserId, objectMatrix, placement } from "./laserData";
import {
    flattenSubPaths,
    type PathNode,
    type SubPath,
    subPathsFromOutlines,
    translateSubPaths,
} from "./pathShape";
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
    if (o.shape.type === "path") return { ok: rebuildPath(o) };
    if (o.shape.type === "text" && font === undefined) return { ok: false };
    const g = shapeGeometry(o.shape, needsFont(o.shape) ? font : undefined);
    if (g.paths.length === 0) return { ok: false, error: g.error };
    applyGeometry(o, g);
    return { ok: true };
}

/**
 * A path's outlines after its nodes moved, every node staying where it is on the bed: the
 * frame is moved to the new box's corner (the nodes shifted by as much) and the object placed
 * so the frame's middle lands where it was — the turn and the stretch kept. False when nothing
 * is left to draw.
 */
export function rebuildPath(o: LaserVectorObject): boolean {
    const s = o.shape;
    if (s?.type !== "path") return false;
    const paths = flattenSubPaths(s.subpaths);
    if (paths.length === 0) return false;
    const b = pathsBounds(paths);
    const w = Math.max(b.maxX - b.minX, 0.01);
    const h = Math.max(b.maxY - b.minY, 0.01);
    const sx = o.sourceWidth > 0 ? o.width / o.sourceWidth : 1;
    const sy = o.sourceHeight > 0 ? o.height / o.sourceHeight : 1;
    const centre = apply(objectMatrix(o), { x: b.minX + w / 2, y: b.minY + h / 2 });
    translateSubPaths(s.subpaths, -b.minX, -b.minY);
    o.paths = flattenSubPaths(s.subpaths);
    o.sourceWidth = w;
    o.sourceHeight = h;
    o.width = w * sx;
    o.height = h * sy;
    o.x = centre.x - o.width / 2;
    o.y = centre.y - o.height / 2;
    return true;
}

/** The quarter-circle handle length of a cubic, as a share of the radius. */
const KAPPA = 0.5522847498;

/**
 * A figure as Bézier nodes in its object's frame, for «Преобразовать в кривые»: an ellipse is
 * four smooth nodes, a round-cornered rectangle eight with the arcs' handles; anything else (a
 * polygon, a text, a barcode) the corners of its outlines.
 */
export function shapeToSubPaths(o: LaserVectorObject): SubPath[] {
    const s = o.shape;
    if (s?.type === "path") return s.subpaths;
    if (s?.type === "ellipse") {
        const cx = s.rx;
        const cy = s.ry;
        const kx = s.rx * KAPPA;
        const ky = s.ry * KAPPA;
        const node = (x: number, y: number, ix: number, iy: number): PathNode => ({
            x,
            y,
            in: { x: x - ix, y: y - iy },
            out: { x: x + ix, y: y + iy },
            smooth: true,
        });
        return [
            {
                closed: true,
                nodes: [
                    node(cx + s.rx, cy, 0, ky),
                    node(cx, cy + s.ry, -kx, 0),
                    node(cx - s.rx, cy, 0, -ky),
                    node(cx, cy - s.ry, kx, 0),
                ],
            },
        ];
    }
    if (s?.type === "rect" && s.radius > 0) {
        const r = Math.min(s.radius, s.width / 2, s.height / 2);
        const w = s.width;
        const h = s.height;
        const k = r * KAPPA;
        const n = (x: number, y: number, inn?: [number, number], out?: [number, number]): PathNode => ({
            x,
            y,
            in: inn && { x: x + inn[0], y: y + inn[1] },
            out: out && { x: x + out[0], y: y + out[1] },
        });
        return [
            {
                closed: true,
                nodes: [
                    n(r, 0, [-k, 0], undefined),
                    n(w - r, 0, undefined, [k, 0]),
                    n(w, r, [0, -k], undefined),
                    n(w, h - r, undefined, [0, k]),
                    n(w - r, h, [k, 0], undefined),
                    n(r, h, undefined, [-k, 0]),
                    n(0, h - r, [0, k], undefined),
                    n(0, r, undefined, [0, -k]),
                ],
            },
        ];
    }
    if (s?.type === "polyline")
        return [{ closed: s.closed, nodes: s.points.map((p) => ({ x: p.x, y: p.y })) }];
    return subPathsFromOutlines(o.paths);
}

/** The figure becomes an editable path of curves where it stood; false when there is nothing. */
export function convertToPath(o: LaserVectorObject): boolean {
    const subpaths = shapeToSubPaths(o);
    if (subpaths.length === 0) return false;
    o.shape = { type: "path", subpaths };
    return rebuildPath(o);
}

/** Subpaths in bed millimetres as a new path object: its frame from the box's lower-left corner. */
export function pathObject(subpaths: SubPath[], name: string): LaserVectorObject | undefined {
    const paths = flattenSubPaths(subpaths);
    if (paths.length === 0) return undefined;
    const b = pathsBounds(paths);
    translateSubPaths(subpaths, -b.minX, -b.minY);
    return shapeObject({ type: "path", subpaths }, name, { corner: { x: b.minX, y: b.minY } });
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
