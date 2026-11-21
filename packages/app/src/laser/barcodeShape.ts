// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { FontOutline } from "@chili3d/core";
import {
    code128Widths,
    ean13Modules,
    encodeDataMatrix,
    encodeQr,
    type Matrix,
    type QrLevel,
} from "./barcodes";
import type { LaserPath } from "./geometry";

/**
 * A barcode as a laser figure: its dark modules as filled rectangles (the runs of a row merged,
 * so a QR is a few hundred rectangles, not thousands), the quiet zone part of the object's box,
 * and for a dark surface (anodised aluminium marks light) «Инверсия»: the background burnt and
 * the modules left. A 1D code can carry its digits underneath, as EzCAD prints them.
 */

export const BARCODE_FORMATS = ["qr", "datamatrix", "code128", "ean13"] as const;
export type BarcodeFormat = (typeof BARCODE_FORMATS)[number];

export interface BarcodeSpec {
    format: BarcodeFormat;
    data: string;
    /** QR error correction. */
    level: QrLevel;
    /** One module, mm. */
    module: number;
    /** Blank margin round the code, modules. */
    quiet: number;
    /** 1D: bar height, mm. */
    barHeight: number;
    /** 1D: the digits under the bars. */
    showText: boolean;
    invert: boolean;
}

export interface BarcodeGeometry {
    paths: LaserPath[];
    width: number;
    height: number;
    /** The data cannot be encoded in this format (why, as an i18n key). */
    error?: string;
}

type TextMaker = (text: string, size: number, font: FontOutline) => LaserPath[];

function rect(x: number, y: number, w: number, h: number): LaserPath {
    return {
        closed: true,
        points: [
            { x, y },
            { x: x + w, y },
            { x: x + w, y: y + h },
            { x, y: y + h },
        ],
    };
}

/** Rows of the matrix (row 0 on top) as merged runs, the matrix's top-left at (x0, top). */
function matrixRects(m: Matrix, module: number, x0: number, top: number): LaserPath[] {
    const out: LaserPath[] = [];
    for (let row = 0; row < m.length; row++) {
        const y = top - (row + 1) * module;
        let start = -1;
        for (let col = 0; col <= m[row].length; col++) {
            const dark = col < m[row].length && m[row][col];
            if (dark && start < 0) start = col;
            if (!dark && start >= 0) {
                out.push(rect(x0 + start * module, y, (col - start) * module, module));
                start = -1;
            }
        }
    }
    return out;
}

/** Bars of a 1D code from its module string ("1" dark), each bar `height` tall from `y`. */
function barRects(modules: string, module: number, x0: number, y: number, height: (i: number) => number) {
    const out: LaserPath[] = [];
    let start = -1;
    for (let i = 0; i <= modules.length; i++) {
        const dark = modules[i] === "1";
        if (dark && start < 0) start = i;
        if (!dark && start >= 0) {
            const h = height(start);
            out.push(rect(x0 + start * module, y + (height(0) - h), (i - start) * module, h));
            start = -1;
        }
    }
    return out;
}

function widthsToModules(widths: number[]): string {
    let s = "";
    widths.forEach((w, i) => {
        s += (i % 2 === 0 ? "1" : "0").repeat(w);
    });
    return s;
}

/** A line of digits, its middle at x, its baseline at y. */
function caption(text: string, x: number, y: number, size: number, font: FontOutline, make: TextMaker) {
    const paths = make(text, size, font);
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    for (const p of paths)
        for (const q of p.points) {
            minX = Math.min(minX, q.x);
            maxX = Math.max(maxX, q.x);
        }
    if (!Number.isFinite(minX)) return [];
    const dx = x - (minX + maxX) / 2;
    return paths.map((p) => ({
        closed: p.closed,
        points: p.points.map((q) => ({ x: q.x + dx, y: q.y + y })),
    }));
}

export function barcodeGeometry(
    spec: BarcodeSpec,
    font: FontOutline | undefined,
    make: TextMaker,
): BarcodeGeometry {
    const m = Math.max(spec.module, 0.01);
    const q = Math.max(0, spec.quiet) * m;
    let paths: LaserPath[] = [];
    let width = 0;
    let height = 0;
    if (spec.format === "qr" || spec.format === "datamatrix") {
        const matrix =
            spec.format === "qr"
                ? encodeQr(spec.data, spec.level)?.modules
                : encodeDataMatrix(spec.data)?.modules;
        if (matrix === undefined || spec.data === "")
            return { paths: [], width: m, height: m, error: "laser.barcode.tooLong" };
        const n = matrix.length;
        width = height = n * m + 2 * q;
        paths = matrixRects(matrix, m, q, q + n * m);
    } else {
        let modules: string;
        let digits: string;
        if (spec.format === "ean13") {
            const r = ean13Modules(spec.data.trim());
            if (r === undefined) return { paths: [], width: m, height: m, error: "laser.barcode.ean13" };
            modules = r.modules;
            digits = r.digits;
        } else {
            const w = code128Widths(spec.data);
            if (w === undefined) return { paths: [], width: m, height: m, error: "laser.barcode.code128" };
            modules = widthsToModules(w);
            digits = spec.data;
        }
        const bars = Math.max(spec.barHeight, m);
        const textSize = Math.max(1, m * 9);
        const showText = spec.showText && font !== undefined;
        const below = showText ? textSize * 1.1 : 0;
        // EAN's guard bars run down between the digit groups
        const guard = (i: number) => (i < 3 || (i >= 45 && i < 50) || i >= 92 ? 1 : 0);
        const ean = spec.format === "ean13";
        const extra = ean && showText ? textSize * 0.55 : 0;
        const bottom = q + below - extra;
        width = modules.length * m + 2 * q;
        height = bars + below + 2 * q;
        paths = barRects(modules, m, q, bottom, (i) => (ean && guard(i) ? bars + extra : bars));
        if (showText && font !== undefined) {
            const baseline = q + below - textSize * 0.95;
            if (ean) {
                paths.push(
                    ...caption(digits[0], q - 4 * m, baseline, textSize, font, make),
                    ...caption(digits.slice(1, 7), q + 24 * m, baseline, textSize, font, make),
                    ...caption(digits.slice(7), q + 71 * m, baseline, textSize, font, make),
                );
            } else paths.push(...caption(digits, width / 2, baseline, textSize, font, make));
        }
    }
    if (spec.invert) paths.unshift(rect(0, 0, width, height));
    return { paths, width, height };
}
