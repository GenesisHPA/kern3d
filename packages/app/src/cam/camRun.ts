// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Program helpers for the control panel: run from a line, the frame, offsets, the time left. */

function f(v: number): string {
    return String(Math.round(v * 1000) / 1000);
}

/**
 * The spindle's words out of a program: M3 / M4 (on), the S speed word and the coolant / air
 * (M7 / M8) — for a drag knife, which must never have the spindle turn. Comments are left as
 * they are; a line left empty is dropped.
 */
export function withoutSpindle(lines: readonly string[]): string[] {
    const out: string[] = [];
    for (const line of lines) {
        if (line.trim() === "" || /^\s*[(;]/.test(line)) {
            out.push(line);
            continue;
        }
        const stripped = line
            .replace(/\bM0*[3478](?!\d)\s*/gi, "")
            .replace(/\bS\s*-?[\d.]+\s*/gi, "")
            .trim();
        if (stripped !== "") out.push(stripped);
    }
    return out;
}

/** Whether a G-code line (comments aside) would start the spindle: M3 / M4, or sets its speed. */
export function startsSpindle(line: string): boolean {
    const code = line.toUpperCase().replace(/\(.*?\)|;.*/g, "");
    return /(^|[^A-Z])M0*[34](?!\d)/.test(code) || /(^|[^A-Z])S\s*-?[\d.]+/.test(code);
}

/** `$#` replies: `[G54:1.000,2.000,3.000]`, `[G28:…]`, `[TLO:…]`, `[PRB:…:1]`. */
export function parseOffsetLine(line: string): { name: string; values: number[] } | undefined {
    const m = /^\[(G5[4-9]|G28|G30|G92|TLO):([-\d.,]+)/.exec(line.trim());
    if (m === null) return undefined;
    return { name: m[1], values: m[2].split(",").map(Number) };
}

/**
 * Start a program at line `index` (0-based, of comment-free lines): the modal state the lines
 * before it set up (units, distance mode, the work system, the spindle, coolant, the feed) is
 * restored, then the tool goes to where that line starts from — over at the safe height, down
 * at the plunge feed — and the rest follows.
 */
export function runFromLine(
    lines: readonly string[],
    index: number,
    safeZ: number,
    plungeFeed = 200,
): string[] {
    const at = Math.max(0, Math.min(index, lines.length));
    let units = "G21";
    let wcs = "G54";
    let spindle: string | undefined;
    let s: number | undefined;
    let coolant: string | undefined;
    let feed: number | undefined;
    let x: number | undefined;
    let y: number | undefined;
    let z: number | undefined;
    for (let i = 0; i < at; i++) {
        const code = lines[i].toUpperCase().replace(/\(.*?\)|;.*/g, "");
        if (/G20(?!\d)/.test(code)) units = "G20";
        if (/G21(?!\d)/.test(code)) units = "G21";
        const w = /G5[4-9](?!\d)/.exec(code);
        if (w) wcs = w[0];
        const sw = /S(-?[\d.]+)/.exec(code);
        if (sw) s = Number(sw[1]);
        const fw = /F([\d.]+)/.exec(code);
        if (fw) feed = Number(fw[1]);
        if (/M0*3(?!\d)/.test(code)) spindle = "M3";
        if (/M0*4(?!\d)/.test(code)) spindle = "M4";
        if (/M0*5(?!\d)/.test(code)) spindle = undefined;
        if (/M0*7(?!\d)/.test(code)) coolant = "M7";
        if (/M0*8(?!\d)/.test(code)) coolant = "M8";
        if (/M0*9(?!\d)/.test(code)) coolant = undefined;
        if (/G53/.test(code)) continue;
        const xw = /X(-?[\d.]+)/.exec(code);
        const yw = /Y(-?[\d.]+)/.exec(code);
        const zw = /Z(-?[\d.]+)/.exec(code);
        if (xw) x = Number(xw[1]);
        if (yw) y = Number(yw[1]);
        if (zw) z = Number(zw[1]);
    }
    const out = [`${units} G90 ${wcs} G17 G94`, `G0 Z${f(safeZ)}`];
    if (spindle && s !== undefined) out.push(`S${Math.round(s)} ${spindle}`, "G4 P3");
    if (coolant) out.push(coolant);
    if (x !== undefined || y !== undefined)
        out.push(`G0${x !== undefined ? ` X${f(x)}` : ""}${y !== undefined ? ` Y${f(y)}` : ""}`);
    if (z !== undefined && z < safeZ) out.push(`G1 Z${f(z)} F${Math.round(plungeFeed)}`);
    if (feed !== undefined) out.push(`G1 F${Math.round(feed)}`);
    return [...out, ...lines.slice(at)];
}

/** Trace the program's outline at the safe height, the spindle off: where the part will be. */
export function frameLines(
    b: { minX: number; minY: number; maxX: number; maxY: number },
    safeZ: number,
    feed: number,
): string[] {
    if (![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite)) return [];
    const F = Math.round(feed);
    return [
        "G21 G90",
        `G0 Z${f(safeZ)}`,
        `G0 X${f(b.minX)} Y${f(b.minY)}`,
        `G1 X${f(b.maxX)} F${F}`,
        `G1 Y${f(b.maxY)}`,
        `G1 X${f(b.minX)}`,
        `G1 Y${f(b.minY)}`,
    ];
}

/** Does the program, placed at this work offset, stay inside the machine's travel? (GRBL's Z travel is negative.) */
export function outsideTravel(
    b: { minX: number; minY: number; minZ: number; maxX: number; maxY: number },
    wco: [number, number, number] | undefined,
    travel: { x: number; y: number; z: number },
    homedAtMax = true,
): string[] {
    if (!wco) return [];
    const out: string[] = [];
    const check = (axis: string, lo: number, hi: number, len: number) => {
        // homed at the positive end: machine coordinates run from −len to 0
        const [min, max] = homedAtMax ? [-len, 0] : [0, len];
        if (lo < min - 1e-6 || hi > max + 1e-6) out.push(axis);
    };
    check("X", b.minX + wco[0], b.maxX + wco[0], travel.x);
    check("Y", b.minY + wco[1], b.maxY + wco[1], travel.y);
    check("Z", b.minZ + wco[2], wco[2], travel.z);
    return out;
}

/** Time left: what is still to run, scaled by how fast the part so far actually went. */
export function timeLeft(estimate: number, done: number, total: number, elapsed: number): number | undefined {
    if (total <= 0 || done <= 0 || estimate <= 0) return undefined;
    const fraction = done / total;
    const pace = elapsed / Math.max(1e-6, estimate * fraction);
    return Math.max(0, estimate * (1 - fraction) * pace);
}

export function clock(seconds: number): string {
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The probe ball's true diameter from a ring gauge: what it should read over what it read. */
export function calibratedTip(tip: number, ringTrue: number, ringMeasured: number): number {
    return Math.max(0, Math.round((tip + (ringTrue - ringMeasured)) * 1000) / 1000);
}
