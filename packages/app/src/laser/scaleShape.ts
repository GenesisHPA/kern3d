// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { FontOutline } from "@chili3d/core";
import type { LaserPath } from "./geometry";
import type { LaserFontRef } from "./shapes";

/**
 * A graduated scale to engrave: ticks across it every `step` of value along its length, longer
 * every `midEvery` and `majorEvery` ticks, figures beside the long ones. On a rotary job it runs
 * round the part — its length the circumference, 0…360° — a dial ring; on a flat job a ruler.
 *
 * Its own frame: the scale runs along Y from 0 to `span`, the ticks go out along +X (or −X when
 * `flip`), the figures beyond them.
 */
export interface ScaleSpec {
    /** Length of the scale, mm (on a rotary job: π·D for a whole turn). */
    span: number;
    /** Values at its two ends, and the value between two ticks. */
    from: number;
    to: number;
    step: number;
    /** A long tick every this many ticks, a middle one every `midEvery` (0 = none). */
    majorEvery: number;
    midEvery: number;
    /**
     * Thickness of the ticks and the baseline, mm: 0 is one pass of the beam; thicker lines are
     * that many passes side by side, `linePitch` apart (the figures stay single strokes).
     */
    lineWidth: number;
    linePitch: number;
    /** Tick lengths, mm. */
    minorLength: number;
    midLength: number;
    majorLength: number;
    /** Figures beside every `labelEvery`-th long tick. */
    labels: boolean;
    labelEvery: number;
    labelSize: number;
    /** Between a long tick's end and its figure, mm. */
    labelGap: number;
    /** Written after the number ("°", " мм", …). */
    suffix: string;
    decimals: number;
    /** The figures turned to read along the scale rather than across it. */
    labelsAlong: boolean;
    /** Ticks out to −X (the other side of the line). */
    flip: boolean;
    /** Values grow the other way along the scale. */
    reverse: boolean;
    /** A line along the scale where the ticks start. */
    baseline: boolean;
    /** The last tick left out when it falls on the first one round the part (0° = 360°). */
    skipLast: boolean;
    /** Single-line (engraving) font for the figures. */
    font: LaserFontRef;
}

/** The most ticks a scale makes: past it the step is too fine to engrave anyway. */
const MAX_TICKS = 3600;

export function defaultScale(span: number, rotary: boolean, font: LaserFontRef): ScaleSpec {
    return rotary
        ? {
              span,
              from: 0,
              to: 360,
              step: 5,
              majorEvery: 2,
              midEvery: 0,
              lineWidth: 0,
              linePitch: 0.05,
              minorLength: 1.5,
              midLength: 2.2,
              majorLength: 3,
              labels: true,
              labelEvery: 3,
              labelSize: 2,
              labelGap: 0.8,
              suffix: "°",
              decimals: 0,
              labelsAlong: false,
              flip: false,
              reverse: false,
              baseline: false,
              skipLast: true,
              font,
          }
        : {
              span,
              from: 0,
              to: span,
              step: 1,
              majorEvery: 10,
              midEvery: 5,
              lineWidth: 0,
              linePitch: 0.05,
              minorLength: 2,
              midLength: 3,
              majorLength: 4.5,
              labels: true,
              labelEvery: 1,
              labelSize: 2.5,
              labelGap: 0.8,
              suffix: "",
              decimals: 0,
              labelsAlong: false,
              flip: false,
              reverse: false,
              baseline: true,
              skipLast: false,
              font,
          };
}

/**
 * A straight stroke from `a` to `b` as thick as `width`: passes side by side across it,
 * `pitch` apart (one pass when the width is under the pitch), alternating direction.
 */
function thickStroke(
    a: { x: number; y: number },
    b: { x: number; y: number },
    width: number,
    pitch: number,
): LaserPath[] {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(width > 0) || len === 0) return [{ closed: false, points: [a, b] }];
    const step = Math.max(0.005, pitch);
    const passes = Math.max(1, Math.round(width / step) + 1);
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const out: LaserPath[] = [];
    for (let i = 0; i < passes; i++) {
        const off = passes === 1 ? 0 : -width / 2 + (width * i) / (passes - 1);
        const p = { x: a.x + nx * off, y: a.y + ny * off };
        const q = { x: b.x + nx * off, y: b.y + ny * off };
        out.push({ closed: false, points: i % 2 === 0 ? [p, q] : [q, p] });
    }
    return out;
}

/** The value written at a tick. */
export function scaleLabel(value: number, spec: Pick<ScaleSpec, "decimals" | "suffix">): string {
    const d = Math.max(0, Math.min(6, Math.round(spec.decimals)));
    const text = value.toFixed(d).replace("-", "−");
    return `${text}${spec.suffix}`;
}

/** Ticks of a scale: position along it (mm), value, kind. */
export function scaleTicks(spec: ScaleSpec): { y: number; value: number; kind: "minor" | "mid" | "major" }[] {
    const range = spec.to - spec.from;
    if (!(Math.abs(range) > 0) || !(spec.step > 0) || !(spec.span > 0)) return [];
    const count = Math.min(MAX_TICKS, Math.floor(Math.abs(range) / spec.step + 1e-9));
    const sign = Math.sign(range);
    const out: { y: number; value: number; kind: "minor" | "mid" | "major" }[] = [];
    for (let i = 0; i <= count; i++) {
        if (spec.skipLast && i === count && Math.abs(count * spec.step - Math.abs(range)) < 1e-9 && i > 0)
            break;
        const value = spec.from + sign * i * spec.step;
        const share = (i * spec.step) / Math.abs(range);
        const y = (spec.reverse ? 1 - share : share) * spec.span;
        const major = spec.majorEvery > 0 && i % Math.round(spec.majorEvery) === 0;
        const mid = !major && spec.midEvery > 0 && i % Math.round(spec.midEvery) === 0;
        out.push({ y, value, kind: major ? "major" : mid ? "mid" : "minor" });
    }
    return out;
}

/**
 * The scale's outlines in its own frame: open strokes for the ticks (and the baseline), the
 * figures from `textLine` (a line of text in the scale's font, its box from 0, 0, height = size).
 */
export function scalePaths(
    spec: ScaleSpec,
    font: FontOutline | undefined,
    textLine: (text: string, size: number, font: FontOutline) => LaserPath[],
): LaserPath[] {
    const dir = spec.flip ? -1 : 1;
    const paths: LaserPath[] = [];
    if (spec.baseline)
        paths.push(...thickStroke({ x: 0, y: 0 }, { x: 0, y: spec.span }, spec.lineWidth, spec.linePitch));
    const ticks = scaleTicks(spec);
    let majors = 0;
    for (const tick of ticks) {
        const len =
            tick.kind === "major"
                ? spec.majorLength
                : tick.kind === "mid"
                  ? spec.midLength
                  : spec.minorLength;
        paths.push(
            ...thickStroke({ x: 0, y: tick.y }, { x: dir * len, y: tick.y }, spec.lineWidth, spec.linePitch),
        );
        if (tick.kind !== "major") continue;
        const labelled =
            spec.labels && font !== undefined && majors % Math.max(1, Math.round(spec.labelEvery)) === 0;
        majors++;
        if (!labelled) continue;
        const text = textLine(scaleLabel(tick.value, spec), spec.labelSize, font);
        if (text.length === 0) continue;
        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const p of text)
            for (const q of p.points) {
                minX = Math.min(minX, q.x);
                maxX = Math.max(maxX, q.x);
                minY = Math.min(minY, q.y);
                maxY = Math.max(maxY, q.y);
            }
        const w = maxX - minX;
        const h = maxY - minY;
        const edge = dir * (spec.majorLength + spec.labelGap);
        for (const p of text) {
            paths.push({
                closed: p.closed,
                points: p.points.map((q) => {
                    if (spec.labelsAlong) {
                        // turned a quarter: reads along the scale, centred on the tick
                        const u = q.x - minX - w / 2;
                        const v = q.y - minY;
                        return { x: edge + dir * v + (dir < 0 ? -0 : 0), y: tick.y - dir * u };
                    }
                    // across: left of the figure at the tick's end (right of it when flipped)
                    const x = dir > 0 ? edge + (q.x - minX) : edge - (maxX - q.x);
                    return { x, y: tick.y + (q.y - minY) - h / 2 };
                }),
            });
        }
    }
    return paths;
}
