// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { addPoint, apply, type Bounds, emptyBounds, type Pt } from "./geometry";
import { type LaserObject, objectCorners, placement } from "./laserData";

/**
 * Several objects at once: the box round them, moving, scaling and turning them together, and
 * lining them up (EzCAD's and LightBurn's align and distribute). An object is placed by its
 * box's lower-left corner, size and turn about its middle, so all of this works on the middles.
 */

export type Placement = Pick<LaserObject, "x" | "y" | "width" | "height" | "angle">;

export function boundsOf(objects: readonly LaserObject[]): Bounds {
    const b = emptyBounds();
    for (const o of objects) for (const p of objectCorners(o)) addPoint(b, p);
    return b;
}

export function centreOf(o: Placement): Pt {
    return apply(placement(o), { x: o.width / 2, y: o.height / 2 });
}

function placeCentre(o: Placement, c: Pt) {
    o.x = c.x - o.width / 2;
    o.y = c.y - o.height / 2;
}

export function moveAll(objects: LaserObject[], origins: readonly Placement[], dx: number, dy: number) {
    objects.forEach((o, i) => {
        o.x = origins[i].x + dx;
        o.y = origins[i].y + dy;
    });
}

/**
 * Scaled about `anchor` by sx, sy: the middles move, the sizes follow. An object turned other
 * than by a right angle cannot be stretched along the bed's axes, so it is scaled evenly (by the
 * mean) — its shape stays, only the group's spread follows the drag.
 */
export function scaleAll(
    objects: LaserObject[],
    origins: readonly Placement[],
    anchor: Pt,
    sx: number,
    sy: number,
) {
    objects.forEach((o, i) => {
        const from = origins[i];
        const c = centreOf(from);
        const quarter = Math.abs(((from.angle % 90) + 90) % 90) < 1e-6;
        const swapped = quarter && Math.abs((((from.angle % 180) + 180) % 180) - 90) < 1e-6;
        const even = Math.sqrt(Math.abs(sx * sy));
        const kw = quarter ? (swapped ? sy : sx) : even;
        const kh = quarter ? (swapped ? sx : sy) : even;
        o.width = Math.max(0.01, from.width * Math.abs(kw));
        o.height = Math.max(0.01, from.height * Math.abs(kh));
        o.angle = from.angle;
        placeCentre(o, { x: anchor.x + (c.x - anchor.x) * sx, y: anchor.y + (c.y - anchor.y) * sy });
    });
}

/** Turned together about `centre` by `degrees`: each middle goes round it, each object turns with it. */
export function rotateAll(
    objects: LaserObject[],
    origins: readonly Placement[],
    centre: Pt,
    degrees: number,
) {
    const a = (degrees * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    objects.forEach((o, i) => {
        const from = origins[i];
        const c = centreOf(from);
        const dx = c.x - centre.x;
        const dy = c.y - centre.y;
        o.width = from.width;
        o.height = from.height;
        o.angle = normalizeAngle(from.angle + degrees);
        placeCentre(o, { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos });
    });
}

export function normalizeAngle(a: number): number {
    return Math.round((((((a + 180) % 360) + 360) % 360) - 180) * 100) / 100;
}

export const ALIGNS = ["left", "centerX", "right", "top", "centerY", "bottom"] as const;
export type Align = (typeof ALIGNS)[number];

/** Each object's box moved so its edge or middle meets the target's (the selection's or the bed's). */
export function alignObjects(objects: LaserObject[], align: Align, target: Bounds) {
    for (const o of objects) {
        const b = boundsOf([o]);
        let dx = 0;
        let dy = 0;
        if (align === "left") dx = target.minX - b.minX;
        if (align === "right") dx = target.maxX - b.maxX;
        if (align === "centerX") dx = (target.minX + target.maxX) / 2 - (b.minX + b.maxX) / 2;
        if (align === "bottom") dy = target.minY - b.minY;
        if (align === "top") dy = target.maxY - b.maxY;
        if (align === "centerY") dy = (target.minY + target.maxY) / 2 - (b.minY + b.maxY) / 2;
        o.x += dx;
        o.y += dy;
    }
}

/** Equal gaps between the boxes along x or y, the two outermost staying where they are. */
export function distributeObjects(objects: LaserObject[], axis: "x" | "y") {
    if (objects.length < 3) return;
    const boxes = objects.map((o) => ({ o, b: boundsOf([o]) }));
    const lo = (b: Bounds) => (axis === "x" ? b.minX : b.minY);
    const hi = (b: Bounds) => (axis === "x" ? b.maxX : b.maxY);
    boxes.sort((p, q) => lo(p.b) - lo(q.b));
    const start = lo(boxes[0].b);
    const end = Math.max(...boxes.map((p) => hi(p.b)));
    const total = boxes.reduce((s, p) => s + hi(p.b) - lo(p.b), 0);
    const gap = (end - start - total) / (boxes.length - 1);
    let at = start;
    for (const { o, b } of boxes) {
        const shift = at - lo(b);
        if (axis === "x") o.x += shift;
        else o.y += shift;
        at += hi(b) - lo(b) + gap;
    }
}

/** Objects whose box lies wholly inside the rubber band. */
export function inside(objects: readonly LaserObject[], band: Bounds): LaserObject[] {
    return objects.filter((o) =>
        objectCorners(o).every(
            (p) => p.x >= band.minX && p.x <= band.maxX && p.y >= band.minY && p.y <= band.maxY,
        ),
    );
}
