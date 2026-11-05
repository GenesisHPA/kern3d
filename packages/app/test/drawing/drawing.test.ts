// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type FontOutline, type IDocument, Serializer, Transaction } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { composeDrawing, formatLength, titleFields } from "../../src/drawing/compose";
import {
    type DrawingData,
    type DrawingViewData,
    defaultDrawingData,
    parseDrawingData,
    stringifyDrawingData,
} from "../../src/drawing/drawingData";
import { DrawingNode } from "../../src/drawing/drawingNode";
import { alignProjectedViews, removeView } from "../../src/drawing/drawingViews";
import { dxfText, sheetToDxf } from "../../src/drawing/dxfExport";
import type { ViewGeometry } from "../../src/drawing/hlr";
import { arcPath, sheetToPdf } from "../../src/drawing/pdfExport";
import type {
    ComposedSheet,
    DrawingPrimitive,
    PolylinePrimitive,
    TextPrimitive,
} from "../../src/drawing/primitives";
import { sheetSize } from "../../src/drawing/sheet";
import { sheetToSvg } from "../../src/drawing/svgExport";
import {
    fittingScale,
    formatScale,
    orientationBasis,
    parseScale,
    projectedBasis,
    type ViewBasis,
} from "../../src/drawing/viewBasis";

function sameBasis(a: ViewBasis, b: ViewBasis) {
    for (const key of ["u", "v", "w"] as const) {
        for (let i = 0; i < 3; i++) expect(a[key][i]).toBeCloseTo(b[key][i], 9);
    }
}

/** A 100 × 40 rectangle with a Ø20 circle in it, as a view's projected geometry. */
function rectangleGeometry(): ViewGeometry {
    return {
        visible: [
            { points: [0, 0, 100, 0, 100, 40, 0, 40, 0, 0] },
            { points: [60, 20, 40, 20], arc: { cx: 50, cy: 20, r: 10, start: 0, sweep: 2 * Math.PI } },
        ],
        hidden: [{ points: [30, 0, 30, 40] }],
        tangent: [],
        circles: [{ cx: 50, cy: 20, r: 10 }],
        axes: [],
        vertices: [0, 0, 100, 0, 100, 40, 0, 40, 50, 20],
        cut: [],
        bounds: { minX: 0, minY: 0, maxX: 100, maxY: 40 },
    };
}

function view(overrides: Partial<DrawingViewData> = {}): DrawingViewData {
    const basis = orientationBasis("front");
    return {
        id: "v1",
        sourceId: "body",
        orientation: "front",
        u: basis.u,
        v: basis.v,
        scale: 0.5,
        x: 150,
        y: 150,
        showHidden: true,
        showTangent: false,
        showCenterMarks: true,
        ...overrides,
    };
}

function drawingWith(views: DrawingViewData[]): DrawingData {
    return { ...defaultDrawingData(), views };
}

function ofOwner(sheet: ComposedSheet, owner: string): DrawingPrimitive[] {
    return sheet.primitives.filter((p) => p.owner === owner);
}

describe("drawing data", () => {
    test("round-trips through its JSON form", () => {
        const data = drawingWith([view()]);
        data.dimensions.push({
            id: "d1",
            kind: "horizontal",
            viewId: "v1",
            a: [0, 0],
            b: [100, 0],
            offset: -10,
        });
        data.notes.push({ id: "n1", x: 30, y: 40, text: "Неуказанные радиусы R1", height: 3.5 });
        expect(parseDrawingData(stringifyDrawingData(data))).toEqual(data);
    });

    test("opens whatever it is given: malformed input falls back to the defaults", () => {
        expect(parseDrawingData("not json")).toEqual(defaultDrawingData());
        const parsed = parseDrawingData(
            JSON.stringify({
                sheet: { format: "B7" },
                views: [{ id: "v" }, { id: "v2", sourceId: "s", scale: -1 }],
            }),
        );
        expect(parsed.sheet.format).toBe("A3");
        expect(parsed.views.map((v) => v.id)).toEqual(["v2"]);
        expect(parsed.views[0].scale).toBeGreaterThan(0);
    });

    test("defaults to A3, first-angle projection and the ГОСТ title block", () => {
        const data = defaultDrawingData();
        expect(data.sheet).toEqual({ format: "A3", orientation: "landscape" });
        expect(data.projection).toBe("first");
        expect(data.titleBlock.kind).toBe("gost");
        expect(sheetSize(data.sheet)).toEqual([420, 297]);
        expect(sheetSize({ format: "A4", orientation: "portrait" })).toEqual([210, 297]);
    });
});

describe("view directions", () => {
    const front = orientationBasis("front");

    test("first angle (ГОСТ 2.305) puts the top view below and the left view on the right", () => {
        sameBasis(projectedBasis(front, "down", "first"), orientationBasis("top"));
        sameBasis(projectedBasis(front, "right", "first"), orientationBasis("left"));
        sameBasis(projectedBasis(front, "left", "first"), orientationBasis("right"));
        sameBasis(projectedBasis(front, "up", "first"), orientationBasis("bottom"));
    });

    test("third angle puts each view on the side it is seen from", () => {
        sameBasis(projectedBasis(front, "up", "third"), orientationBasis("top"));
        sameBasis(projectedBasis(front, "right", "third"), orientationBasis("right"));
    });

    test("the front view looks along +Y with Z up", () => {
        expect(front.w).toEqual([0, -1, 0]);
        expect(front.v).toEqual([0, 0, 1]);
    });
});

describe("scales", () => {
    test.each([
        [0.5, "1:2"],
        [1, "1:1"],
        [2, "2:1"],
        [0.4, "1:2.5"],
    ])("%d reads %s and back", (scale, text) => {
        expect(formatScale(scale)).toBe(text);
        expect(parseScale(text)).toBeCloseTo(scale, 9);
    });

    test("a fitting scale is the largest standard one that fits", () => {
        expect(fittingScale(300, 200)).toBeCloseTo(1 / 2, 9);
        expect(fittingScale(10, 200)).toBe(20);
        expect(parseScale("abc")).toBeUndefined();
    });
});

describe("composing a sheet", () => {
    test("a view is drawn at its scale around its position", () => {
        const sheet = composeDrawing(drawingWith([view()]), new Map([["v1", rectangleGeometry()]]));
        const outline = ofOwner(sheet, "view:v1").find(
            (p): p is PolylinePrimitive => p.kind === "polyline" && p.layer === "visible",
        )!;
        // 100 × 40 at 1:2, centred on (150, 150)
        expect(outline.points.slice(0, 4)).toEqual([125, 140, 175, 140]);
        expect(outline.points[5]).toBe(160);
        expect(outline.width).toBe(0.5);
        const hidden = ofOwner(sheet, "view:v1").filter((p) => p.layer === "hidden");
        expect(hidden).toEqual([expect.objectContaining({ kind: "polyline", dash: [4, 1.5] })]);
        const circle = ofOwner(sheet, "view:v1").find((p) => p.kind === "arc");
        expect(circle).toEqual(expect.objectContaining({ cx: 150, cy: 150, r: 5 }));
    });

    test("hidden lines and centre marks follow the view's toggles", () => {
        const geometry = new Map([["v1", rectangleGeometry()]]);
        const on = composeDrawing(drawingWith([view()]), geometry);
        const off = composeDrawing(
            drawingWith([view({ showHidden: false, showCenterMarks: false })]),
            geometry,
        );
        expect(on.primitives.filter((p) => p.layer === "center").length).toBe(2);
        expect(off.primitives.some((p) => p.layer === "hidden" || p.layer === "center")).toBe(false);
    });

    test("dimensions state model values, not paper lengths", () => {
        const data = drawingWith([view()]);
        data.dimensions.push(
            { id: "h", kind: "horizontal", viewId: "v1", a: [0, 0], b: [100, 40], offset: -10 },
            { id: "v", kind: "vertical", viewId: "v1", a: [100, 0], b: [100, 40], offset: 10 },
            { id: "al", kind: "aligned", viewId: "v1", a: [0, 0], b: [30, 40], offset: 5 },
            { id: "dia", kind: "diameter", viewId: "v1", center: [50, 20], radius: 10, angle: 45 },
            { id: "r", kind: "radius", viewId: "v1", center: [50, 20], radius: 6.25, angle: 45 },
        );
        const sheet = composeDrawing(data, new Map([["v1", rectangleGeometry()]]));
        const label = (id: string) =>
            (ofOwner(sheet, `dim:${id}`).find((p) => p.kind === "text") as TextPrimitive).text;
        expect(label("h")).toBe("100");
        expect(label("v")).toBe("40");
        expect(label("al")).toBe("50");
        expect(label("dia")).toBe("Ø20");
        expect(label("r")).toBe("R6,25");
        // two arrowheads on a linear dimension, its text upright along a vertical line
        expect(ofOwner(sheet, "dim:h").filter((p) => p.kind === "fill").length).toBe(2);
        expect((ofOwner(sheet, "dim:v").find((p) => p.kind === "text") as TextPrimitive).angle).toBeCloseTo(
            90,
            6,
        );
    });

    test("the title block shows the base view's scale unless one is typed", () => {
        const data = drawingWith([view()]);
        expect(titleFields(data).scale).toBe("1:2");
        data.titleBlock.fields.scale = "2:1";
        expect(titleFields(data).scale).toBe("2:1");
        expect(formatLength(12.5, true)).toBe("12,5");
        expect(formatLength(12.5, false)).toBe("12.5");
    });

    test("the ГОСТ title block carries its Russian captions and the filled fields", () => {
        const data = drawingWith([view()]);
        data.titleBlock.fields.name = "Корпус клапана";
        const texts = composeDrawing(data, new Map())
            .primitives.filter((p): p is TextPrimitive => p.kind === "text")
            .map((p) => p.text);
        expect(texts).toEqual(
            expect.arrayContaining(["Разраб.", "Масштаб", "Корпус клапана", "1:2", "Лист 1"]),
        );
    });

    test("a view whose model is missing shows a placeholder instead of disappearing", () => {
        const sheet = composeDrawing(drawingWith([view()]), new Map());
        expect(ofOwner(sheet, "view:v1").some((p) => p.kind === "text" && p.text === "?")).toBe(true);
    });
});

describe("projected views", () => {
    test("stay on their parent's row or column and at its scale", () => {
        const parent = view({ id: "p", x: 100, y: 200, scale: 1 });
        const side = view({ id: "s", parentId: "p", side: "right", x: 250, y: 0, scale: 3 });
        const below = view({ id: "b", parentId: "p", side: "down", x: 0, y: 80, scale: 3 });
        const data = drawingWith([parent, side, below]);
        alignProjectedViews(data);
        expect([side.y, side.scale]).toEqual([200, 1]);
        expect([below.x, below.scale]).toEqual([100, 1]);
        expect(side.x).toBe(250);
    });

    test("go with the view they were projected from, with their dimensions", () => {
        const data = drawingWith([
            view({ id: "p" }),
            view({ id: "s", parentId: "p", side: "right" }),
            view({ id: "o" }),
        ]);
        data.dimensions.push({ id: "d", kind: "aligned", viewId: "s", a: [0, 0], b: [1, 1], offset: 1 });
        removeView(data, "p");
        expect(data.views.map((v) => v.id)).toEqual(["o"]);
        expect(data.dimensions).toEqual([]);
    });
});

describe("export", () => {
    function sample(): ComposedSheet {
        const data = drawingWith([view()]);
        data.titleBlock.fields.name = "Штуцер";
        data.dimensions.push({
            id: "dia",
            kind: "diameter",
            viewId: "v1",
            center: [50, 20],
            radius: 10,
            angle: 30,
        });
        return composeDrawing(data, new Map([["v1", rectangleGeometry()]]));
    }

    test("SVG is well-formed and sized in millimetres for 1:1 printing", () => {
        const svg = sheetToSvg(sample());
        const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
        expect(doc.querySelector("parsererror")).toBeNull();
        const root = doc.documentElement;
        expect(root.getAttribute("width")).toBe("420mm");
        expect(root.getAttribute("height")).toBe("297mm");
        expect(root.getAttribute("viewBox")).toBe("0 0 420 297");
        expect(svg).toContain("Штуцер");
        expect(svg).toContain('stroke-dasharray="4 1.5"');
        expect(doc.querySelectorAll("circle").length).toBe(1);
    });

    test("DXF has the R12 sections, a layer per line kind and ASCII-escaped Cyrillic", () => {
        const dxf = sheetToDxf(sample());
        const lines = dxf.split("\r\n");
        expect(lines.pop()).toBe("");
        expect(lines.length % 2).toBe(0);
        for (let i = 0; i < lines.length; i += 2) expect(lines[i].trim()).toMatch(/^\d+$/);
        const values = lines.filter((_, i) => i % 2 === 1);
        expect(values.filter((v) => v === "SECTION").length).toBe(3);
        expect(values.at(-1)).toBe("EOF");
        for (const layer of ["VISIBLE", "HIDDEN", "CENTER", "DIMENSIONS"]) expect(values).toContain(layer);
        expect(values).toContain("CIRCLE");
        expect(values).toContain("%%c20");
        expect(dxfText("Штуцер")).toBe("\\U+0428\\U+0442\\U+0443\\U+0446\\U+0435\\U+0440");
        expect(/^[\x20-\x7e\r\n]*$/.test(dxf)).toBe(true);
    });

    function pdfText(bytes: Uint8Array): string {
        return Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    }

    function checkXref(pdf: string) {
        expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
        const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)![1]);
        expect(pdf.slice(start, start + 4)).toBe("xref");
        const entries = pdf.slice(start).split("\n").slice(3, 9);
        entries.forEach((entry, i) => {
            const offset = Number(entry.slice(0, 10));
            expect(pdf.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
        });
        const length = Number(/\/Length (\d+) >>\nstream\n/.exec(pdf)![1]);
        const body = pdf.indexOf("stream\n") + "stream\n".length;
        expect(pdf.slice(body + length, body + length + "\nendstream".length)).toBe("\nendstream");
    }

    test("PDF has a valid cross-reference table and an A3 page in points", () => {
        const pdf = pdfText(sheetToPdf(sample()));
        checkXref(pdf);
        expect(pdf).toContain("/MediaBox [0 0 1190.551 841.89]");
        // without a font the text falls back to Helvetica
        expect(pdf).toContain("Tj");
        expect(pdf).toContain("[4 1.5] 0 d");
    });

    test("PDF text is drawn as glyph outlines when a font is given, so Cyrillic survives", () => {
        const square = {
            advance: 600,
            contours: [
                {
                    start: { x: 0, y: 0 },
                    segments: [
                        { kind: "line" as const, to: { x: 500, y: 0 } },
                        { kind: "quad" as const, c1: { x: 500, y: 700 }, to: { x: 0, y: 700 } },
                    ],
                },
            ],
        };
        const font: FontOutline = {
            familyName: "Test",
            unitsPerEm: 1000,
            missingAdvance: 500,
            glyph: () => square,
        };
        const pdf = pdfText(sheetToPdf(sample(), font));
        checkXref(pdf);
        expect(pdf).not.toContain("Tj");
        expect(pdf).toMatch(/ c h f/);
    });

    test("an arc becomes quarter Béziers that end where the arc does", () => {
        const path = arcPath({ cx: 0, cy: 0, r: 10, start: 0, sweep: Math.PI });
        const curves = path.split(" c").length - 1;
        expect(curves).toBe(2);
        expect(path.startsWith("10 0 m")).toBe(true);
        expect(path.trim().endsWith("-10 0 c")).toBe(true);
    });
});

describe("DrawingNode", () => {
    let document: IDocument;
    beforeEach(() => {
        document = new TestDocument() as unknown as IDocument;
    });

    test("persists its description and reads back the same drawing", () => {
        const node = new DrawingNode({ document, name: "Чертёж1" });
        const data = node.data;
        data.views.push(view());
        node.setData(data);
        const serialized = Serializer.serializeObject(node);
        expect(serialized["__cla$$__"]).toBe("DrawingNode");
        const copy = Serializer.deserializeObject(document, serialized) as DrawingNode;
        expect(copy).toBeInstanceOf(DrawingNode);
        expect(copy.name).toBe("Чертёж1");
        expect(copy.id).toBe(node.id);
        expect(copy.data).toEqual(data);
    });

    test("an edit is one undo step", () => {
        const node = new DrawingNode({ document, name: "d" });
        const before = node.content;
        Transaction.execute(document, "edit", () => {
            const data = node.data;
            data.sheet.format = "A4";
            node.setData(data);
        });
        expect(node.data.sheet.format).toBe("A4");
        document.history.undo();
        expect(node.content).toBe(before);
    });
});

describe("several sheets", () => {
    test("each sheet draws its own views; the following ones carry form 2а with their number", () => {
        const data = defaultDrawingData();
        data.pages = 2;
        data.views.push(view({ id: "a", x: 100, y: 150 }), view({ id: "b", x: 200, y: 150, page: 1 }));
        const geometries = new Map([
            ["a", rectangleGeometry()],
            ["b", rectangleGeometry()],
        ]);
        const first = composeDrawing(data, geometries, 0);
        const second = composeDrawing(data, geometries, 1);
        const owners = (s: typeof first) => new Set(s.primitives.map((p) => p.owner).filter(Boolean));
        expect(owners(first).has("view:a")).toBe(true);
        expect(owners(first).has("view:b")).toBe(false);
        expect(owners(second).has("view:b")).toBe(true);
        const texts = (s: typeof first) => s.primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));
        expect(texts(first)).toContain("Листов 2");
        // form 2а: no "Разраб." rows, the sheet number in its box
        expect(texts(second)).not.toContain("Разраб.");
        expect(texts(second)).toContain("2");
        const pdf = new TextDecoder().decode(sheetToPdf([first, second]));
        expect(pdf).toContain("/Count 2");
    });
});
