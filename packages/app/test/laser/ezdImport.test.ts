// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    EzdReader,
    ezdAsSvgImport,
    huffmanDecode,
    importEzd,
    matrix,
    num,
    point,
    readObjects,
    readStruct,
    roundedRect,
    text,
    utf16,
} from "../../src/laser/ezdImport";
import { pathsBounds } from "../../src/laser/geometry";

/** A little-endian byte builder for synthetic .ezd pieces. */
class Bytes {
    private parts: number[] = [];
    u8(v: number) {
        this.parts.push(v & 0xff);
        return this;
    }
    u16(v: number) {
        return this.u8(v).u8(v >> 8);
    }
    i32(v: number) {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setInt32(0, v, true);
        return this.raw(b);
    }
    u32(v: number) {
        return this.i32(v | 0);
    }
    f64(v: number) {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setFloat64(0, v, true);
        return this.raw(b);
    }
    raw(b: Uint8Array | number[]) {
        this.parts.push(...b);
        return this;
    }
    get bytes() {
        return new Uint8Array(this.parts);
    }
}

const i32f = (v: number) => new Bytes().i32(v).bytes;
const f64f = (...v: number[]) => {
    const b = new Bytes();
    for (const x of v) b.f64(x);
    return b.bytes;
};
const strf = (s: string, size = 60) => {
    const b = new Uint8Array(size);
    for (let i = 0; i < s.length; i++) b[2 * i] = s.charCodeAt(i);
    return b;
};

function struct(fields: Uint8Array[]): Uint8Array {
    const b = new Bytes().i32(fields.length);
    for (const f of fields) b.i32(f.length).raw(f);
    return b.bytes;
}

/** The 15-field object header: pen, type, state, label, …, position, z. */
function header(pen: number, label: string, state = 0): Uint8Array {
    const f = [i32f(pen), i32f(0), i32f(state), strf(label)];
    for (let i = 4; i < 13; i++) f.push(i32f(0));
    f.push(f64f(0, 0), f64f(0));
    return struct(f);
}

const IDENTITY9 = f64f(1, 0, 0, 0, 1, 0, 0, 0, 1);

describe("EZD primitives", () => {
    test("a struct of length-prefixed fields read by size", () => {
        const s = struct([
            new Bytes().u16(7).bytes,
            i32f(-3),
            f64f(2.5),
            f64f(1, 2),
            strf("Pen 1"),
            IDENTITY9,
        ]);
        const fields = readStruct(new EzdReader(s));
        expect(fields.map((f) => f.length)).toEqual([2, 4, 8, 16, 60, 72]);
        expect(num(fields, 0)).toBe(7);
        expect(num(fields, 1)).toBe(-3);
        expect(num(fields, 2)).toBe(2.5);
        expect(point(fields, 3)).toEqual({ x: 1, y: 2 });
        expect(text(fields, 4)).toBe("Pen 1");
        expect(matrix(fields, 5)).toEqual([1, 0, 0, 1, 0, 0]);
        expect(num(fields, 9, 42)).toBe(42);
    });

    test("a length running past the data is an error, not a silent read", () => {
        const bad = new Bytes().i32(1).i32(100).raw([1, 2, 3]).bytes;
        expect(() => readStruct(new EzdReader(bad))).toThrow(RangeError);
    });

    test("UTF-16 stops at the first NUL", () => {
        expect(utf16(strf("EZCADUNI", 16))).toBe("EZCADUNI");
        expect(utf16(new Uint8Array([0x41, 0, 0x04, 0x04, 0, 0, 0x42, 0]))).toBe("AЄ");
    });

    test("Huffman: codes MSB first from the low bits of each entry", () => {
        // A = 0, B = 10, C = 11; "ABCA" = 0 10 11 0 → 0b01011000
        const table = new Bytes().u16(3);
        table.u8(0x41).i32(0b0).u16(1);
        table.u8(0x42).i32(0b10).u16(2);
        table.u8(0x43).i32(0b11).u16(2);
        table.u8(0b01011000);
        const out = huffmanDecode(new EzdReader(table.bytes), 4);
        expect(String.fromCharCode(...out)).toBe("ABCA");
    });

    test("a rounded rectangle stays inside its box and loses its corners", () => {
        const path = roundedRect({ x: 0, y: 0 }, { x: 10, y: 6 }, [1, 1, 1, 1], 0.01);
        const b = pathsBounds([path]);
        expect(b.minX).toBeCloseTo(0);
        expect(b.maxX).toBeCloseTo(10);
        expect(b.maxY).toBeCloseTo(6);
        expect(path.points.some((p) => p.x < 0.01 && p.y < 0.01)).toBe(false);
        expect(path.closed).toBe(true);
    });
});

describe("EZD object stream", () => {
    function curve(pen: number, label: string): Uint8Array {
        const b = new Bytes().i32(1).raw(header(pen, label));
        b.u32(2).u32(1); // two runs, closed
        b.u8(0).u8(1).u16(0).u16(0).i32(3).f64(0).f64(0).f64(10).f64(0).f64(10).f64(10); // a line run
        b.u8(0).u8(3).u16(0).u16(0).i32(4).f64(10).f64(10).f64(6).f64(14).f64(2).f64(14).f64(0).f64(10);
        return b.bytes;
    }
    const rect = () =>
        new Bytes()
            .i32(3)
            .raw(header(2, "box"))
            .raw(struct([f64f(-5, -5), f64f(5, 5), f64f(0), f64f(0), f64f(0), f64f(0), i32f(0), IDENTITY9]))
            .bytes;

    test("curves with line and cubic runs, a rectangle, a group, terminators between sections", () => {
        const group = new Bytes().i32(0x10).raw(header(0, "g")).i32(2).raw(curve(1, "c")).raw(rect()).bytes;
        const stream = new Bytes().raw(curve(1, "lone")).i32(0).raw(group).i32(0).bytes;
        const warnings: string[] = [];
        const objects = readObjects(stream, warnings);
        expect(warnings).toEqual([]);
        expect(objects.map((o) => o.kind)).toEqual(["curve", "group"]);
        const c = objects[0];
        expect(c.label).toBe("lone");
        expect(c.paths).toHaveLength(1);
        const b = pathsBounds(c.paths);
        expect(b.maxX).toBeCloseTo(10);
        expect(b.maxY).toBeGreaterThan(12);
        expect(objects[1].children.map((o) => o.kind)).toEqual(["curve", "rect"]);
        expect(pathsBounds(objects[1].children[1].paths)).toEqual({ minX: -5, minY: -5, maxX: 5, maxY: 5 });
    });

    test("garbage between objects is skipped to the next object header", () => {
        const stream = new Bytes().raw([9, 9, 9, 9, 9, 9, 9]).raw(rect()).bytes;
        const warnings: string[] = [];
        const objects = readObjects(stream, warnings);
        expect(objects.map((o) => o.kind)).toEqual(["rect"]);
        expect(warnings[0]).toMatch(/^unknown-object-type/);
    });
});

/** A whole .ezd: header, seek table, one pen, and the stream packed with an identity Huffman table. */
function ezdFile(stream: Uint8Array): Uint8Array {
    const pen = struct([
        i32f(0x0000ff), // BGR: red
        strf("Mark"),
        i32f(1),
        i32f(0),
        i32f(2), // passes
        f64f(500), // mm/s
        f64f(65), // %
        i32f(30000), // Hz
        i32f(0),
        i32f(100),
        i32f(200),
        i32f(10),
    ]);
    const pensAt = 344 + 28 + 96;
    const vectorsAt = pensAt + 8 + pen.length;
    const b = new Bytes()
        .raw(strf("EZCADUNI", 16))
        .i32(0)
        .i32(2001)
        .raw(new Uint8Array(180 + 140));
    b.i32(0).i32(0).i32(pensAt).i32(0).i32(0).i32(vectorsAt).i32(0).raw(new Uint8Array(96));
    b.i32(1)
        .i32(pensAt + 8)
        .raw(pen);
    b.u32(stream.length).raw(new Uint8Array(16)).u16(256);
    for (let c = 0; c < 256; c++) b.u8(c).i32(c).u16(8);
    return b.raw(stream).bytes;
}

describe("EZD import", () => {
    const square = () => {
        const b = new Bytes().i32(1).raw(header(0, "sq"));
        b.u32(1).u32(1).u8(0).u8(1).u16(0).u16(0).i32(4);
        for (const [x, y] of [
            [10, 10],
            [20, 10],
            [20, 20],
            [10, 20],
        ])
            b.f64(x).f64(y);
        return b.bytes;
    };
    function hatch(): Uint8Array {
        const f: Uint8Array[] = [];
        for (let i = 0; i < 54; i++) f.push(i32f(0));
        f[1] = i32f(1);
        f[5] = f64f(0.05);
        f[8] = f64f(405);
        f[18] = f64f(45);
        return new Bytes().i32(0x20).raw(header(0, "h")).i32(1).raw(square()).raw(struct(f)).bytes;
    }

    test("not an .ezd", () => {
        expect(importEzd(new Uint8Array(1000))).toBeUndefined();
    });

    test("a hatch becomes a fill object with the pen's settings, placed from the field centre", () => {
        const r = importEzd(ezdFile(new Bytes().raw(hatch()).i32(0).bytes));
        expect(r).not.toBeUndefined();
        const { objects, pens, objectPens, warnings } = r as NonNullable<typeof r>;
        expect(pens[0]).toMatchObject({
            name: "Mark",
            color: "#ff0000",
            speed: 500,
            power: 65,
            frequency: 30,
        });
        expect(objects).toHaveLength(1);
        const o = objects[0];
        expect(o.kind).toBe("vector");
        expect([o.x, o.y, o.width, o.height]).toEqual([10, 10, 10, 10]);
        expect(o.op).toMatchObject({
            mode: "fill",
            power: 65,
            speed: 30000,
            passes: 2,
            frequency: 30,
            pen: "Mark",
        });
        expect(o.op.fillInterval).toBe(0.05);
        expect(o.op.fillAngle).toBe(45);
        expect(objectPens).toEqual([0]);
        expect(warnings).toEqual(["hatch-auto-rotate-ignored:h"]);
    });

    test("a text followed by its hatch at the same place takes the hatch's glyph outlines", () => {
        const f: Uint8Array[] = [];
        for (let i = 0; i < 20; i++) f.push(i32f(0));
        f[1] = f64f(5);
        f[10] = strf("AB");
        const textObj = new Bytes().i32(0x800).raw(header(0, "")).raw(struct(f)).i32(0).i32(0).bytes;
        const r = importEzd(ezdFile(new Bytes().raw(textObj).raw(hatch()).bytes));
        expect(r?.objects.map((o) => [o.name, o.op.mode])).toEqual([["text: AB", "fill"]]);
        expect(r?.warnings.some((w) => w.startsWith("text-without-outline"))).toBe(false);
    });

    test("a lone text has no outline: an empty placeholder and a warning", () => {
        const f: Uint8Array[] = [];
        for (let i = 0; i < 20; i++) f.push(i32f(0));
        f[1] = f64f(5);
        f[10] = strf("AB");
        const textObj = new Bytes().i32(0x800).raw(header(0, "")).raw(struct(f)).i32(0).i32(0).bytes;
        const r = importEzd(ezdFile(textObj));
        const o = r?.objects[0];
        expect(o?.kind === "vector" ? o.paths : undefined).toEqual([]);
        expect(o?.height).toBe(5);
        expect(r?.warnings).toEqual(["text-without-outline:AB"]);
    });

    test("control objects are skipped and reported", () => {
        const timer = new Bytes()
            .i32(0x2000)
            .raw(header(0, "wait"))
            .raw(struct([i32f(0), i32f(500)])).bytes;
        const r = importEzd(ezdFile(new Bytes().raw(timer).raw(square()).bytes));
        expect(r?.objects.map((o) => o.name)).toEqual(["sq"]);
        expect(r?.warnings).toEqual(["control-object-skipped:timer"]);
        expect(r?.counts).toEqual({ timer: 1, curve: 1 });
    });
});

// ---- the user's own EzCAD files, when KERN3D_EZD_DIR names a folder of them -------------------

const dir = process.env["KERN3D_EZD_DIR"];
const svgDir = process.env["KERN3D_EZD_SVG"];

function svgOf(imported: NonNullable<ReturnType<typeof importEzd>>): string {
    const flat = ezdAsSvgImport(imported);
    const w = flat?.width ?? 1;
    const h = flat?.height ?? 1;
    const d = (flat?.paths ?? [])
        .map(
            (p) =>
                `M${p.points.map((q) => `${q.x.toFixed(3)} ${(h - q.y).toFixed(3)}`).join("L")}${p.closed ? "Z" : ""}`,
        )
        .join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 ${w + 2} ${h + 2}" width="800"><rect x="-1" y="-1" width="${w + 2}" height="${h + 2}" fill="white"/><path d="${d}" fill="none" stroke="black" stroke-width="${Math.max(w, h) / 800}"/></svg>`;
}

describe.skipIf(!dir)("EZD real files (KERN3D_EZD_DIR)", () => {
    const files = dir === undefined ? [] : readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".ezd"));

    test.each(files)("%s", (name) => {
        const bytes = readFileSync(join(dir as string, name));
        const imported = importEzd(new Uint8Array(bytes));
        expect(imported).not.toBeUndefined();
        const r = imported as NonNullable<typeof imported>;
        const usedPens = [...new Set(r.objectPens)].filter((i) => i >= 0);
        const report = {
            file: name,
            counts: r.counts,
            objects: r.objects.map((o, i) => ({
                name: o.name,
                kind: o.kind,
                mode: o.op.mode,
                pen: r.objectPens[i],
                paths: o.kind === "vector" ? o.paths.length : 0,
                box: [o.x, o.y, o.width, o.height].map((v) => +v.toFixed(2)),
                fill: o.op.mode === "fill" ? [o.op.fillInterval, o.op.fillAngle] : undefined,
            })),
            bounds: Object.values(r.bounds).map((v) => +v.toFixed(2)),
            pens: usedPens.map((i) => {
                const p = r.pens[i];
                return {
                    i,
                    name: p.name,
                    power: p.power,
                    speed: p.speed,
                    freq: p.frequency,
                    passes: p.passes,
                };
            }),
            penCount: r.pens.length,
            warnings: r.warnings,
        };
        expect(r.objectPens).toHaveLength(r.objects.length);
        console.log(JSON.stringify(report));
        if (svgDir !== undefined) {
            writeFileSync(join(svgDir, `${name}.svg`), svgOf(r));
            writeFileSync(join(svgDir, `${name}.json`), JSON.stringify(report, null, 1));
        }
        expect(r.objects.length).toBeGreaterThan(0);
    });
});
