// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ArcPrimitive, ComposedSheet, DrawingPrimitive, TextPrimitive } from "./primitives";

/** Capital height to font size: a cap is ~0.7 em in the fonts a drawing is set in. */
export const CAP_TO_EM = 1 / 0.7;

export const DRAWING_FONT_FAMILY = "'GOST type B', 'GOST 2.304', ISOCPEUR, Roboto, Arial, sans-serif";

function n(value: number): string {
    return Number.parseFloat(value.toFixed(3)).toString();
}

export function escapeXml(value: string): string {
    return value.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function stroke(width: number, dash: number[] | undefined): string {
    const dashes = dash === undefined ? "" : ` stroke-dasharray="${dash.map(n).join(" ")}"`;
    return `fill="none" stroke="currentColor" stroke-width="${n(width)}" stroke-linecap="round" stroke-linejoin="round"${dashes}`;
}

function pointsOf(points: number[]): string {
    const pairs: string[] = [];
    for (let k = 0; k + 1 < points.length; k += 2) pairs.push(`${n(points[k])},${n(points[k + 1])}`);
    return pairs.join(" ");
}

function arcElement(p: ArcPrimitive): string {
    if (Math.abs(p.sweep) >= 2 * Math.PI - 1e-9) {
        return `<circle cx="${n(p.cx)}" cy="${n(p.cy)}" r="${n(p.r)}" ${stroke(p.width, p.dash)}/>`;
    }
    const end = p.start + p.sweep;
    const x0 = p.cx + p.r * Math.cos(p.start);
    const y0 = p.cy + p.r * Math.sin(p.start);
    const x1 = p.cx + p.r * Math.cos(end);
    const y1 = p.cy + p.r * Math.sin(end);
    const large = Math.abs(p.sweep) > Math.PI ? 1 : 0;
    const sweep = p.sweep > 0 ? 1 : 0;
    return `<path d="M${n(x0)} ${n(y0)}A${n(p.r)} ${n(p.r)} 0 ${large} ${sweep} ${n(x1)} ${n(y1)}" ${stroke(p.width, p.dash)}/>`;
}

function textElement(p: TextPrimitive): string {
    // The sheet group flips y; the text is flipped back so it reads upright.
    const transform = `translate(${n(p.x)} ${n(p.y)}) scale(1 -1)${p.angle === 0 ? "" : ` rotate(${n(-p.angle)})`}`;
    return `<text transform="${transform}" font-size="${n(p.height * CAP_TO_EM)}" text-anchor="${p.anchor}" fill="currentColor" stroke="none">${escapeXml(p.text)}</text>`;
}

export function primitiveElement(p: DrawingPrimitive): string {
    switch (p.kind) {
        case "polyline": {
            const tag = p.closed ? "polygon" : "polyline";
            return `<${tag} points="${pointsOf(p.points)}" ${stroke(p.width, p.dash)}/>`;
        }
        case "arc":
            return arcElement(p);
        case "fill":
            return `<polygon points="${pointsOf(p.points)}" fill="currentColor" stroke="none"/>`;
        case "text":
            return textElement(p);
    }
}

/**
 * The primitives as SVG elements in sheet millimetres (y up), grouped into `<g>`s: by layer
 * for an exported file (layers survive into Inkscape and the like), by owner for the editor,
 * which hit-tests on `data-owner`.
 */
export function primitivesMarkup(
    primitives: readonly DrawingPrimitive[],
    groupBy: "layer" | "owner",
): string {
    const parts: string[] = [];
    let current: string | undefined;
    for (const p of primitives) {
        const key = groupBy === "layer" ? p.layer : (p.owner ?? "");
        if (key !== current) {
            if (current !== undefined) parts.push("</g>");
            const attribute = groupBy === "layer" ? `class="layer-${key}"` : `data-owner="${escapeXml(key)}"`;
            parts.push(`<g ${attribute}>`);
            current = key;
        }
        parts.push(primitiveElement(p));
    }
    if (current !== undefined) parts.push("</g>");
    return parts.join("");
}

/** A standalone SVG at true size: the width and height are in millimetres, so it prints 1:1. */
export function sheetToSvg(sheet: ComposedSheet): string {
    const ordered = [...sheet.primitives].sort((a, b) => layerOrder(a) - layerOrder(b));
    return [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<svg xmlns="http://www.w3.org/2000/svg" width="${n(sheet.width)}mm" height="${n(sheet.height)}mm" viewBox="0 0 ${n(sheet.width)} ${n(sheet.height)}" color="#000" font-family="${DRAWING_FONT_FAMILY}">`,
        `<rect x="0" y="0" width="${n(sheet.width)}" height="${n(sheet.height)}" fill="#fff"/>`,
        `<g transform="matrix(1 0 0 -1 0 ${n(sheet.height)})">`,
        primitivesMarkup(ordered, "layer"),
        `</g>`,
        `</svg>`,
    ].join("\n");
}

const ORDER = ["frame", "hidden", "center", "tangent", "visible", "dimension", "text"];
function layerOrder(p: DrawingPrimitive): number {
    return ORDER.indexOf(p.layer);
}
