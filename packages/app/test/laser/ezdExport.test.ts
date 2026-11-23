// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    crc16x25,
    EZD_PEN_COLORS,
    exportEzd,
    huffmanLengths,
    packVectors,
    utf16Field,
} from "../../src/laser/ezdExport";
import { EzdReader, huffmanDecode, importEzd, readEzdFile, readStruct } from "../../src/laser/ezdImport";
import { type LaserPath, type Pt, transformPaths } from "../../src/laser/geometry";
import {
    defaultOperation,
    type LaserJobData,
    type LaserObject,
    type LaserVectorObject,
    objectMatrix,
} from "../../src/laser/laserData";
import { defaultMachineProfile, type MachineProfile } from "../../src/laser/machineProfile";
import { shapeObject } from "../../src/laser/shapeObject";
import type { LaserShape } from "../../src/laser/shapes";
import { loadStrokeFont } from "../../src/laser/strokeFonts";

const dir = process.env["KERN3D_EZD_DIR"];
const outDir = process.env["KERN3D_EZD_OUT"];

function jczProfile(origin: "center" | "corner" = "center"): MachineProfile {
    return { ...defaultMachineProfile(), controller: "jcz", origin, bedWidth: 110, bedHeight: 110 };
}

function vector(name: string, paths: LaserPath[], extra: Partial<LaserVectorObject> = {}): LaserVectorObject {
    return {
        id: name,
        name,
        kind: "vector",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        angle: 0,
        lockAspect: true,
        paths,
        sourceWidth: 10,
        sourceHeight: 10,
        op: { ...defaultOperation("line"), power: 70, speed: 300 * 60, frequency: 40, passes: 2 },
        ...extra,
    };
}

const square: LaserPath = {
    closed: true,
    points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
    ],
};
const stroke: LaserPath = {
    closed: false,
    points: [
        { x: 0, y: 0 },
        { x: 5, y: 7 },
        { x: 10, y: 2 },
    ],
};

/** Every outline of an object on the bed. */
const worldPaths = (o: LaserObject) => (o.kind === "vector" ? transformPaths(o.paths, objectMatrix(o)) : []);

function expectSamePaths(a: LaserPath[], b: LaserPath[]) {
    expect(b.map((p) => [p.closed, p.points.length])).toEqual(a.map((p) => [p.closed, p.points.length]));
    let worst = 0;
    for (const [i, path] of a.entries()) {
        for (const [k, p] of path.points.entries()) {
            worst = Math.max(worst, Math.abs(b[i].points[k].x - p.x), Math.abs(b[i].points[k].y - p.y));
        }
    }
    expect(worst).toBeLessThan(1e-3);
}

/** The operation fields EzCAD keeps; an empty JCZ pen name comes back as EzCAD's "Default". */
function opSummary(o: LaserObject) {
    const op = o.op;
    return {
        mode: op.mode,
        power: op.power,
        speed: Math.round(op.speed * 1e6) / 1e6,
        passes: op.passes,
        frequency: op.frequency,
        pen: op.pen === "" ? "Default" : op.pen,
        fill:
            op.mode === "fill"
                ? [op.fillInterval, Math.round(((((op.fillAngle + o.angle) % 180) + 180) % 180) * 1e6) / 1e6]
                : [],
    };
}

function expectSameJob(a: readonly LaserObject[], b: readonly LaserObject[]) {
    expect(b.map((o) => o.name)).toEqual(a.map((o) => o.name));
    expect(b.map(opSummary)).toEqual(a.map(opSummary));
    for (const [i, o] of a.entries()) expectSamePaths(worldPaths(o), worldPaths(b[i]));
}

describe("EZD export primitives", () => {
    test("CRC-16/X-25 of the check string", () => {
        expect(crc16x25(new TextEncoder().encode("123456789"))).toBe(0x906e);
    });

    test("names as UTF-16 with their NUL; an empty one is the NUL alone", () => {
        expect([...utf16Field("Ab")]).toEqual([0x41, 0, 0x62, 0, 0, 0]);
        expect([...utf16Field("")]).toEqual([0, 0]);
    });

    test("Huffman lengths cover all 256 bytes and stay within the limit", () => {
        const data = new Uint8Array(100_000);
        for (let i = 0; i < data.length; i++) data[i] = i % 7 === 0 ? i & 0xff : 0;
        const lengths = huffmanLengths(data, 12);
        expect(lengths).toHaveLength(256);
        expect(Math.min(...lengths)).toBeGreaterThan(0);
        expect(Math.max(...lengths)).toBeLessThanOrEqual(12);
        // a prefix code: Kraft's sum is at most 1
        expect(lengths.reduce((s, l) => s + 2 ** -l, 0)).toBeLessThanOrEqual(1 + 1e-12);
    });

    test("the packed section unpacks again, with EzCAD's counts and checksums", () => {
        const stream = new TextEncoder().encode("EZCAD EZCAD curves and hatches, 0123456789".repeat(50));
        const section = packVectors(stream, 1000);
        const r = new EzdReader(section);
        const [length, crc, packed, tableAt] = [r.u32(), r.u32(), r.u32(), r.u32()];
        expect(length).toBe(stream.length);
        expect(crc).toBe(crc16x25(stream));
        expect(tableAt).toBe(1020);
        expect(r.u32()).toBe(crc16x25(section.subarray(0, 16)));
        expect(section.length - 22 - 256 * 7).toBe(packed);
        expect(huffmanDecode(r, length)).toEqual(stream);
    });
});

describe("EZD export", () => {
    const job = (): LaserJobData => ({
        version: 1,
        origin: "center",
        objects: [
            vector("square", [square], { x: -20, y: 5 }),
            vector("stroke", [stroke], { x: 3, y: -12, width: 20, height: 10, angle: 30 }),
            vector("two", [square, stroke], {
                x: 10,
                y: 10,
                op: {
                    ...defaultOperation("fill"),
                    fillInterval: 0.05,
                    fillAngle: 200,
                    power: 55,
                    speed: 600,
                },
                angle: 15,
            }),
        ],
    });

    test("round trip: the import reads back the same outlines, operations and hatch", () => {
        const out = exportEzd(job(), jczProfile());
        expect(out.warnings).toEqual([]);
        expect(out.written).toBe(3);
        const back = importEzd(out.bytes);
        expect(back).not.toBeUndefined();
        const r = back as NonNullable<typeof back>;
        expect(r.warnings).toEqual([]);
        expectSameJob(job().objects, r.objects);
        expect(r.objectPens).toEqual([0, 0, 1]);
        // two single curves, and a hatch around a group of two (its cached lines are not counted)
        expect(r.counts).toEqual({ curve: 4, group: 1, hatch: 1 });
    });

    test("a hatch with «обвести контур» keeps it both ways", () => {
        const j = job();
        const fill = j.objects.find((o) => o.op.mode === "fill")!;
        fill.op.fillOutline = true;
        const back = importEzd(exportEzd(j, jczProfile()).bytes)!;
        const read = back.objects.find((o) => o.op.mode === "fill")!;
        expect(read.op.fillOutline).toBe(true);
        expect(back.warnings).toEqual([]);
    });

    test("a corner-origin job lands at the same place on the field", () => {
        const corner = job();
        corner.origin = "corner";
        for (const o of corner.objects) o.x += 55;
        for (const o of corner.objects) o.y += 55;
        const r = importEzd(exportEzd(corner, jczProfile("corner")).bytes);
        expectSameJob(job().objects, r?.objects ?? []);
    });

    test("pictures, hidden and empty objects are left out and reported", () => {
        const j = job();
        j.objects[0].hidden = true;
        j.objects.push(vector("blank", []), {
            ...vector("pic", []),
            kind: "image",
            dataUrl: "data:,",
            pixelWidth: 1,
            pixelHeight: 1,
        } as LaserObject);
        const out = exportEzd(j, jczProfile());
        expect(out.written).toBe(2);
        expect(out.warnings).toEqual([
            "hidden-object-skipped:square",
            "empty-object-skipped:blank",
            "image-skipped:pic",
        ]);
    });

    test("file structure: header, seek table, 256 pens with EzCAD's colours and our settings", () => {
        const bytes = exportEzd(job(), jczProfile()).bytes;
        const file = readEzdFile(bytes);
        expect(file?.warnings).toEqual([]);
        expect(file?.pens).toHaveLength(256);
        expect(file?.pens[0]).toMatchObject({
            power: 70,
            speed: 300,
            frequency: 40,
            passes: 2,
            color: "#000000",
        });
        expect(file?.pens[1]).toMatchObject({ power: 55, speed: 10, passes: 1 });
        expect(file?.pens[2]).toMatchObject({ power: 80, speed: 1000, frequency: 200 });
        const v = new DataView(bytes.buffer, bytes.byteOffset);
        const seek = [0, 1, 2, 3, 4, 5, 6].map((i) => v.getInt32(344 + 4 * i, true));
        expect(seek).toEqual([468, 0, 160496, 160492, 0, seek[6] + 400, seek[5] - 400]);
        expect(v.getInt32(160496, true)).toBe(256);
        expect(v.getInt32(160500, true)).toBe(160504);
        // every pen record has EzCAD's 61 fields; the unused ones carry its palette
        const r = new EzdReader(bytes);
        r.pos = 160504;
        for (let i = 0; i < 256; i++) {
            const f = readStruct(r);
            expect(f).toHaveLength(61);
            if (i >= 2)
                expect(new DataView(f[0].buffer, f[0].byteOffset).getInt32(0, true)).toBe(
                    EZD_PEN_COLORS[i] ?? 0,
                );
        }
        expect(r.pos).toBe(seek[6]);
    });
});

describe("EZD export of drawn figures", () => {
    test("rectangle, circle, single-line text and a filled QR code round-trip", async () => {
        const font = await loadStrokeFont("gost-b");
        const shapes: [LaserShape, string, Pt, "line" | "fill"][] = [
            [{ type: "rect", width: 40, height: 25, radius: 3 }, "rect", { x: -25, y: 15 }, "line"],
            [{ type: "ellipse", rx: 12, ry: 12 }, "circle", { x: 25, y: 15 }, "line"],
            [
                {
                    type: "text",
                    text: "Kern3D ТЕСТ",
                    font: { family: "ГОСТ тип Б", stroke: "gost-b" },
                    size: 8,
                    letterSpacing: 0,
                    lineSpacing: 1.2,
                    align: "center",
                    arcRadius: 0,
                },
                "text",
                { x: 0, y: -5 },
                "line",
            ],
            [
                {
                    type: "barcode",
                    format: "qr",
                    data: "https://genesishpa.github.io/kern3d",
                    level: "M",
                    module: 0.5,
                    quiet: 0,
                    barHeight: 15,
                    showText: false,
                    invert: false,
                },
                "QR",
                { x: 0, y: -25 },
                "fill",
            ],
        ];
        const objects = shapes.map(([shape, name, centre, mode]) => {
            const o = shapeObject(shape, name, { centre }, font);
            expect(o).not.toBeUndefined();
            const v = o as LaserVectorObject;
            v.op = {
                ...defaultOperation(mode),
                power: 60,
                speed: 500 * 60,
                frequency: 30,
                fillInterval: 0.05,
                fillAngle: 45,
            };
            return v;
        });
        const out = exportEzd({ version: 1, origin: "center", objects }, jczProfile());
        expect(out.warnings).toEqual([]);
        if (outDir !== undefined) writeFileSync(join(outDir, "drawn.kern3d.ezd"), out.bytes);
        const back = importEzd(out.bytes);
        expect(back?.warnings).toEqual([]);
        expectSameJob(objects, back?.objects ?? []);
        // the stroke font's letters stay open lines
        const text = back?.objects[2];
        expect(text?.kind === "vector" && text.paths.some((p) => !p.closed)).toBe(true);
    });
});

// ---- against the user's EzCAD files, when KERN3D_EZD_DIR names a folder of them --------------------

describe.skipIf(!dir)("EZD export against real files (KERN3D_EZD_DIR)", () => {
    const files = dir === undefined ? [] : readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".ezd"));

    test.each(files)("%s: re-exported, it imports the same", (name) => {
        const original = new Uint8Array(readFileSync(join(dir as string, name)));
        const first = importEzd(original);
        expect(first).not.toBeUndefined();
        const objects = (first as NonNullable<typeof first>).objects.filter(
            (o) => o.kind !== "vector" || o.paths.length > 0,
        );
        const out = exportEzd({ version: 1, origin: "center", objects }, jczProfile());
        if (outDir !== undefined)
            writeFileSync(join(outDir, name.replace(/\.ezd$/i, ".kern3d.ezd")), out.bytes);
        const again = importEzd(out.bytes);
        expect(again?.warnings).toEqual([]);
        expectSameJob(objects, again?.objects ?? []);

        // what EzCAD wrote and we write agree byte for byte up to the pen records
        expect(out.bytes.subarray(0, 344)).toEqual(original.subarray(0, 344));
        const theirs = readEzdFile(original);
        const ours = readEzdFile(out.bytes);
        expect(ours?.pens.slice(2)).toEqual(theirs?.pens.slice(2));
    });

    test.each(files)("%s: EzCAD's own stream re-packed has its header and size exactly", (name) => {
        const original = new Uint8Array(readFileSync(join(dir as string, name)));
        const at = new DataView(original.buffer, original.byteOffset).getInt32(344 + 20, true);
        const r = new EzdReader(original);
        r.pos = at;
        const length = r.u32();
        r.take(16);
        const section = packVectors(huffmanDecode(r, length), at);
        // same code lengths, so the same bit count; only the codes' order may differ
        expect(section.length).toBe(original.length - at);
        expect(section.subarray(0, 20)).toEqual(original.subarray(at, at + 20));
    });
});
