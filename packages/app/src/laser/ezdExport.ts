// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.
//
// Writing EzCAD 2 project files (.ezd). The layout is the one `ezdImport.ts` reads (after
// MeerK40t's MIT-licensed `meerk40t/extra/ezd.py`); what that source leaves open was taken from
// files EzCAD 2.14.10 itself wrote: the section order, the pen and hatch records (copied
// byte for byte below and patched only in the fields we know), the bottom-up 200×200 preview,
// and the two checksums of the vector section — CRC-16/X-25 of the unpacked object stream and
// of the section's first 16 bytes.

import { type Bounds, isEmpty, type LaserPath, type Pt, pathsBounds, transformPaths } from "./geometry";
import { hatchPaths } from "./hatch";
import { penOf } from "./jczProgram";
import {
    type LaserJobData,
    type LaserObject,
    type LaserOperation,
    objectMatrix,
    withOrigin,
} from "./laserData";
import type { MachineProfile } from "./machineProfile";

// ---- bytes ----------------------------------------------------------------------------------------

/** A little-endian byte builder. */
export class EzdWriter {
    private buf = new Uint8Array(1 << 16);
    private view = new DataView(this.buf.buffer);
    length = 0;

    private room(n: number) {
        if (this.length + n <= this.buf.length) return;
        let size = this.buf.length * 2;
        while (size < this.length + n) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.buf.subarray(0, this.length));
        this.buf = next;
        this.view = new DataView(next.buffer);
    }

    u8(v: number) {
        this.room(1);
        this.buf[this.length++] = v & 0xff;
        return this;
    }

    u16(v: number) {
        this.room(2);
        this.view.setUint16(this.length, v, true);
        this.length += 2;
        return this;
    }

    i32(v: number) {
        this.room(4);
        this.view.setInt32(this.length, v, true);
        this.length += 4;
        return this;
    }

    u32(v: number) {
        this.room(4);
        this.view.setUint32(this.length, v >>> 0, true);
        this.length += 4;
        return this;
    }

    f64(v: number) {
        this.room(8);
        this.view.setFloat64(this.length, v, true);
        this.length += 8;
        return this;
    }

    raw(bytes: Uint8Array) {
        this.room(bytes.length);
        this.buf.set(bytes, this.length);
        this.length += bytes.length;
        return this;
    }

    /** EzCAD's record: a count, then (length, bytes) per field. */
    struct(fields: readonly Uint8Array[]) {
        this.i32(fields.length);
        for (const f of fields) this.i32(f.length).raw(f);
        return this;
    }

    setU32(at: number, v: number) {
        this.view.setUint32(at, v >>> 0, true);
    }

    get bytes(): Uint8Array<ArrayBuffer> {
        return this.buf.slice(0, this.length);
    }
}

const fieldOf = (write: (w: EzdWriter) => void) => {
    const w = new EzdWriter();
    write(w);
    return w.bytes;
};
export const i32Field = (v: number) => fieldOf((w) => w.i32(Math.round(v)));
export const u16Field = (v: number) => fieldOf((w) => w.u16(v));
export const f64Field = (v: number) => fieldOf((w) => w.f64(v));
export const pointField = (p: Pt) => fieldOf((w) => w.f64(p.x).f64(p.y));

/** UTF-16LE with its terminating NUL, as EzCAD stores a name (an empty one is the NUL alone). */
export function utf16Field(text: string): Uint8Array {
    return fieldOf((w) => {
        for (let i = 0; i < text.length; i++) w.u16(text.charCodeAt(i));
        w.u16(0);
    });
}

function base64Bytes(b64: string): Uint8Array {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

function splitStruct(bytes: Uint8Array): Uint8Array[] {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = v.getInt32(0, true);
    const out: Uint8Array[] = [];
    let p = 4;
    for (let i = 0; i < count; i++) {
        const n = v.getInt32(p, true);
        out.push(bytes.slice(p + 4, p + 4 + n));
        p += 4 + n;
    }
    return out;
}

// ---- checksums and packing ----------------------------------------------------------------------

/** CRC-16/X-25 (reflected 0x1021, init and final xor 0xFFFF): EzCAD's vector-section checksum. */
export function crc16x25(bytes: Uint8Array): number {
    let c = 0xffff;
    for (const b of bytes) {
        c ^= b;
        for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
    }
    return c ^ 0xffff;
}

/** Code lengths of a Huffman code over all 256 byte values (each counted once more, as EzCAD's tables cover them all). */
export function huffmanLengths(data: Uint8Array, maxLength = 16): number[] {
    const freq = new Array<number>(256).fill(1);
    for (const b of data) freq[b]++;
    // EzCAD's own tables never go past 11 bits: flatten the counts until the code fits
    for (;;) {
        const lengths = lengthsFor(freq);
        if (Math.max(...lengths) <= maxLength) return lengths;
        for (let i = 0; i < 256; i++) freq[i] = Math.ceil(freq[i] / 2);
    }
}

function lengthsFor(freq: readonly number[]): number[] {
    // nodes: leaves 0..255, then inner ones; parent links give each leaf's depth
    const weight = [...freq];
    const parent: number[] = new Array(511).fill(-1);
    let live = Array.from({ length: 256 }, (_, i) => i);
    while (live.length > 1) {
        live.sort((a, b) => weight[a] - weight[b] || a - b);
        const [a, b] = live;
        const n = weight.length;
        weight.push(weight[a] + weight[b]);
        parent[a] = n;
        parent[b] = n;
        live = [n, ...live.slice(2)];
    }
    return freq.map((_, leaf) => {
        let depth = 0;
        for (let n = leaf; parent[n] >= 0; n = parent[n]) depth++;
        return depth;
    });
}

/** Canonical codes for the lengths: shorter codes first, equal lengths in byte order. */
function canonicalCodes(lengths: readonly number[]): number[] {
    const order = lengths.map((len, b) => [len, b]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const codes = new Array<number>(256).fill(0);
    let code = 0;
    let prev = order[0][0];
    for (const [len, b] of order) {
        code <<= len - prev;
        prev = len;
        codes[b] = code;
        code++;
    }
    return codes;
}

/**
 * The vector section: uncompressed length, CRC of the stream, packed byte count, where the
 * table starts, CRC of those 16 bytes; then the 256-entry table and the bits, MSB first. EzCAD
 * counts the packed bytes as ⌊bits / 8⌋ + 1 (a whole last byte still gets a zero one after it).
 */
export function packVectors(stream: Uint8Array, sectionOffset: number): Uint8Array {
    const lengths = huffmanLengths(stream);
    const codes = canonicalCodes(lengths);
    const bits = new EzdWriter();
    let acc = 0;
    let n = 0;
    let total = 0;
    for (const b of stream) {
        const len = lengths[b];
        const code = codes[b];
        for (let k = len - 1; k >= 0; k--) {
            acc = (acc << 1) | ((code >>> k) & 1);
            if (++n === 8) {
                bits.u8(acc);
                acc = 0;
                n = 0;
            }
        }
        total += len;
    }
    if (n > 0) bits.u8(acc << (8 - n));
    else bits.u8(0);
    const packed = Math.floor(total / 8) + 1;
    const w = new EzdWriter();
    w.u32(stream.length)
        .u32(crc16x25(stream))
        .u32(packed)
        .u32(sectionOffset + 20);
    w.u32(crc16x25(w.bytes));
    w.u16(256);
    for (let b = 0; b < 256; b++) w.u8(b).u32(codes[b]).u16(lengths[b]);
    return w.raw(bits.bytes).bytes;
}

// ---- pens -----------------------------------------------------------------------------------------

// Pen 0 and pen 1 as EzCAD 2.14.10 saved them (61 fields each). A pen we set starts from pen 0
// (field 3 = 0; the untouched pens all have 1 there); the rest are pen 1 with EzCAD's colours.
const PEN_SET =
    "PQAAAAQAAAAAAAAAEAAAAEQAZQBmAGEAdQBsAHQAAAAEAAAAAAAAAAQAAAAAAAAABAAAAAEAAAAIAAAAAAAAAADAckAIAAAAAAAAAACAVkAEAAAAUMMAAAQAAAAGAAAABAAAAOz///8EAAAAyAAAAAQAAABkAAAACAAAAAAAAAAAQK9ABAAAAPoAAAAEAAAAXgEAAAgAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAgAAACamZmZmZm5PwgAAAAAAAAAAAAAAAgAAAAAAAAAAADwPwQAAAAAAAAABAAAAAEAAAAEAAAAMAAAAAQAAAC0AAAABAAAAAAAAAAIAAAAAAAAAAAAGEAEAAAAAAAAAAgAAAAAAAAAAADwPwgAAAAAAAAAAADgPwQAAAAAAAAABAAAAAEAAAAIAAAAexSuR+F6hD8IAAAAAAAAAAAA8D8EAAAAAQAAAAgAAAB7FK5H4XqUPwQAAABkAAAACAAAAAAAAAAAAOA/BAAAAPoAAAAEAAAAXgEAAAgAAAAAAAAAAABEQAQAAAAAAAAACAAAAAAAAAAAQFZABAAAAAAAAAAIAAAAAAAAAAAAWUAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAJEAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAEAAAAAAAAAAQAAAAAAAAA";
const PEN_UNSET =
    "PQAAAAQAAAAAAP8AEAAAAEQAZQBmAGEAdQBsAHQAAAAEAAAAAAAAAAQAAAABAAAABAAAAAEAAAAIAAAAAAAAAABAj0AIAAAAAAAAAAAAVEAEAAAAQA0DAAQAAAAGAAAABAAAAOz///8EAAAAyAAAAAQAAABkAAAACAAAAAAAAAAAQK9ABAAAAPoAAAAEAAAAXgEAAAgAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAgAAACamZmZmZm5PwgAAAAAAAAAAAAAAAgAAAAAAAAAAADwPwQAAAAAAAAABAAAAAEAAAAEAAAAMAAAAAQAAAC0AAAABAAAAAAAAAAIAAAAAAAAAAAAGEAEAAAAAAAAAAgAAAAAAAAAAADwPwgAAAAAAAAAAADgPwQAAAAAAAAABAAAAAEAAAAIAAAAexSuR+F6hD8IAAAAAAAAAAAA8D8EAAAAAQAAAAgAAAB7FK5H4XqUPwQAAABkAAAACAAAAAAAAAAAAOA/BAAAAPoAAAAEAAAAXgEAAAgAAAAAAAAAAABEQAQAAAAAAAAACAAAAAAAAAAAQFZABAAAAAAAAAAIAAAAAAAAAAAAWUAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAJEAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAEAAAAAAAAAAQAAAAAAAAA";

/** EzCAD's pen colours (BGR), pens 0..15; the rest are black. */
export const EZD_PEN_COLORS = [
    0, 0xff0000, 0xff, 0xff00, 0xff00ff, 0xffff, 0x7d7dff, 0x7d, 0x7d007d, 0x7d7d00, 0x7dff, 0xff7d00,
    0x7d00ff, 0xff7d00, 0x7d7d, 0xff7d7d,
];

export const EZD_PEN_COUNT = 256;

/** What a pen carries for us: one per distinct operation of the job. */
interface PenUse {
    op: LaserOperation;
    key: string;
}

function penKey(op: LaserOperation): string {
    return [op.power, op.speed, op.passes, op.frequency, op.pen].join("|");
}

function penRecord(index: number, use: PenUse | undefined, profile: MachineProfile): Uint8Array {
    const f = splitStruct(base64Bytes(use === undefined ? PEN_UNSET : PEN_SET));
    f[0] = i32Field(EZD_PEN_COLORS[index] ?? 0);
    if (use !== undefined) {
        const op = use.op;
        const jcz = penOf(profile.jcz, op.pen);
        f[1] = utf16Field(op.pen !== "" ? op.pen : "Default");
        f[4] = i32Field(Math.max(1, Math.round(op.passes)));
        f[5] = f64Field(op.speed / 60);
        f[6] = f64Field(op.power);
        f[7] = i32Field(op.frequency * 1000);
        f[9] = i32Field(jcz.laserOnDelay);
        f[10] = i32Field(jcz.laserOffDelay);
        f[11] = i32Field(jcz.polygonDelay);
    }
    return fieldOf((w) => w.struct(f));
}

// ---- objects --------------------------------------------------------------------------------------

const TYPE_CURVE = 1;
const TYPE_GROUP = 0x10;
const TYPE_HATCH = 0x20;

/** The 15-field header every object starts with, laid out as EzCAD writes it. */
function header(w: EzdWriter, pen: number, type: number, label: string, position: Pt) {
    w.struct([
        i32Field(pen),
        u16Field(type),
        u16Field(0), // state: not selected, hidden or locked
        utf16Field(label),
        i32Field(1),
        u16Field(0),
        u16Field(0),
        u16Field(0),
        u16Field(0),
        i32Field(1), // array count x, y
        i32Field(1),
        f64Field(10), // array step x, y
        f64Field(10),
        pointField(position),
        f64Field(0), // z
    ]);
}

function centre(b: Bounds): Pt {
    return isEmpty(b) ? { x: 0, y: 0 } : { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/** One polyline as a curve of a single line run; a closed one returns to its start, as EzCAD's do. */
function curve(w: EzdWriter, pen: number, label: string, path: LaserPath) {
    const points = path.closed ? [...path.points, path.points[0]] : path.points;
    w.i32(TYPE_CURVE);
    header(w, pen, TYPE_CURVE, label, centre(pathsBounds([path])));
    w.u32(1).u32(path.closed ? 1 : 0);
    w.u8(0).u8(1).u16(0).u16(0).i32(points.length);
    for (const p of points) w.f64(p.x).f64(p.y);
}

/** A group's header and children; `typed` false for a hatch's cached group, which has no type word. */
function group(w: EzdWriter, pen: number, label: string, b: Bounds, children: (() => void)[], typed = true) {
    if (typed) w.i32(TYPE_GROUP);
    header(w, pen, TYPE_GROUP, label, centre(b));
    w.i32(children.length);
    for (const child of children) child();
}

// The hatch record (54 fields) EzCAD 2.14.10 wrote, patched in the fields `ezdImport.ts` reads.
const HATCH_ARGS =
    "NgAAAAQAAAAAAAAABAAAAAEAAAAEAAAAAAAAAAQAAABMAAAACAAAAAAAAAAAAAAACAAAALgehetRuJ4/CAAAAAAAAAAAAAAACAAAAAAAAAAAAAAACAAAAAAAAAAA0HRABAAAAAAAAAAEAAAAAAAAAAQAAADNAAAACAAAAAAAAAAAAAAACAAAAAAAAAAAAPA/CAAAAAAAAAAAAAAACAAAAAAAAAAAAAAACAAAAAAAAAAA0HRABAAAAAEAAAAIAAAAAAAAAACAQkAIAAAAAAAAAACAQkAEAAAAAAAAAAQAAAAAAAAABAAAAM0AAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAA8D8IAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAADQdEAIAAAAAAAAAACAQkAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAEAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAIAAAAAAAAAAAA4D8IAAAAAAAAAAAA4D8IAAAAAAAAAAAA4D8IAAAAn9m0xsaJZT8IAAAAGQAZABkAWT8IAAAAGQAZABkAWT8EAAAAAAAAAAQAAAABAAAABAAAAAEAAAAEAAAAAQAAAAQAAAAAAAAABAAAAAAAAAAEAAAAAAAAAAgAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAA==";

/** Hatch 1 only: on, our pen, spacing and angle, no outline pass, no per-mark rotation. */
export function hatchArgs(pen: number, interval: number, angle: number): Uint8Array[] {
    const f = splitStruct(base64Bytes(HATCH_ARGS));
    f[0] = i32Field(0); // mark the contour: our fill is the hatch alone
    f[1] = i32Field(1);
    f[2] = i32Field(pen);
    f[5] = f64Field(interval);
    f[8] = f64Field(angle);
    f[9] = i32Field(0); // hatch 2 and 3 off
    f[20] = i32Field(0);
    f[10] = i32Field(pen);
    f[21] = i32Field(pen);
    f[16] = f64Field(angle);
    f[27] = f64Field(angle);
    f[18] = f64Field(0); // no auto-rotate
    f[19] = f64Field(0);
    f[28] = f64Field(0);
    return f;
}

interface Placed {
    object: LaserObject;
    paths: LaserPath[];
    pen: number;
}

function writeOutlines(w: EzdWriter, p: Placed, label: string) {
    if (p.paths.length === 1) {
        curve(w, p.pen, label, p.paths[0]);
        return;
    }
    group(
        w,
        p.pen,
        label,
        pathsBounds(p.paths),
        p.paths.map((path) => () => curve(w, p.pen, "", path)),
    );
}

/** A fill: a hatch holding the outlines (grouped) and, after its record, the lines EzCAD would cache. */
function writeHatch(w: EzdWriter, p: Placed) {
    const op = p.object.op;
    const angle = op.fillAngle + p.object.angle;
    const b = pathsBounds(p.paths);
    w.i32(TYPE_HATCH);
    header(w, p.pen, TYPE_HATCH, p.object.name, centre(b));
    w.i32(1);
    group(
        w,
        p.pen,
        "",
        b,
        p.paths.map((path) => () => curve(w, p.pen, "", path)),
    );
    w.struct(hatchArgs(p.pen, op.fillInterval, angle));
    const lines = hatchPaths(p.paths, op.fillInterval, angle).map(
        (s): LaserPath => ({ points: [s.from, s.to], closed: false }),
    );
    const lineBounds = lines.length > 0 ? pathsBounds(lines) : b;
    group(
        w,
        p.pen,
        "",
        lineBounds,
        [
            () =>
                group(
                    w,
                    p.pen,
                    "HATCH1",
                    lineBounds,
                    lines.map((l) => () => curve(w, p.pen, "", l)),
                ),
        ],
        false,
    );
}

// ---- preview --------------------------------------------------------------------------------------

const PREVIEW = 200;

/** The 200×200 thumbnail EzCAD's open dialog shows: black outlines on white, rows bottom-up. */
export function previewPixels(paths: readonly LaserPath[]): Uint32Array {
    const px = new Uint32Array(PREVIEW * PREVIEW).fill(0xffffff);
    const b = pathsBounds(paths);
    if (isEmpty(b)) return px;
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1e-6);
    const k = (PREVIEW - 10) / span;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const at = (p: Pt) => ({ x: PREVIEW / 2 + (p.x - cx) * k, y: PREVIEW / 2 + (p.y - cy) * k });
    const dot = (x: number, y: number) => {
        const i = Math.round(x);
        const j = Math.round(y);
        if (i >= 0 && i < PREVIEW && j >= 0 && j < PREVIEW) px[j * PREVIEW + i] = 0;
    };
    for (const path of paths) {
        const pts = path.closed ? [...path.points, path.points[0]] : path.points;
        for (let i = 1; i < pts.length; i++) {
            const a = at(pts[i - 1]);
            const c = at(pts[i]);
            const steps = Math.max(1, Math.ceil(Math.max(Math.abs(c.x - a.x), Math.abs(c.y - a.y))));
            for (let s = 0; s <= steps; s++)
                dot(a.x + ((c.x - a.x) * s) / steps, a.y + ((c.y - a.y) * s) / steps);
        }
    }
    return px;
}

// ---- the file -------------------------------------------------------------------------------------

export interface EzdExport {
    bytes: Uint8Array<ArrayBuffer>;
    /** What was left out, as `code` or `code:detail` (English; `ezdWarnings` words them). */
    warnings: string[];
    /** How many objects went into the file. */
    written: number;
}

const SEEK_SIZE = 28;
const RESERVED_SIZE = 96;
const PREVECTORS_SIZE = 400;

function place(job: LaserJobData, profile: MachineProfile, warnings: string[]) {
    const centred = withOrigin(job, { ...profile, origin: "center" });
    const pens: PenUse[] = [];
    const placed: Placed[] = [];
    for (const o of centred.objects) {
        if (o.hidden) {
            warnings.push(`hidden-object-skipped:${o.name}`);
            continue;
        }
        if (o.kind === "image") {
            warnings.push(`image-skipped:${o.name}`);
            continue;
        }
        const paths = transformPaths(o.paths, objectMatrix(o)).filter((p) => p.points.length > 1);
        if (paths.length === 0) {
            warnings.push(`empty-object-skipped:${o.name}`);
            continue;
        }
        const key = penKey(o.op);
        let pen = pens.findIndex((u) => u.key === key);
        if (pen < 0) {
            if (pens.length >= EZD_PEN_COUNT) {
                warnings.push(`too-many-pens:${o.name}`);
                pen = EZD_PEN_COUNT - 1;
            } else pen = pens.push({ op: o.op, key }) - 1;
        }
        if (penOf(profile.jcz, o.op.pen).pulseWidth > 0) warnings.push(`pulse-width-not-written:${o.op.pen}`);
        placed.push({ object: o, paths, pen });
    }
    return { pens, placed };
}

/**
 * The job as an EzCAD 2 project: every visible vector object as curves (one curve per
 * outline, a group when there are several, named as ours), a fill as a hatch around them with
 * its spacing and angle and the hatch lines EzCAD caches, measured from the field centre (a
 * corner-origin job is moved there). Each distinct operation becomes a pen (0, 1, …): power,
 * speed (mm/s), frequency, passes and the JCZ pen's delays. Pictures are left out.
 */
export function exportEzd(job: LaserJobData, profile: MachineProfile): EzdExport {
    const warnings: string[] = [];
    const { pens, placed } = place(job, profile, warnings);

    const stream = new EzdWriter();
    for (const p of placed) {
        if (p.object.op.mode === "fill") writeHatch(stream, p);
        else writeOutlines(stream, p, p.object.name);
    }
    stream.i32(0);

    const w = new EzdWriter();
    w.raw(utf16Field("EZCADUNI").subarray(0, 16))
        .i32(0)
        .i32(2001)
        .raw(new Uint8Array(180 + 140));
    const seekAt = w.length;
    w.raw(new Uint8Array(SEEK_SIZE + RESERVED_SIZE));

    const preview = w.length;
    w.i32(0)
        .i32(PREVIEW)
        .i32(PREVIEW)
        .i32(PREVIEW * 4)
        .i32(0x200001)
        .i32(0);
    for (const v of previewPixels(placed.flatMap((p) => p.paths))) w.u32(v);

    const fonts = w.length;
    w.i32(0);

    const penTable = w.length;
    w.i32(EZD_PEN_COUNT).i32(penTable + 8);
    for (let i = 0; i < EZD_PEN_COUNT; i++) w.raw(penRecord(i, pens[i], profile));

    const prevectors = w.length;
    w.raw(new Uint8Array(PREVECTORS_SIZE));

    const vectors = w.length;
    w.raw(packVectors(stream.bytes, vectors));

    const seek = [preview, 0, penTable, fonts, 0, vectors, prevectors];
    for (const [i, v] of seek.entries()) w.setU32(seekAt + 4 * i, v);
    return { bytes: w.bytes, warnings: [...new Set(warnings)], written: placed.length };
}
