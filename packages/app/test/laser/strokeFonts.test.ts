// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { writeFileSync } from "node:fs";
import { describe, expect, test } from "@rstest/core";
import { generateGcode } from "../../src/laser/gcode";
import { pathsBounds } from "../../src/laser/geometry";
import { jczProgram } from "../../src/laser/jczProgram";
import { defaultOperation, type LaserJobData } from "../../src/laser/laserData";
import { List } from "../../src/laser/lmc";
import { defaultMachineProfile } from "../../src/laser/machineProfile";
import { convertToPath, shapeObject } from "../../src/laser/shapeObject";
import { type LaserShape, textPaths } from "../../src/laser/shapes";
import {
    HERSHEY_CYRILLIC_KEYS,
    isStrokeFont,
    loadStrokeFont,
    parseJhf,
    parseLff,
    STROKE_FONTS,
} from "../../src/laser/strokeFonts";

const RUSSIAN = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя";

function text(font: string, s: string, over: Partial<Extract<LaserShape, { type: "text" }>> = {}) {
    return {
        type: "text" as const,
        text: s,
        font: { family: font, stroke: font },
        size: 10,
        letterSpacing: 0,
        lineSpacing: 1.2,
        align: "left" as const,
        arcRadius: 0,
        ...over,
    };
}

describe("Hershey .jhf", () => {
    test("a record: sides, pen-up, y down to y up, capitals 700 high", () => {
        // "A" of futural: 3 strokes, sides −9 … 9
        const [a] = parseJhf("  9I[RFJ[ RRFZ[ RMTWT");
        expect(a.advance).toBeCloseTo((18 * 700) / 21, 6);
        expect(a.strokes).toHaveLength(3);
        const ys = a.strokes.flat().map((p) => p.y);
        expect(Math.min(...ys)).toBeCloseTo(0, 6);
        expect(Math.max(...ys)).toBeCloseTo(700, 6);
        // the apex is in the middle of the advance
        expect(a.strokes[0][0].x).toBeCloseTo(a.advance / 2, 6);
    });

    test("the Cyrillic key table covers the Russian alphabet but Ё and э (made from Е and Э)", () => {
        const letters = Object.keys(HERSHEY_CYRILLIC_KEYS).join("");
        for (const c of RUSSIAN) if (!"Ёёэ".includes(c)) expect(letters).toContain(c);
        // every key used once
        const keys = Object.values(HERSHEY_CYRILLIC_KEYS);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe("LibreCAD .lff", () => {
    test("polylines, bulge arcs, references and spacing", () => {
        const g = parseLff(
            [
                "# LetterSpacing: 1",
                "# WordSpacing: 4",
                "[0048] H",
                "0,0;0,10",
                "4,0;4,10",
                "0,5;4,5",
                "[006f] o",
                "0,2;4,2,A1;0,2,A1",
                "[00d8] Ø",
                "C006f",
                "0,0;4,4",
            ].join("\n"),
        );
        const h = g.get(0x48)!;
        expect(h.strokes).toHaveLength(3);
        // H 10 high → scaled to 700; advance = right edge + letter spacing
        expect(Math.max(...h.strokes.flat().map((p) => p.y))).toBeCloseTo(700, 6);
        expect(h.advance).toBeCloseTo(5 * 70, 6);
        // two half circles of radius 2 (bulge 1 = 180°): a full ring around (2, 2)
        const o = g.get(0x6f)!;
        expect(o.strokes[0].length).toBeGreaterThan(8);
        for (const p of o.strokes[0]) expect(Math.hypot(p.x - 140, p.y - 140)).toBeCloseTo(140, 3);
        expect(g.get(0xd8)!.strokes).toHaveLength(2);
        expect(g.get(0x20)!.advance).toBeCloseTo(280, 6);
    });
});

describe("bundled single-line fonts", () => {
    test("every font loads, lays out open strokes, and writes Russian (its own or its fallback's)", async () => {
        for (const info of STROKE_FONTS) {
            const font = await loadStrokeFont(info.id);
            expect(font, info.id).toBeDefined();
            expect(isStrokeFont(font)).toBe(true);
            for (const c of `AZaz09${RUSSIAN}`)
                expect(font!.glyph(c.codePointAt(0)!), `${info.id} ${c}`).toBeDefined();
            const paths = textPaths(text(info.id, "Привет World"), font!);
            expect(paths.length).toBeGreaterThan(10);
            // strokes are open; only a stroke that returns to its start (an O) is a loop
            expect(paths.filter((p) => !p.closed).length).toBeGreaterThan(paths.length / 2);
        }
    });

    test("Hershey Serif's Cyrillic: the right glyphs on the right letters", async () => {
        const font = (await loadStrokeFont("hershey-serif"))!;
        const strokes = (c: string) => font.strokeGlyph(c.codePointAt(0)!)!.strokes.length;
        // Й is И with a breve, Ё is Е with two dots
        expect(strokes("Й")).toBe(strokes("И") + 1);
        expect(strokes("Ё")).toBe(strokes("Е") + 2);
        // Ж is wider than Г; capitals are cap height, lower case lower
        const box = (c: string) => pathsBounds(textPaths(text("hershey-serif", c), font));
        const wide = (c: string) => box(c).maxX - box(c).minX;
        expect(wide("Ж")).toBeGreaterThan(wide("Г") * 1.4);
        expect(box("П").maxY).toBeCloseTo(7, 1);
        expect(box("п").maxY).toBeLessThan(5.5);
        // the breve and dots stand above the letter
        expect(box("Й").maxY).toBeGreaterThan(box("И").maxY + 0.5);
        // э is lower case, not the capital the file has in its place
        expect(box("э").maxY).toBeLessThan(box("Э").maxY * 0.75);
    });

    test("GOST: capitals 7 mm at 10 mm, a mixed line as wide as its parts", async () => {
        const font = (await loadStrokeFont("gost-b"))!;
        const b = pathsBounds(textPaths(text("gost-b", "Н"), font));
        expect(b.maxY).toBeCloseTo(7, 1);
        const width = (s: string) => {
            const p = pathsBounds(textPaths(text("gost-b", s), font));
            return p.maxX - p.minX;
        };
        const whole = width("Привет World");
        expect(whole).toBeGreaterThan(width("Привет") + width("World"));
        expect(whole).toBeLessThan(width("Привет") + width("World") + 10);
    });

    test("Hershey Sans takes the Russian letters from GOST at the same cap height", async () => {
        const font = (await loadStrokeFont("hershey-sans"))!;
        const h = pathsBounds(textPaths(text("hershey-sans", "H"), font));
        const sh = pathsBounds(textPaths(text("hershey-sans", "Ш"), font));
        expect(sh.maxY).toBeCloseTo(h.maxY, 0);
    });
});

describe("open strokes through the job", () => {
    async function strokeJob(): Promise<LaserJobData> {
        const font = await loadStrokeFont("hershey-sans");
        const o = shapeObject(text("hershey-sans", "L"), "L", { centre: { x: 0, y: 0 } }, font)!;
        o.op = defaultOperation("line");
        return { version: 1, origin: "center", objects: [o] };
    }

    test("G-code traces each stroke once and does not close it", async () => {
        const job = await strokeJob();
        const profile = {
            ...defaultMachineProfile(),
            origin: "center" as const,
            bedWidth: 200,
            bedHeight: 200,
        };
        const { lines } = generateGcode(job, profile);
        // "L" in Hershey Sans: two strokes (a vertical and the foot), one cut per segment
        const cuts = lines.filter((l) => /^G1 /.test(l) && /[XY]/.test(l));
        const o = job.objects[0];
        const segments = o.kind === "vector" ? o.paths.reduce((n, p) => n + p.points.length - 1, 0) : 0;
        expect(cuts.length).toBe(segments);
    });

    test("the galvo list marks each stroke's segments, no closing one", async () => {
        const job = await strokeJob();
        const profile = {
            ...defaultMachineProfile(),
            controller: "jcz" as const,
            origin: "center" as const,
            bedWidth: 150,
            bedHeight: 150,
        };
        const program = jczProgram(job, profile, new Map());
        const marks = program.commands.filter((c) => c[0] === List.MarkTo).length;
        const o = job.objects[0];
        const segments = o.kind === "vector" ? o.paths.reduce((n, p) => n + p.points.length - 1, 0) : 0;
        expect(marks).toBe(segments);
    });

    test("converted to curves, the letters stay open paths", async () => {
        const font = await loadStrokeFont("gost-a");
        const o = shapeObject(text("gost-a", "Г"), "Г", { centre: { x: 0, y: 0 } }, font)!;
        expect(convertToPath(o)).toBe(true);
        expect(o.shape?.type).toBe("path");
        if (o.shape?.type === "path") expect(o.shape.subpaths.every((s) => !s.closed)).toBe(true);
        expect(o.paths.every((p) => !p.closed)).toBe(true);
    });
});

// A sample sheet of every font, as polylines in mm, when KERN3D_FONT_SHEET names a folder
const sheet = process.env["KERN3D_FONT_SHEET"];
describe.skipIf(!sheet)("sample sheet", () => {
    test("writes each font's sample", async () => {
        for (const info of STROKE_FONTS) {
            const font = (await loadStrokeFont(info.id))!;
            const sample = [
                info.family,
                "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
                "abcdefghijklmnopqrstuvwxyz 0123456789",
                "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ",
                "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
                "Привет World! №1 (тест) 3,14",
            ].join("\n");
            const paths = textPaths(text(info.id, sample, { lineSpacing: 1.5 }), font);
            writeFileSync(
                `${sheet}/${info.id}.json`,
                JSON.stringify(paths.map((p) => (p.closed ? [...p.points, p.points[0]] : p.points))),
            );
        }
    });
});
