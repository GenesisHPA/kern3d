// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ProbeIO, ProbeSettings } from "./camProbe";

/**
 * A height map of the stock's top (bCNC / CNCjs autolevel): probed on a grid, then every
 * cutting move of the program cut into short pieces and lifted or lowered by the surface
 * height under it, so engraving a warped board or a bent sheet keeps its depth.
 */
export interface HeightMap {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    nx: number;
    ny: number;
    /** Heights relative to the first point, row by row (y), nx per row. */
    z: number[];
}

function f(v: number): string {
    return String(Math.round(v * 1000) / 1000);
}

export function gridPoints(
    b: { minX: number; minY: number; maxX: number; maxY: number },
    nx: number,
    ny: number,
) {
    const out: { x: number; y: number }[] = [];
    const cx = Math.max(2, Math.round(nx));
    const cy = Math.max(2, Math.round(ny));
    for (let j = 0; j < cy; j++) {
        // a snake: each row the other way, less travel
        const row: { x: number; y: number }[] = [];
        for (let i = 0; i < cx; i++)
            row.push({
                x: b.minX + ((b.maxX - b.minX) * i) / (cx - 1),
                y: b.minY + ((b.maxY - b.minY) * j) / (cy - 1),
            });
        out.push(...(j % 2 === 0 ? row : row.reverse()));
    }
    return out;
}

/** The surface height at (x, y): bilinear inside the grid, the edge value outside. */
export function heightAt(m: HeightMap, x: number, y: number): number {
    const fx = m.maxX > m.minX ? ((x - m.minX) / (m.maxX - m.minX)) * (m.nx - 1) : 0;
    const fy = m.maxY > m.minY ? ((y - m.minY) / (m.maxY - m.minY)) * (m.ny - 1) : 0;
    const cx = Math.max(0, Math.min(m.nx - 1, fx));
    const cy = Math.max(0, Math.min(m.ny - 1, fy));
    const i = Math.min(m.nx - 2, Math.floor(cx));
    const j = Math.min(m.ny - 2, Math.floor(cy));
    const u = cx - i;
    const v = cy - j;
    const z = (a: number, b: number) => m.z[b * m.nx + a];
    return (
        z(i, j) * (1 - u) * (1 - v) +
        z(i + 1, j) * u * (1 - v) +
        z(i, j + 1) * (1 - u) * v +
        z(i + 1, j + 1) * u * v
    );
}

/** Probe the grid: up by `clearance` between points, the heights relative to the first touch. */
export async function probeHeightMap(
    io: ProbeIO,
    s: ProbeSettings,
    b: { minX: number; minY: number; maxX: number; maxY: number },
    nx: number,
    ny: number,
    clearance: number,
    onPoint?: (done: number, total: number) => void,
): Promise<HeightMap> {
    const cx = Math.max(2, Math.round(nx));
    const cy = Math.max(2, Math.round(ny));
    const pts = gridPoints(b, cx, cy);
    const z = new Array<number>(cx * cy).fill(0);
    let first: number | undefined;
    await io.send(["G21 G90", `G0 Z${f(clearance)}`]);
    for (let k = 0; k < pts.length; k++) {
        const p = pts[k];
        await io.send([`G0 X${f(p.x)} Y${f(p.y)}`]);
        await io.send(["G91"]);
        await io.probe(`G38.2 Z-${f(clearance + s.travel)} F${Math.round(s.seekFeed)}`);
        await io.send([`G0 Z${f(s.retract)}`]);
        const slow = await io.probe(`G38.2 Z-${f(s.retract + 1)} F${Math.round(s.latchFeed)}`);
        await io.send(["G90", `G0 Z${f(clearance)}`]);
        first ??= slow[2];
        // where this point sits in the grid (the snake order undone)
        const j = Math.floor(k / cx);
        const i = j % 2 === 0 ? k % cx : cx - 1 - (k % cx);
        z[j * cx + i] = Math.round((slow[2] - first) * 1000) / 1000;
        onPoint?.(k + 1, pts.length);
    }
    return { ...b, nx: cx, ny: cy, z };
}

/**
 * The program over the map: G0 / G1 moves in absolute mm cut into pieces no longer than
 * `step` (feeds only; rapids above the surface just get the offset at their end) and Z
 * shifted by the height under each piece's end. Arcs (G2 / G3) are passed through.
 */
export function levelProgram(lines: readonly string[], m: HeightMap, step = 2): string[] {
    const out: string[] = [];
    let x = 0;
    let y = 0;
    let z = 0;
    let absolute = true;
    let motion = "G0";
    for (const raw of lines) {
        const code = raw.toUpperCase();
        if (/G91(?!\.)/.test(code)) absolute = false;
        if (/G90(?!\.)/.test(code)) absolute = true;
        const g = /G0*([0-3])(?![\d.])/.exec(code);
        if (g) motion = `G${g[1]}`;
        const xw = /X(-?[\d.]+)/.exec(code);
        const yw = /Y(-?[\d.]+)/.exec(code);
        const zw = /Z(-?[\d.]+)/.exec(code);
        const special = /G53|G38|G10|G28|G30|G92|\$/.test(code);
        if (!absolute || special || !(xw || yw || zw) || motion === "G2" || motion === "G3") {
            out.push(raw);
            if (absolute && !special) {
                if (xw) x = Number(xw[1]);
                if (yw) y = Number(yw[1]);
                if (zw) z = Number(zw[1]);
            }
            continue;
        }
        const nx = xw ? Number(xw[1]) : x;
        const ny = yw ? Number(yw[1]) : y;
        const nz = zw ? Number(zw[1]) : z;
        // the line's other words (feed, spindle…) kept on the first piece
        const rest = raw
            .replace(/G0*[0-3](?![\d.])/i, "")
            .replace(/[XYZ]-?[\d.]+/gi, "")
            .trim();
        const len = Math.hypot(nx - x, ny - y);
        const pieces = motion === "G1" ? Math.max(1, Math.ceil(len / step)) : 1;
        for (let k = 1; k <= pieces; k++) {
            const t = k / pieces;
            const px = x + (nx - x) * t;
            const py = y + (ny - y) * t;
            const pz = z + (nz - z) * t + heightAt(m, px, py);
            out.push(`${motion} X${f(px)} Y${f(py)} Z${f(pz)}${k === 1 && rest ? ` ${rest}` : ""}`);
        }
        x = nx;
        y = ny;
        z = nz;
    }
    return out;
}
