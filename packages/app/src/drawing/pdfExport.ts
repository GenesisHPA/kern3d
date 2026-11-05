// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type FontOutline, layoutLine, type Vec2 } from "@chili3d/core";
import type { ArcPrimitive, ComposedSheet, DrawingPrimitive, TextPrimitive } from "./primitives";
import { CAP_TO_EM } from "./svgExport";

/**
 * A one-page vector PDF of the sheet at true size (the page is the paper format, in points;
 * the content is drawn in millimetres under a 72/25.4 scale), written by hand — lines, arcs as
 * Béziers and fills need nothing a library would add.
 *
 * Text is drawn as filled glyph outlines from `font` when one is given, so any script —
 * Cyrillic included — prints without embedding a font program. Without a font it falls back to
 * the built-in Helvetica, which only has Latin: other characters print as "?".
 */

const MM_TO_PT = 72 / 25.4;

function n(value: number): string {
    return Number.parseFloat(value.toFixed(3)).toString();
}

function strokeState(width: number, dash: number[] | undefined): string {
    const pattern = dash === undefined ? "[] 0 d" : `[${dash.map(n).join(" ")}] 0 d`;
    return `${n(width)} w ${pattern}`;
}

function pathOf(points: number[], closed: boolean): string {
    const ops: string[] = [];
    for (let k = 0; k + 1 < points.length; k += 2) {
        ops.push(`${n(points[k])} ${n(points[k + 1])} ${k === 0 ? "m" : "l"}`);
    }
    if (closed) ops.push("h");
    return ops.join(" ");
}

/** An arc as cubic Béziers of at most 90° each. */
export function arcPath(p: Pick<ArcPrimitive, "cx" | "cy" | "r" | "start" | "sweep">): string {
    const segments = Math.max(1, Math.ceil(Math.abs(p.sweep) / (Math.PI / 2) - 1e-9));
    const step = p.sweep / segments;
    const k = (4 / 3) * Math.tan(step / 4);
    const at = (a: number) => [p.cx + p.r * Math.cos(a), p.cy + p.r * Math.sin(a)];
    const [x0, y0] = at(p.start);
    const ops = [`${n(x0)} ${n(y0)} m`];
    for (let i = 0; i < segments; i++) {
        const a0 = p.start + step * i;
        const a1 = a0 + step;
        const [sx, sy] = at(a0);
        const [ex, ey] = at(a1);
        const c1x = sx - k * p.r * Math.sin(a0);
        const c1y = sy + k * p.r * Math.cos(a0);
        const c2x = ex + k * p.r * Math.sin(a1);
        const c2y = ey - k * p.r * Math.cos(a1);
        ops.push(`${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(ex)} ${n(ey)} c`);
    }
    return ops.join(" ");
}

function glyphText(p: TextPrimitive, font: FontOutline): string {
    const layout = layoutLine(font, p.text, p.height * CAP_TO_EM);
    const shift = p.anchor === "start" ? 0 : p.anchor === "middle" ? -layout.width / 2 : -layout.width;
    const rad = (p.angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const ops: string[] = [];
    for (const placed of layout.glyphs) {
        if (placed.glyph === undefined) continue;
        const ox = shift + placed.offset;
        const map = (v: Vec2) => {
            const x = ox + v.x * layout.scale;
            const y = v.y * layout.scale;
            return `${n(p.x + x * cos - y * sin)} ${n(p.y + x * sin + y * cos)}`;
        };
        for (const contour of placed.glyph.contours) {
            ops.push(`${map(contour.start)} m`);
            let last = contour.start;
            for (const s of contour.segments) {
                if (s.kind === "line") ops.push(`${map(s.to)} l`);
                else if (s.kind === "cubic") ops.push(`${map(s.c1)} ${map(s.c2)} ${map(s.to)} c`);
                else {
                    // a quadratic is the cubic with its control point pulled 2/3 of the way in
                    const c1 = {
                        x: last.x + (2 / 3) * (s.c1.x - last.x),
                        y: last.y + (2 / 3) * (s.c1.y - last.y),
                    };
                    const c2 = {
                        x: s.to.x + (2 / 3) * (s.c1.x - s.to.x),
                        y: s.to.y + (2 / 3) * (s.c1.y - s.to.y),
                    };
                    ops.push(`${map(c1)} ${map(c2)} ${map(s.to)} c`);
                }
                last = s.to;
            }
            ops.push("h");
        }
    }
    return ops.length === 0 ? "" : `${ops.join(" ")} f`;
}

export function pdfString(value: string): string {
    let result = "";
    for (const ch of value) {
        const code = ch.codePointAt(0)!;
        if (ch === "(" || ch === ")" || ch === "\\") result += `\\${ch}`;
        else if (code >= 32 && code < 127) result += ch;
        else if (ch === "Ø") result += "\\330";
        else if (ch === "°") result += "\\260";
        else result += "?";
    }
    return result;
}

function helveticaText(p: TextPrimitive): string {
    const size = p.height * CAP_TO_EM;
    // Helvetica's advance averages ~0.55 em; good enough to centre a label
    const width = [...p.text].length * size * 0.55;
    const shift = p.anchor === "start" ? 0 : p.anchor === "middle" ? -width / 2 : -width;
    const rad = (p.angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const x = p.x + shift * cos;
    const y = p.y + shift * sin;
    return `BT /F1 ${n(size)} Tf ${n(cos)} ${n(sin)} ${n(-sin)} ${n(cos)} ${n(x)} ${n(y)} Tm (${pdfString(p.text)}) Tj ET`;
}

function primitiveOps(p: DrawingPrimitive, font: FontOutline | undefined): string {
    switch (p.kind) {
        case "polyline":
            return `${strokeState(p.width, p.dash)} ${pathOf(p.points, p.closed === true)} S`;
        case "arc":
            return `${strokeState(p.width, p.dash)} ${arcPath(p)} S`;
        case "fill":
            return `${pathOf(p.points, true)} f`;
        case "text":
            return font === undefined ? helveticaText(p) : glyphText(p, font);
    }
}

export function pdfContent(sheet: ComposedSheet, font: FontOutline | undefined): string {
    const ops = [`${n(MM_TO_PT)} 0 0 ${n(MM_TO_PT)} 0 0 cm`, "1 J 1 j 0 G 0 g"];
    for (const p of sheet.primitives) {
        const op = primitiveOps(p, font);
        if (op) ops.push(op);
    }
    return ops.join("\n");
}

/** The complete PDF file. Everything in it is ASCII, so string length is byte length. */
export function sheetToPdf(sheets: ComposedSheet | ComposedSheet[], font?: FontOutline): Uint8Array {
    const pages = Array.isArray(sheets) ? sheets : [sheets];
    // 1 catalog, 2 pages, 3 font, 4 info, then a page object and its content per sheet
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        `<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + 2 * i} 0 R`).join(" ")}] /Count ${pages.length} >>`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        "<< /Producer (Kern3D) /Title (Drawing) >>",
    ];
    pages.forEach((sheet, i) => {
        const content = pdfContent(sheet, font);
        const width = n(sheet.width * MM_TO_PT);
        const height = n(sheet.height * MM_TO_PT);
        objects.push(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`,
            `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        );
    });
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((body, i) => {
        offsets.push(pdf.length);
        pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(pdf.length);
    for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i);
    return bytes;
}
