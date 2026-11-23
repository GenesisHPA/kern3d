// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { burnPolylines } from "./jczProgram";
import type { LaserJobData } from "./laserData";
import type { GrayImage } from "./raster";
import { jobYRange, mmPerDegree, type RotaryJob } from "./rotary";
import type { Rotary3DSource, SurfaceLine } from "./rotary3d";

/**
 * The job on the part's surface for the 3D view: each object's burn lines (as the board marks
 * them, in order, pass by pass) with Y turned into the place round the part — "strips": the
 * job's Y from its lowest point; "index": the object's angle plus its offset from the field's
 * centre line (`centerY`).
 */
export function rotary3dSource(
    job: LaserJobData,
    rotary: RotaryJob,
    images: ReadonlyMap<string, GrayImage>,
    centerY: number,
): Rotary3DSource | undefined {
    const range = jobYRange(job);
    if (range === undefined) return undefined;
    const perDegree = mmPerDegree(rotary.diameter);
    const lines: SurfaceLine[] = [];
    let xMin = Number.POSITIVE_INFINITY;
    let xMax = Number.NEGATIVE_INFINITY;
    for (const o of job.objects) {
        if (o.hidden) continue;
        const image = o.kind === "image" ? images.get(o.id) : undefined;
        if (o.kind === "image" && image === undefined) continue;
        const speed = Math.max(1e-6, o.op.speed / 60);
        const shift = rotary.mode === "index" ? (o.rotaryAngle ?? 0) * perDegree - centerY : -range[0];
        const own = burnPolylines(o, image).filter((l) => l.length > 1);
        for (let pass = 0; pass < Math.max(1, o.op.passes); pass++) {
            for (const l of own) {
                let length = 0;
                const points = l.map((p, i) => {
                    if (i > 0) length += Math.hypot(p.x - l[i - 1].x, p.y - l[i - 1].y);
                    xMin = Math.min(xMin, p.x);
                    xMax = Math.max(xMax, p.x);
                    return { x: p.x, y: p.y + shift };
                });
                lines.push({ points, seconds: length / speed });
            }
        }
    }
    if (lines.length === 0) return undefined;
    const margin = Math.max(2, (xMax - xMin) * 0.08);
    return { diameter: rotary.diameter, xMin: xMin - margin, xMax: xMax + margin, lines };
}
