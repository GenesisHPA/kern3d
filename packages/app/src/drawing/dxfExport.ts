// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ComposedSheet,
    DASH_CENTER,
    DASH_HIDDEN,
    type DrawingLayer,
    type DrawingPrimitive,
} from "./primitives";

/**
 * DXF R12 (AC1009) — the version every CAD program reads. Lines and polylines become
 * POLYLINEs, arcs ARC/CIRCLE, arrowheads SOLID, texts TEXT; each drawing layer is a DXF layer
 * with its own line type, so hidden lines stay dashed and centre lines dash-dotted at 1:1.
 * The file is pure ASCII: non-ASCII characters (Cyrillic) are written as `\U+XXXX`, which
 * AutoCAD, BricsCAD, LibreCAD and ezdxf decode, and Ø/° as the %%c/%%d control codes.
 */

const LAYERS: Record<DrawingLayer, { name: string; color: number; lineType: string }> = {
    frame: { name: "FRAME", color: 7, lineType: "CONTINUOUS" },
    visible: { name: "VISIBLE", color: 7, lineType: "CONTINUOUS" },
    hidden: { name: "HIDDEN", color: 5, lineType: "HIDDEN" },
    tangent: { name: "TANGENT", color: 8, lineType: "CONTINUOUS" },
    center: { name: "CENTER", color: 1, lineType: "CENTER" },
    dimension: { name: "DIMENSIONS", color: 3, lineType: "CONTINUOUS" },
    text: { name: "TEXT", color: 7, lineType: "CONTINUOUS" },
};

function n(value: number): string {
    const s = Number.parseFloat(value.toFixed(6)).toString();
    return s.includes(".") || s.includes("e") ? s : `${s}.0`;
}

export function dxfText(value: string): string {
    let result = "";
    for (const ch of value) {
        const code = ch.codePointAt(0)!;
        if (ch === "Ø" || ch === "ø" || ch === "⌀") result += "%%c";
        else if (ch === "°") result += "%%d";
        else if (ch === "±") result += "%%p";
        else if (code >= 32 && code < 127) result += ch;
        else if (code <= 0xffff) result += `\\U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
        else result += "?";
    }
    return result;
}

class DxfWriter {
    private readonly lines: string[] = [];

    pair(code: number, value: string | number) {
        this.lines.push(String(code), typeof value === "number" ? n(value) : value);
    }

    int(code: number, value: number) {
        this.lines.push(String(code), String(Math.round(value)));
    }

    toString() {
        return `${this.lines.join("\r\n")}\r\n`;
    }
}

function lineType(w: DxfWriter, name: string, description: string, dash: number[]) {
    w.pair(0, "LTYPE");
    w.pair(2, name);
    w.int(70, 0);
    w.pair(3, description);
    w.int(72, 65);
    w.int(73, dash.length);
    w.pair(
        40,
        dash.reduce((a, b) => a + b, 0),
    );
    for (const [i, d] of dash.entries()) w.pair(49, i % 2 === 0 ? d : -d);
}

function header(w: DxfWriter, sheet: ComposedSheet) {
    w.pair(0, "SECTION");
    w.pair(2, "HEADER");
    w.pair(9, "$ACADVER");
    w.pair(1, "AC1009");
    w.pair(9, "$INSBASE");
    w.pair(10, 0);
    w.pair(20, 0);
    w.pair(30, 0);
    w.pair(9, "$EXTMIN");
    w.pair(10, 0);
    w.pair(20, 0);
    w.pair(9, "$EXTMAX");
    w.pair(10, sheet.width);
    w.pair(20, sheet.height);
    w.pair(9, "$LTSCALE");
    w.pair(40, 1);
    w.pair(9, "$MEASUREMENT");
    w.int(70, 1);
    w.pair(0, "ENDSEC");
}

function tables(w: DxfWriter) {
    w.pair(0, "SECTION");
    w.pair(2, "TABLES");
    w.pair(0, "TABLE");
    w.pair(2, "LTYPE");
    w.int(70, 3);
    lineType(w, "CONTINUOUS", "Solid line", []);
    lineType(w, "HIDDEN", "Hidden __ __ __", DASH_HIDDEN);
    lineType(w, "CENTER", "Center ____ _ ____", DASH_CENTER);
    w.pair(0, "ENDTAB");
    w.pair(0, "TABLE");
    w.pair(2, "LAYER");
    w.int(70, Object.keys(LAYERS).length);
    for (const layer of Object.values(LAYERS)) {
        w.pair(0, "LAYER");
        w.pair(2, layer.name);
        w.int(70, 0);
        w.int(62, layer.color);
        w.pair(6, layer.lineType);
    }
    w.pair(0, "ENDTAB");
    w.pair(0, "TABLE");
    w.pair(2, "STYLE");
    w.int(70, 1);
    w.pair(0, "STYLE");
    w.pair(2, "STANDARD");
    w.int(70, 0);
    w.pair(40, 0);
    w.pair(41, 1);
    w.pair(50, 0);
    w.int(71, 0);
    w.pair(42, 2.5);
    w.pair(3, "txt");
    w.pair(4, "");
    w.pair(0, "ENDTAB");
    w.pair(0, "ENDSEC");
}

function entity(w: DxfWriter, type: string, p: DrawingPrimitive) {
    w.pair(0, type);
    w.pair(8, LAYERS[p.layer].name);
}

function polyline(w: DxfWriter, p: DrawingPrimitive, points: number[], closed: boolean) {
    entity(w, "POLYLINE", p);
    w.int(66, 1);
    w.pair(10, 0);
    w.pair(20, 0);
    w.pair(30, 0);
    w.int(70, closed ? 1 : 0);
    for (let k = 0; k + 1 < points.length; k += 2) {
        w.pair(0, "VERTEX");
        w.pair(8, LAYERS[p.layer].name);
        w.pair(10, points[k]);
        w.pair(20, points[k + 1]);
        w.pair(30, 0);
    }
    w.pair(0, "SEQEND");
    w.pair(8, LAYERS[p.layer].name);
}

function write(w: DxfWriter, p: DrawingPrimitive) {
    switch (p.kind) {
        case "polyline":
            polyline(w, p, p.points, p.closed === true);
            return;
        case "arc": {
            const full = Math.abs(p.sweep) >= 2 * Math.PI - 1e-9;
            entity(w, full ? "CIRCLE" : "ARC", p);
            w.pair(10, p.cx);
            w.pair(20, p.cy);
            w.pair(30, 0);
            w.pair(40, p.r);
            if (!full) {
                // DXF arcs run counter-clockwise from 50 to 51
                const a = p.sweep >= 0 ? p.start : p.start + p.sweep;
                const deg = (x: number) => ((((x * 180) / Math.PI) % 360) + 360) % 360;
                w.pair(50, deg(a));
                w.pair(51, deg(a + Math.abs(p.sweep)));
            }
            return;
        }
        case "fill": {
            entity(w, "SOLID", p);
            const pts = p.points;
            const corner = (i: number) => [
                pts[(i % (pts.length / 2)) * 2],
                pts[(i % (pts.length / 2)) * 2 + 1],
            ];
            // SOLID corners go 1, 2, 4, 3; a triangle repeats its last corner
            const order = pts.length >= 8 ? [0, 1, 3, 2] : [0, 1, 2, 2];
            order.forEach((i, k) => {
                const [x, y] = corner(i);
                w.pair(10 + k, x);
                w.pair(20 + k, y);
                w.pair(30 + k, 0);
            });
            return;
        }
        case "text": {
            entity(w, "TEXT", p);
            w.pair(10, p.x);
            w.pair(20, p.y);
            w.pair(30, 0);
            w.pair(40, p.height);
            w.pair(1, dxfText(p.text));
            if (p.angle !== 0) w.pair(50, p.angle);
            w.pair(7, "STANDARD");
            const align = p.anchor === "start" ? 0 : p.anchor === "middle" ? 1 : 2;
            if (align !== 0) {
                w.int(72, align);
                w.pair(11, p.x);
                w.pair(21, p.y);
                w.pair(31, 0);
            }
            return;
        }
    }
}

export function sheetToDxf(sheet: ComposedSheet): string {
    const w = new DxfWriter();
    header(w, sheet);
    tables(w);
    w.pair(0, "SECTION");
    w.pair(2, "ENTITIES");
    for (const p of sheet.primitives) write(w, p);
    w.pair(0, "ENDSEC");
    w.pair(0, "EOF");
    return w.toString();
}
