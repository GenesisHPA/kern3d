// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { DrawingData, SheetData, TitleBlockKind, TitleField } from "./drawingData";
import {
    type DrawingPrimitive,
    estimateTextWidth,
    LINE_WIDTH,
    line,
    type Rect,
    type TextAnchor,
    text,
} from "./primitives";

const FORMAT_SIZES: Record<SheetData["format"], [number, number]> = {
    A4: [210, 297],
    A3: [297, 420],
    A2: [420, 594],
    A1: [594, 841],
    A0: [841, 1189],
};

/** Paper size in mm, [width, height]. */
export function sheetSize(sheet: SheetData): [number, number] {
    const [short, long] = FORMAT_SIZES[sheet.format];
    return sheet.orientation === "portrait" ? [short, long] : [long, short];
}

/** Inner frame: ГОСТ 2.301 keeps 20 mm on the binding side and 5 mm elsewhere, ISO 5457 10 mm. */
export function frameRect(sheet: SheetData, kind: TitleBlockKind): Rect {
    const [w, h] = sheetSize(sheet);
    const m = kind === "gost" ? 5 : 10;
    return { minX: 20, minY: m, maxX: w - m, maxY: h - m };
}

export const TITLE_BLOCK_SIZE: Record<TitleBlockKind, [number, number]> = {
    gost: [185, 55],
    iso: [180, 36],
    none: [0, 0],
};

/** Parts of the drawing area the frame takes: ГОСТ graph 26 in the top-left corner. */
export function reservedRects(sheet: SheetData, kind: TitleBlockKind): Rect[] {
    if (kind !== "gost") return [];
    const frame = frameRect(sheet, kind);
    return [{ minX: frame.minX, minY: frame.maxY - 14, maxX: frame.minX + 70, maxY: frame.maxY }];
}

/** Where views can go: the inner frame above the title block's height. */
export function drawingArea(sheet: SheetData, kind: TitleBlockKind, page = 0): Rect {
    const frame = frameRect(sheet, kind);
    const [, blockHeight] = TITLE_BLOCK_SIZE[kind];
    return { ...frame, minY: frame.minY + (page > 0 && kind === "gost" ? 15 : blockHeight) };
}

/**
 * The title block of a following sheet, ГОСТ 2.104 form 2а: 185 × 15 — the change columns,
 * the designation, and the sheet number.
 */
function gostFollowingBlock(right: number, bottom: number, f: Fields): DrawingPrimitive[] {
    const pen = new BlockPen(right - 185, bottom + 15);
    pen.h(0, 0, 185, LINE_WIDTH.thick);
    for (const y of [5, 10]) pen.h(y, 0, 65, LINE_WIDTH.thin);
    pen.h(7, 175, 185, LINE_WIDTH.thin);
    for (const x of [7, 17, 40, 55, 65]) pen.v(x, 0, 15, x === 65 ? LINE_WIDTH.thick : LINE_WIDTH.thin);
    pen.v(175, 0, 15, LINE_WIDTH.thick);
    const small = 2.5;
    for (const [x, label] of [
        [3.5, "Изм"],
        [12, "Лист"],
        [28.5, "№ докум."],
        [47.5, "Подп."],
        [60, "Дата"],
    ] as [number, string][]) {
        pen.label(x, 12.5, label, small, "middle");
    }
    pen.label(180, 3.5, "Лист", small, "middle");
    if (f.sheet) pen.label(180, 11, f.sheet, 3.5, "middle");
    if (f.designation) pen.label(120, 7.5, f.designation, 7, "middle");
    pen.v(0, 0, 15, LINE_WIDTH.thick);
    return pen.primitives;
}

function rect(x0: number, y0: number, x1: number, y1: number, width: number): DrawingPrimitive {
    return {
        kind: "polyline",
        layer: "frame",
        points: [x0, y0, x1, y0, x1, y1, x0, y1],
        closed: true,
        width,
    };
}

/**
 * Draws into a block given in its own coordinates — x right and y DOWN from the block's
 * top-left corner, as the standards dimension their forms — placed on the sheet with its
 * lower-right corner at (`right`, `bottom`).
 */
class BlockPen {
    readonly primitives: DrawingPrimitive[] = [];

    constructor(
        private readonly left: number,
        private readonly top: number,
    ) {}

    private X(x: number) {
        return this.left + x;
    }

    private Y(y: number) {
        return this.top - y;
    }

    h(y: number, x0: number, x1: number, width: number = LINE_WIDTH.thin) {
        this.primitives.push(line("frame", [this.X(x0), this.Y(y), this.X(x1), this.Y(y)], width));
    }

    v(x: number, y0: number, y1: number, width: number = LINE_WIDTH.thick) {
        this.primitives.push(line("frame", [this.X(x), this.Y(y0), this.X(x), this.Y(y1)], width));
    }

    /** Text centred vertically on `cy`; shrunk to fit `maxWidth` when given. */
    label(
        x: number,
        cy: number,
        value: string,
        height: number,
        anchor: TextAnchor = "start",
        maxWidth?: number,
    ) {
        if (!value) return;
        let h = height;
        if (maxWidth !== undefined) {
            const w = estimateTextWidth(value, h);
            if (w > maxWidth) h = Math.max(1.5, (h * maxWidth) / w);
        }
        this.primitives.push(text("text", this.X(x), this.Y(cy + h / 2), value, h, anchor));
    }
}

type Fields = Partial<Record<TitleField, string>>;

/** ГОСТ 2.104 form 1 — the основная надпись of a part drawing, 185 × 55. */
function gostTitleBlock(right: number, bottom: number, f: Fields): DrawingPrimitive[] {
    const pen = new BlockPen(right - 185, bottom + 55);
    for (let y = 5; y < 55; y += 5)
        pen.h(y, 0, 65, y === 25 || y === 20 ? LINE_WIDTH.thick : LINE_WIDTH.thin);
    pen.v(7, 0, 25);
    for (const x of [17, 40, 55, 65]) pen.v(x, 0, 55);
    pen.h(15, 65, 185, LINE_WIDTH.thick);
    pen.h(40, 65, 185, LINE_WIDTH.thick);
    pen.v(135, 15, 55);
    pen.h(20, 135, 185, LINE_WIDTH.thick);
    pen.h(35, 135, 185, LINE_WIDTH.thick);
    pen.v(150, 15, 35);
    pen.v(167, 15, 35);
    pen.v(140, 20, 35, LINE_WIDTH.thin);
    pen.v(145, 20, 35, LINE_WIDTH.thin);
    pen.v(155, 35, 40, LINE_WIDTH.thin);

    const small = 2.5;
    pen.label(3.5, 22.5, "Изм.", small, "middle");
    pen.label(12, 22.5, "Лист", small, "middle");
    pen.label(28.5, 22.5, "№ докум.", small, "middle");
    pen.label(47.5, 22.5, "Подп.", small, "middle");
    pen.label(60, 22.5, "Дата", small, "middle");
    const roles: [string, TitleField | undefined][] = [
        ["Разраб.", "developer"],
        ["Пров.", "checker"],
        ["Т.контр.", "techControl"],
        ["", undefined],
        ["Н.контр.", "normControl"],
        ["Утв.", "approver"],
    ];
    roles.forEach(([role, field], i) => {
        const cy = 27.5 + i * 5;
        pen.label(1, cy, role, small, "start", 15.5);
        if (field !== undefined) pen.label(18, cy, f[field] ?? "", small, "start", 21.5);
    });
    pen.label(55.5, 27.5, f.date ?? "", small, "start", 9);

    pen.label(125, 7.5, f.designation ?? "", 5, "middle", 116);
    pen.label(100, 27.5, f.name ?? "", 5, "middle", 66);
    pen.label(100, 47.5, f.material ?? "", 3.5, "middle", 66);
    pen.label(142.5, 17.5, "Лит.", small, "middle");
    pen.label(158.5, 17.5, "Масса", small, "middle");
    pen.label(176, 17.5, "Масштаб", small, "middle");
    pen.label(137.5, 27.5, f.letter ?? "", 3.5, "middle", 4.5);
    pen.label(158.5, 27.5, f.mass ?? "", 3.5, "middle", 16);
    pen.label(176, 27.5, f.scale ?? "", 3.5, "middle", 17);
    pen.label(136, 37.5, `Лист ${f.sheet ?? ""}`, small, "start", 18);
    pen.label(156, 37.5, `Листов ${f.sheets ?? ""}`, small, "start", 28);
    pen.label(160, 47.5, f.organization ?? "", 3.5, "middle", 48);
    pen.primitives.push(rect(right - 185, bottom, right, bottom + 55, LINE_WIDTH.thick));
    return pen.primitives;
}

/** A plain ISO 7200-style block, 180 × 36: a label in each cell's corner, the value below. */
function isoTitleBlock(right: number, bottom: number, f: Fields, projection: DrawingData["projection"]) {
    const pen = new BlockPen(right - 180, bottom + 36);
    for (const y of [9, 18, 27]) pen.h(y, 0, 180);
    pen.v(120, 0, 18, LINE_WIDTH.thin);
    for (const x of [60, 90, 150]) pen.v(x, 9, 18, LINE_WIDTH.thin);
    for (const x of [60, 120]) pen.v(x, 18, 27, LINE_WIDTH.thin);
    pen.v(60, 27, 36, LINE_WIDTH.thin);
    const cell = (x: number, y: number, w: number, caption: string, value: string) => {
        pen.label(x + 1, y + 2, caption, 1.8, "start");
        pen.label(x + 1, y + 6.2, value, 3.5, "start", w - 2);
    };
    cell(0, 0, 120, "Title", f.name ?? "");
    cell(120, 0, 60, "Drawing No.", f.designation ?? "");
    cell(0, 9, 60, "Material", f.material ?? "");
    cell(60, 9, 30, "Mass", f.mass ?? "");
    cell(90, 9, 30, "Scale", f.scale ?? "");
    cell(120, 9, 30, "Sheet", `${f.sheet ?? ""}/${f.sheets ?? ""}`);
    cell(150, 9, 30, "Projection", projection === "first" ? "First angle" : "Third angle");
    cell(0, 18, 60, "Drawn by", f.developer ?? "");
    cell(60, 18, 60, "Checked", f.checker ?? "");
    cell(120, 18, 60, "Approved", f.approver ?? "");
    cell(0, 27, 60, "Date", f.date ?? "");
    cell(60, 27, 120, "Organization", f.organization ?? "");
    pen.primitives.push(rect(right - 180, bottom, right, bottom + 36, LINE_WIDTH.thick));
    return pen.primitives;
}

/** The sheet border, the inner frame and the title block, with `fields` filled in. */
export function composeFrame(data: DrawingData, fields: Fields, page = 0): DrawingPrimitive[] {
    const [w, h] = sheetSize(data.sheet);
    const kind = data.titleBlock.kind;
    const frame = frameRect(data.sheet, kind);
    const primitives: DrawingPrimitive[] = [
        rect(0, 0, w, h, LINE_WIDTH.thin),
        rect(frame.minX, frame.minY, frame.maxX, frame.maxY, LINE_WIDTH.frame),
    ];
    if (kind === "gost") {
        primitives.push(
            ...(page > 0
                ? gostFollowingBlock(frame.maxX, frame.minY, fields)
                : gostTitleBlock(frame.maxX, frame.minY, fields)),
        );
        // graph 26: the designation again, turned 180°, in the top-left corner
        primitives.push(rect(frame.minX, frame.maxY - 14, frame.minX + 70, frame.maxY, LINE_WIDTH.thick));
        if (fields.designation) {
            primitives.push(
                text("text", frame.minX + 35, frame.maxY - 7 + 2.5, fields.designation, 5, "middle", 180),
            );
        }
    } else if (kind === "iso") {
        primitives.push(...isoTitleBlock(frame.maxX, frame.minY, fields, data.projection));
    }
    return primitives;
}
