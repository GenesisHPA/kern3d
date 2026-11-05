// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { DrawingData, DrawingViewData, Point2 } from "./drawingData";
import { viewBasisOf } from "./drawingViews";
import { toSheet, type ViewPlacement } from "./placement";
import { type DrawingPrimitive, LINE_WIDTH, line, text } from "./primitives";
import { dot } from "./viewBasis";

/** ГОСТ 2.306: 45° lines, 1–10 mm apart by the size of the area; one spacing for a part. */
export const HATCH_SPACING = 2.5;
const STROKE_GAP = 2;
const STROKE_LENGTH = 9;
const ARROW_SHAFT = 6;

/**
 * The hatching of a section's cut faces: every 45° line of the family crossing a triangle
 * gives one interval, and the intervals of one line are merged — triangles share their edges,
 * so a line runs unbroken across the face and stops exactly at its outline.
 */
export function hatch(placement: ViewPlacement, spacing = HATCH_SPACING): DrawingPrimitive[] {
    const cut = placement.geometry?.cut ?? [];
    if (cut.length === 0) return [];
    const owner = `view:${placement.view.id}`;
    const r = Math.SQRT1_2;
    // n = (1, -1)/√2 picks the line, t = (1, 1)/√2 runs along it
    const lines = new Map<number, [number, number][]>();
    for (let k = 0; k + 5 < cut.length; k += 6) {
        const p = [0, 1, 2].map((j) => toSheet(placement, cut[k + 2 * j], cut[k + 2 * j + 1]));
        const n = p.map(([x, y]) => (x - y) * r);
        const t = p.map(([x, y]) => (x + y) * r);
        const lo = Math.ceil(Math.min(...n) / spacing);
        const hi = Math.floor(Math.max(...n) / spacing);
        for (let i = lo; i <= hi; i++) {
            const level = i * spacing;
            const hits: number[] = [];
            for (let a = 0; a < 3; a++) {
                const b = (a + 1) % 3;
                const da = n[a] - level;
                const db = n[b] - level;
                if (da === db) continue;
                if ((da <= 0 && db >= 0) || (da >= 0 && db <= 0)) {
                    const s = da / (da - db);
                    hits.push(t[a] + (t[b] - t[a]) * s);
                }
            }
            if (hits.length < 2) continue;
            const t0 = Math.min(...hits);
            const t1 = Math.max(...hits);
            if (t1 - t0 < 1e-9) continue;
            let list = lines.get(i);
            if (list === undefined) {
                list = [];
                lines.set(i, list);
            }
            list.push([t0, t1]);
        }
    }
    const result: DrawingPrimitive[] = [];
    for (const [i, intervals] of lines) {
        intervals.sort((a, b) => a[0] - b[0]);
        const merged: [number, number][] = [];
        for (const iv of intervals) {
            const last = merged[merged.length - 1];
            if (last !== undefined && iv[0] <= last[1] + 1e-4) last[1] = Math.max(last[1], iv[1]);
            else merged.push([...iv]);
        }
        const level = i * spacing;
        for (const [t0, t1] of merged) {
            if (t1 - t0 < 0.2) continue;
            const at = (t: number): Point2 => [(level + t) * r, (t - level) * r];
            result.push(line("visible", [...at(t0), ...at(t1)], LINE_WIDTH.thin, owner));
        }
    }
    return result;
}

/**
 * The view a section's plane is marked on: one seeing the plane edge-on, the section's parent
 * or a view projected from it first.
 */
export function cutTraceHost(data: DrawingData, section: DrawingViewData): DrawingViewData | undefined {
    const ws = viewBasisOf(section).w;
    const candidates = data.views.filter(
        (v) => v.id !== section.id && v.orientation !== "iso" && Math.abs(dot(viewBasisOf(v).w, ws)) < 1e-6,
    );
    return candidates.find((v) => v.id === section.parentId || v.parentId === section.id) ?? candidates[0];
}

/** The plane's trace on the host, in its 2D frame: a·x + b·y = offset. */
export function traceOn(
    host: DrawingViewData,
    section: DrawingViewData,
): { a: number; b: number; offset: number } {
    const ws = viewBasisOf(section).w;
    const basis = viewBasisOf(host);
    return { a: dot(ws, basis.u), b: dot(ws, basis.v), offset: section.section?.offset ?? 0 };
}

/** The section's letters: "А–А" over the view. */
export function sectionTitle(name: string): string {
    return `${name}–${name}`;
}

/**
 * Where each section's plane runs, marked on one other view that sees it edge-on (its parent
 * or a view projected from it first): two open strokes just outside the contour, arrows from
 * them in the direction the section is looked at, and the section's letter by each arrow.
 */
export function cuttingPlaneMarks(
    data: DrawingData,
    placements: ReadonlyMap<string, ViewPlacement>,
): DrawingPrimitive[] {
    const result: DrawingPrimitive[] = [];
    for (const section of data.views) {
        if (section.section === undefined || section.section.unlabeled) continue;
        const ws = viewBasisOf(section).w;
        const host = cutTraceHost(data, section);
        const placement = host === undefined ? undefined : placements.get(host.id);
        const g = placement?.geometry;
        if (placement === undefined || g === undefined || !Number.isFinite(g.bounds.minX)) continue;
        const basis = viewBasisOf(placement.view);
        // the plane in the host's 2D frame: a·x + b·y = offset
        const a = dot(ws, basis.u);
        const b = dot(ws, basis.v);
        const along: Point2 = [-b, a];
        const corners: Point2[] = [
            [g.bounds.minX, g.bounds.minY],
            [g.bounds.maxX, g.bounds.minY],
            [g.bounds.minX, g.bounds.maxY],
            [g.bounds.maxX, g.bounds.maxY],
        ];
        const ts = corners.map(([x, y]) => x * along[0] + y * along[1]);
        const base: Point2 = [a * section.section.offset, b * section.section.offset];
        const end = (t: number) => toSheet(placement, base[0] + along[0] * t, base[1] + along[1] * t);
        const e1 = end(Math.min(...ts));
        const e2 = end(Math.max(...ts));
        const length = Math.hypot(e2[0] - e1[0], e2[1] - e1[1]);
        if (length === 0) continue;
        const d: Point2 = [(e2[0] - e1[0]) / length, (e2[1] - e1[1]) / length];
        // looking along -w of the section, as seen on the host's sheet
        const look: Point2 = [-a, -b];
        const owner = `view:${host!.id}`;
        for (const [e, sign] of [
            [e1, -1],
            [e2, 1],
        ] as [Point2, number][]) {
            const from: Point2 = [e[0] + sign * d[0] * STROKE_GAP, e[1] + sign * d[1] * STROKE_GAP];
            const to: Point2 = [from[0] + sign * d[0] * STROKE_LENGTH, from[1] + sign * d[1] * STROKE_LENGTH];
            result.push(line("visible", [...from, ...to], LINE_WIDTH.thick * 1.5, owner));
            // the arrow stands on the stroke 2.5 mm from its outer end
            const foot: Point2 = [to[0] - sign * d[0] * 2.5, to[1] - sign * d[1] * 2.5];
            const tip: Point2 = [foot[0] + look[0] * ARROW_SHAFT, foot[1] + look[1] * ARROW_SHAFT];
            result.push(line("dimension", [...foot, ...tip], LINE_WIDTH.thin, owner));
            const nx = -look[1] * 0.8;
            const ny = look[0] * 0.8;
            const bx = tip[0] - look[0] * 3.5;
            const by = tip[1] - look[1] * 3.5;
            result.push({
                kind: "fill",
                layer: "dimension",
                points: [...tip, bx + nx, by + ny, bx - nx, by - ny],
                owner,
            });
            const lx = tip[0] + sign * d[0] * 3.5;
            const ly = tip[1] + sign * d[1] * 3.5 - 2.5;
            result.push(text("text", lx, ly, section.section.name, 5, "middle", 0, owner));
        }
    }
    return result;
}
