// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import ClipperLib from "clipper-lib";

export interface Pt {
    x: number;
    y: number;
}

/** Clipper works in integers: 1 unit = 1/SCALE mm (0.1 µm). */
const SCALE = 10000;
/** How far a round join's arc may stray from the true arc, mm. */
const ARC_TOLERANCE = 0.005;

type IntPath = { X: number; Y: number }[];

function toInt(rings: readonly Pt[][]): IntPath[] {
    return rings
        .filter((r) => r.length >= 3)
        .map((r) => r.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) })));
}

function fromInt(paths: IntPath[]): Pt[][] {
    return paths.map((r) => r.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE })));
}

/**
 * The closed outlines as one region, holes by even-odd (a letter's counter, a plate's holes):
 * each outer ring counter-clockwise, each hole clockwise.
 */
export function region(rings: readonly Pt[][]): Pt[][] {
    const c = new ClipperLib.Clipper();
    c.AddPaths(toInt(rings), ClipperLib.PolyType.ptSubject, true);
    const out: IntPath[] = [];
    c.Execute(
        ClipperLib.ClipType.ctUnion,
        out,
        ClipperLib.PolyFillType.pftEvenOdd,
        ClipperLib.PolyFillType.pftEvenOdd,
    );
    return fromInt(out);
}

/**
 * The region grown (`delta` > 0) or shrunk (< 0) by `delta` mm with round corners — the tool
 * centre's path for a cutter of radius |delta| outside / inside it. Empty when nothing is left.
 */
export function offsetRegion(rings: readonly Pt[][], delta: number): Pt[][] {
    if (rings.length === 0) return [];
    if (Math.abs(delta) < 1e-9) return rings.map((r) => [...r]);
    const o = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE * SCALE);
    o.AddPaths(toInt(rings), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    const out: IntPath[] = [];
    o.Execute(out, delta * SCALE);
    return fromInt(out);
}

/** Signed area, mm² (counter-clockwise positive). */
export function ringArea(ring: readonly Pt[]): number {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
        a += (ring[j].x - ring[i].x) * (ring[j].y + ring[i].y);
    return a / 2;
}

export function ringLength(ring: readonly Pt[]): number {
    let l = 0;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        l += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return l;
}

/** The ring turned to run the given way round (climb vs conventional milling). */
export function oriented(ring: Pt[], counterClockwise: boolean): Pt[] {
    return ringArea(ring) > 0 === counterClockwise ? ring : [...ring].reverse();
}
