// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Barcode encoders for laser marking, written out here after the published standards (no
 * library): QR Code (ISO/IEC 18004 — numeric, alphanumeric and byte modes, versions 1–40, the
 * four error-correction levels, the mask chosen by the penalty rules), Code 128 (ISO/IEC 15417,
 * code sets B and C), EAN-13 (ISO/IEC 15420) and Data Matrix ECC 200 (ISO/IEC 16022, ASCII
 * encodation, square symbols 10×10 … 48×48). Each gives dark modules: a matrix for the 2D
 * codes, bar widths for the 1D ones; the laser module turns them into filled rectangles.
 */

export type Matrix = boolean[][];

// ---- Reed–Solomon over GF(256) ----------------------------------------------------------------

class Galois {
    readonly exp = new Uint8Array(512);
    readonly log = new Uint8Array(256);

    constructor(primitive: number) {
        let x = 1;
        for (let i = 0; i < 255; i++) {
            this.exp[i] = x;
            this.log[x] = i;
            x <<= 1;
            if (x & 0x100) x ^= primitive;
        }
        for (let i = 255; i < 512; i++) this.exp[i] = this.exp[i - 255];
    }

    mul(a: number, b: number): number {
        return a === 0 || b === 0 ? 0 : this.exp[this.log[a] + this.log[b]];
    }

    /** The generator ∏ (x − α^(first+i)), i < degree; coefficients highest power first, leading 1 left out. */
    generator(degree: number, first: number): number[] {
        let g = [1];
        for (let i = 0; i < degree; i++) {
            const root = this.exp[(i + first) % 255];
            const next = new Array(g.length + 1).fill(0);
            for (let j = 0; j < g.length; j++) {
                next[j] ^= g[j];
                next[j + 1] ^= this.mul(g[j], root);
            }
            g = next;
        }
        return g.slice(1);
    }

    /** The remainder of data·x^n divided by the generator: the n error-correction codewords. */
    remainder(data: readonly number[], generator: readonly number[]): number[] {
        const r = new Array(generator.length).fill(0);
        for (const d of data) {
            const factor = d ^ r[0];
            r.shift();
            r.push(0);
            for (let i = 0; i < generator.length; i++) r[i] ^= this.mul(generator[i], factor);
        }
        return r;
    }
}

/** QR: x⁸ + x⁴ + x³ + x² + 1, generator roots α⁰…; Data Matrix: x⁸ + x⁵ + x³ + x² + 1, roots α¹…. */
const QR_GF = new Galois(0x11d);
const DM_GF = new Galois(0x12d);

export function qrErrorCodewords(data: readonly number[], count: number): number[] {
    return QR_GF.remainder(data, QR_GF.generator(count, 0));
}

export function dataMatrixErrorCodewords(data: readonly number[], count: number): number[] {
    return DM_GF.remainder(data, DM_GF.generator(count, 1));
}

// ---- QR Code ----------------------------------------------------------------------------------

export const QR_LEVELS = ["L", "M", "Q", "H"] as const;
export type QrLevel = (typeof QR_LEVELS)[number];

/** Format-information bits of the levels. */
const LEVEL_BITS: Record<QrLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** Per version (index 1…40): error-correction codewords per block, for L, M, Q, H. */
const EC_PER_BLOCK = [
    [-1, -1, -1, -1],
    [7, 10, 13, 17],
    [10, 16, 22, 28],
    [15, 26, 18, 22],
    [20, 18, 26, 16],
    [26, 24, 18, 22],
    [18, 16, 24, 28],
    [20, 18, 18, 26],
    [24, 22, 22, 26],
    [30, 22, 20, 24],
    [18, 26, 24, 28],
    [20, 30, 28, 24],
    [24, 22, 26, 28],
    [26, 22, 24, 22],
    [30, 24, 20, 24],
    [22, 24, 30, 24],
    [24, 28, 24, 30],
    [28, 28, 28, 28],
    [30, 26, 28, 28],
    [28, 26, 26, 26],
    [28, 26, 30, 28],
    [28, 26, 28, 30],
    [28, 28, 30, 24],
    [30, 28, 30, 30],
    [30, 28, 30, 30],
    [26, 28, 30, 30],
    [28, 28, 28, 30],
    [30, 28, 30, 30],
    [30, 28, 30, 30],
    [30, 28, 30, 30],
    [30, 28, 30, 30],
    [30, 28, 30, 30],
    [30, 28, 30, 30],
    [30, 28, 30, 30],
    [30, 28, 30, 30],
    [30, 28, 30, 30],
    [30, 28, 30, 30],
    [30, 28, 30, 30],
    [30, 28, 30, 30],
    [30, 28, 30, 30],
    [30, 28, 30, 30],
];

/** Per version: the number of error-correction blocks, for L, M, Q, H. */
const EC_BLOCKS = [
    [-1, -1, -1, -1],
    [1, 1, 1, 1],
    [1, 1, 1, 1],
    [1, 1, 2, 2],
    [1, 2, 2, 4],
    [1, 2, 4, 4],
    [2, 4, 4, 4],
    [2, 4, 6, 5],
    [2, 4, 6, 6],
    [2, 5, 8, 8],
    [4, 5, 8, 8],
    [4, 5, 8, 11],
    [4, 8, 10, 11],
    [4, 9, 12, 16],
    [4, 9, 16, 16],
    [6, 10, 12, 18],
    [6, 10, 17, 16],
    [6, 11, 16, 19],
    [6, 13, 18, 21],
    [7, 14, 21, 25],
    [8, 16, 20, 25],
    [8, 17, 23, 25],
    [9, 17, 23, 34],
    [9, 18, 25, 30],
    [10, 20, 27, 32],
    [12, 21, 29, 35],
    [12, 23, 34, 37],
    [12, 25, 34, 40],
    [13, 26, 35, 42],
    [14, 28, 38, 45],
    [15, 29, 40, 48],
    [16, 31, 43, 51],
    [17, 33, 45, 54],
    [18, 35, 48, 57],
    [19, 37, 51, 60],
    [19, 38, 53, 63],
    [20, 40, 56, 66],
    [21, 43, 59, 70],
    [22, 45, 62, 74],
    [24, 47, 65, 77],
    [25, 49, 68, 81],
];

const levelIndex = (l: QrLevel) => QR_LEVELS.indexOf(l);

/** Modules left for data and error correction once the function patterns are placed. */
function rawModules(version: number): number {
    let n = (16 * version + 128) * version + 64;
    if (version >= 2) {
        const align = Math.floor(version / 7) + 2;
        n -= (25 * align - 10) * align - 55;
        if (version >= 7) n -= 36;
    }
    return n;
}

function dataCodewords(version: number, level: QrLevel): number {
    const i = levelIndex(level);
    return Math.floor(rawModules(version) / 8) - EC_PER_BLOCK[version][i] * EC_BLOCKS[version][i];
}

const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

type QrMode = "numeric" | "alphanumeric" | "byte";

function qrMode(text: string): QrMode {
    if (/^[0-9]*$/.test(text)) return "numeric";
    if ([...text].every((c) => ALPHANUMERIC.includes(c))) return "alphanumeric";
    return "byte";
}

function countBits(mode: QrMode, version: number): number {
    const band = version <= 9 ? 0 : version <= 26 ? 1 : 2;
    if (mode === "numeric") return [10, 12, 14][band];
    if (mode === "alphanumeric") return [9, 11, 13][band];
    return [8, 16, 16][band];
}

class Bits {
    readonly bits: number[] = [];
    put(value: number, length: number) {
        for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
    }
}

/** The segment's bits after the mode and count: digits by threes, letters by pairs, or UTF-8. */
function segmentBits(text: string, mode: QrMode): { bits: number[]; count: number } {
    const b = new Bits();
    if (mode === "numeric") {
        for (let i = 0; i < text.length; i += 3) {
            const chunk = text.slice(i, i + 3);
            b.put(Number(chunk), chunk.length * 3 + 1);
        }
        return { bits: b.bits, count: text.length };
    }
    if (mode === "alphanumeric") {
        for (let i = 0; i < text.length; i += 2) {
            const a = ALPHANUMERIC.indexOf(text[i]);
            if (i + 1 < text.length) b.put(a * 45 + ALPHANUMERIC.indexOf(text[i + 1]), 11);
            else b.put(a, 6);
        }
        return { bits: b.bits, count: text.length };
    }
    const bytes = new TextEncoder().encode(text);
    for (const byte of bytes) b.put(byte, 8);
    return { bits: b.bits, count: bytes.length };
}

/** The data codewords: mode, count, data, terminator, padding to a byte, then 0xEC 0x11 … */
export function qrDataCodewords(text: string, version: number, level: QrLevel): number[] | undefined {
    const mode = qrMode(text);
    const seg = segmentBits(text, mode);
    const b = new Bits();
    b.put({ numeric: 1, alphanumeric: 2, byte: 4 }[mode], 4);
    const cb = countBits(mode, version);
    if (seg.count >= 1 << cb) return undefined;
    b.put(seg.count, cb);
    b.bits.push(...seg.bits);
    const capacity = dataCodewords(version, level) * 8;
    if (b.bits.length > capacity) return undefined;
    b.put(0, Math.min(4, capacity - b.bits.length));
    b.put(0, (8 - (b.bits.length % 8)) % 8);
    const out: number[] = [];
    for (let i = 0; i < b.bits.length; i += 8) {
        let v = 0;
        for (let j = 0; j < 8; j++) v = (v << 1) | b.bits[i + j];
        out.push(v);
    }
    for (let pad = 0xec; out.length < capacity / 8; pad ^= 0xec ^ 0x11) out.push(pad);
    return out;
}

/** Data split into the version's blocks, each with its error correction, then interleaved. */
function qrInterleave(data: number[], version: number, level: QrLevel): number[] {
    const i = levelIndex(level);
    const blocks = EC_BLOCKS[version][i];
    const ecLen = EC_PER_BLOCK[version][i];
    const raw = Math.floor(rawModules(version) / 8);
    const shortBlocks = blocks - (raw % blocks);
    const shortLen = Math.floor(raw / blocks);
    const gen = QR_GF.generator(ecLen, 0);
    const parts: number[][] = [];
    let k = 0;
    for (let b = 0; b < blocks; b++) {
        const len = shortLen - ecLen + (b < shortBlocks ? 0 : 1);
        const d = data.slice(k, k + len);
        k += len;
        const ec = QR_GF.remainder(d, gen);
        // a short block gets a hole so the columns line up
        if (b < shortBlocks) d.push(-1);
        parts.push([...d, ...ec]);
    }
    const out: number[] = [];
    for (let col = 0; col < parts[0].length; col++) {
        for (let b = 0; b < blocks; b++) {
            if (col !== shortLen - ecLen || b >= shortBlocks) out.push(parts[b][col]);
        }
    }
    return out;
}

function alignmentPositions(version: number): number[] {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const out = [6];
    for (let pos = version * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos);
    return out;
}

/** The 15 format bits (level, mask) with their BCH code and fixed mask. */
export function qrFormatBits(level: QrLevel, mask: number): number {
    const data = (LEVEL_BITS[level] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (version << 12) | rem;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
    (x, y) => (x + y) % 2 === 0,
    (_x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class QrSymbol {
    readonly size: number;
    readonly dark: Matrix;
    readonly fixed: Matrix;

    constructor(readonly version: number) {
        this.size = version * 4 + 17;
        this.dark = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
        this.fixed = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
        this.functionPatterns();
    }

    private set(x: number, y: number, dark: boolean) {
        this.dark[y][x] = dark;
        this.fixed[y][x] = true;
    }

    private functionPatterns() {
        const n = this.size;
        for (let i = 0; i < n; i++) {
            this.set(6, i, i % 2 === 0);
            this.set(i, 6, i % 2 === 0);
        }
        this.finder(3, 3);
        this.finder(n - 4, 3);
        this.finder(3, n - 4);
        const pos = alignmentPositions(this.version);
        for (let i = 0; i < pos.length; i++)
            for (let j = 0; j < pos.length; j++) {
                const corner =
                    (i === 0 && j === 0) ||
                    (i === 0 && j === pos.length - 1) ||
                    (i === pos.length - 1 && j === 0);
                if (!corner) this.alignment(pos[i], pos[j]);
            }
        // reserved until the mask is chosen
        this.format("L", 0);
        if (this.version >= 7) {
            const bits = versionBits(this.version);
            for (let i = 0; i < 18; i++) {
                const bit = ((bits >>> i) & 1) === 1;
                const a = n - 11 + (i % 3);
                const b = Math.floor(i / 3);
                this.set(a, b, bit);
                this.set(b, a, bit);
            }
        }
    }

    private finder(cx: number, cy: number) {
        for (let dy = -4; dy <= 4; dy++)
            for (let dx = -4; dx <= 4; dx++) {
                const x = cx + dx;
                const y = cy + dy;
                if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
                const d = Math.max(Math.abs(dx), Math.abs(dy));
                this.set(x, y, d !== 2 && d !== 4);
            }
    }

    private alignment(cx: number, cy: number) {
        for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++)
                this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

    format(level: QrLevel, mask: number) {
        const bits = qrFormatBits(level, mask);
        const bit = (i: number) => ((bits >>> i) & 1) === 1;
        const n = this.size;
        for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
        this.set(8, 7, bit(6));
        this.set(8, 8, bit(7));
        this.set(7, 8, bit(8));
        for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
        for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i));
        this.set(8, n - 8, true);
    }

    /** Codewords in the zigzag of two-module columns, right to left, skipping the timing column. */
    place(codewords: readonly number[]) {
        const n = this.size;
        let i = 0;
        const total = codewords.length * 8;
        for (let right = n - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (let v = 0; v < n; v++) {
                for (let j = 0; j < 2; j++) {
                    const x = right - j;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? n - 1 - v : v;
                    if (this.fixed[y][x]) continue;
                    if (i < total) this.dark[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
                    i++;
                }
            }
        }
    }

    applyMask(mask: number) {
        const f = MASKS[mask];
        for (let y = 0; y < this.size; y++)
            for (let x = 0; x < this.size; x++)
                if (!this.fixed[y][x] && f(x, y)) this.dark[y][x] = !this.dark[y][x];
    }

    /** The standard's four penalties: runs, 2×2 blocks, finder-like patterns, dark balance. */
    penalty(): number {
        const n = this.size;
        const d = this.dark;
        let score = 0;
        const line = (get: (i: number) => boolean) => {
            let run = 1;
            for (let i = 1; i < n; i++) {
                if (get(i) === get(i - 1)) run++;
                else {
                    if (run >= 5) score += run - 2;
                    run = 1;
                }
            }
            if (run >= 5) score += run - 2;
            for (let i = 0; i + 10 < n; i++) {
                const p = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0].every((b, k) => get(i + k) === (b === 1));
                const q = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1].every((b, k) => get(i + k) === (b === 1));
                if (p || q) score += 40;
            }
        };
        for (let y = 0; y < n; y++) line((i) => d[y][i]);
        for (let x = 0; x < n; x++) line((i) => d[i][x]);
        for (let y = 0; y + 1 < n; y++)
            for (let x = 0; x + 1 < n; x++) {
                const c = d[y][x];
                if (c === d[y][x + 1] && c === d[y + 1][x] && c === d[y + 1][x + 1]) score += 3;
            }
        let darkCount = 0;
        for (const row of d) for (const c of row) if (c) darkCount++;
        const k = Math.ceil(Math.abs(darkCount * 20 - n * n * 10) / (n * n)) - 1;
        return score + k * 10;
    }
}

export interface QrResult {
    version: number;
    mask: number;
    modules: Matrix;
}

/** The smallest QR symbol that holds the text at the level; undefined when it does not fit at all. */
export function encodeQr(text: string, level: QrLevel = "M", mask?: number): QrResult | undefined {
    for (let version = 1; version <= 40; version++) {
        const data = qrDataCodewords(text, version, level);
        if (data === undefined) continue;
        const codewords = qrInterleave(data, version, level);
        let best: { mask: number; symbol: QrSymbol; score: number } | undefined;
        for (let m = 0; m < 8; m++) {
            if (mask !== undefined && m !== mask) continue;
            const s = new QrSymbol(version);
            s.place(codewords);
            s.applyMask(m);
            s.format(level, m);
            const score = s.penalty();
            if (best === undefined || score < best.score) best = { mask: m, symbol: s, score };
        }
        if (best === undefined) return undefined;
        return { version, mask: best.mask, modules: best.symbol.dark };
    }
    return undefined;
}

// ---- Code 128 -----------------------------------------------------------------------------------

/** Bar/space widths of the 107 symbols (0…102 values, 103–105 start A/B/C, 106 stop). */
export const CODE128_PATTERNS = [
    "212222",
    "222122",
    "222221",
    "121223",
    "121322",
    "131222",
    "122213",
    "122312",
    "132212",
    "221213",
    "221312",
    "231212",
    "112232",
    "122132",
    "122231",
    "113222",
    "123122",
    "123221",
    "223211",
    "221132",
    "221231",
    "213212",
    "223112",
    "312131",
    "311222",
    "321122",
    "321221",
    "312212",
    "322112",
    "322211",
    "212123",
    "212321",
    "232121",
    "111323",
    "131123",
    "131321",
    "112313",
    "132113",
    "132311",
    "211313",
    "231113",
    "231311",
    "112133",
    "112331",
    "132131",
    "113123",
    "113321",
    "133121",
    "313121",
    "211331",
    "231131",
    "213113",
    "213311",
    "213131",
    "311123",
    "311321",
    "331121",
    "312113",
    "312311",
    "332111",
    "314111",
    "221411",
    "431111",
    "111224",
    "111422",
    "121124",
    "121421",
    "141122",
    "141221",
    "112214",
    "112412",
    "122114",
    "122411",
    "142112",
    "142211",
    "241211",
    "221114",
    "413111",
    "241112",
    "134111",
    "111242",
    "121142",
    "121241",
    "114212",
    "124112",
    "124211",
    "411212",
    "421112",
    "421211",
    "212141",
    "214121",
    "412121",
    "111143",
    "111341",
    "131141",
    "114113",
    "114311",
    "411113",
    "411311",
    "113141",
    "114131",
    "311141",
    "411131",
    "211412",
    "211214",
    "211232",
    "2331112",
];

const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;
const STOP = 106;

/**
 * The symbol values for `text`: set B for printable ASCII, set C (digit pairs) for a run of at
 * least four digits (the whole text when it is all an even number of digits). Undefined for a
 * character outside ASCII 32–126.
 */
export function code128Values(text: string): number[] | undefined {
    if (text.length === 0 || [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126))
        return undefined;
    const values: number[] = [];
    let set: "B" | "C" | undefined;
    let i = 0;
    const digitRun = (from: number) => {
        let k = from;
        while (k < text.length && text[k] >= "0" && text[k] <= "9") k++;
        return k - from;
    };
    while (i < text.length) {
        const run = digitRun(i);
        // pairs of digits halve the width from four on (or two more once already in set C)
        const useC = run >= 4 || (set === "C" && run >= 2);
        if (useC) {
            if (set !== "C") values.push(set === undefined ? START_C : CODE_C);
            set = "C";
            // an odd run leaves its last digit for set B
            const pairs = Math.floor(run / 2);
            for (let p = 0; p < pairs; p++) {
                values.push(Number(text.slice(i, i + 2)));
                i += 2;
            }
            continue;
        }
        if (set !== "B") values.push(set === undefined ? START_B : CODE_B);
        set = "B";
        values.push(text.charCodeAt(i) - 32);
        i++;
    }
    let sum = values[0];
    for (let k = 1; k < values.length; k++) sum += values[k] * k;
    values.push(sum % 103, STOP);
    return values;
}

/** Alternating bar and space widths in modules, starting with a bar. */
export function code128Widths(text: string): number[] | undefined {
    const values = code128Values(text);
    if (values === undefined) return undefined;
    return values.flatMap((v) => [...CODE128_PATTERNS[v]].map(Number));
}

// ---- EAN-13 ------------------------------------------------------------------------------------

const EAN_L = [
    "0001101",
    "0011001",
    "0010011",
    "0111101",
    "0100011",
    "0110001",
    "0101111",
    "0111011",
    "0110111",
    "0001011",
];
const EAN_PARITY = [
    "LLLLLL",
    "LLGLGG",
    "LLGGLG",
    "LLGGGL",
    "LGLLGG",
    "LGGLLG",
    "LGGGLL",
    "LGLGLG",
    "LGLGGL",
    "LGGLGL",
];

export function ean13CheckDigit(twelve: string): number {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (sum % 10)) % 10;
}

/** 12 digits (the check digit added) or 13 (checked): the 95 modules, 1 dark. */
export function ean13Modules(digits: string): { modules: string; digits: string } | undefined {
    if (!/^\d{12,13}$/.test(digits)) return undefined;
    const check = ean13CheckDigit(digits);
    if (digits.length === 13 && Number(digits[12]) !== check) return undefined;
    const all = digits.slice(0, 12) + String(check);
    const parity = EAN_PARITY[Number(all[0])];
    let m = "101";
    for (let i = 1; i <= 6; i++) {
        const l = EAN_L[Number(all[i])];
        // G: the R code reversed; R: the L code inverted
        const r = [...l].map((c) => (c === "1" ? "0" : "1")).join("");
        m += parity[i - 1] === "L" ? l : [...r].reverse().join("");
    }
    m += "01010";
    for (let i = 7; i <= 12; i++)
        m += [...EAN_L[Number(all[i])]].map((c) => (c === "1" ? "0" : "1")).join("");
    m += "101";
    return { modules: m, digits: all };
}

// ---- Data Matrix ECC 200 -------------------------------------------------------------------------

/** Square symbols with one Reed–Solomon block: size, data codewords, error codewords, data region. */
const DM_SIZES: [size: number, data: number, ec: number, region: number][] = [
    [10, 3, 5, 8],
    [12, 5, 7, 10],
    [14, 8, 10, 12],
    [16, 12, 12, 14],
    [18, 18, 14, 16],
    [20, 22, 18, 18],
    [22, 30, 20, 20],
    [24, 36, 24, 22],
    [26, 44, 28, 24],
    [32, 62, 36, 14],
    [36, 86, 42, 16],
    [40, 114, 48, 18],
    [44, 144, 56, 20],
    [48, 174, 68, 22],
];

/** ASCII encodation: digit pairs as 130 + nn, ASCII as value + 1, above 127 through Upper Shift. */
export function dataMatrixCodewords(text: string): number[] | undefined {
    const bytes = new TextEncoder().encode(text);
    const out: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        const next = bytes[i + 1];
        if (b >= 48 && b <= 57 && next !== undefined && next >= 48 && next <= 57) {
            out.push(130 + (b - 48) * 10 + (next - 48));
            i++;
        } else if (b < 128) out.push(b + 1);
        else out.push(235, b - 127);
    }
    return out;
}

function dmPad(data: number[], capacity: number): number[] {
    const out = [...data];
    if (out.length < capacity) out.push(129);
    while (out.length < capacity) {
        const pos = out.length + 1;
        let v = 129 + ((149 * pos) % 253) + 1;
        if (v > 254) v -= 254;
        out.push(v);
    }
    return out;
}

/** The ISO placement of codewords in the mapping matrix (the "utah" shapes and the four corners). */
function dmPlacement(rows: number, cols: number, codewords: readonly number[]): Matrix {
    const grid: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(-1));
    const module = (r: number, c: number, cw: number, bit: number) => {
        if (r < 0) {
            r += rows;
            c += 4 - ((rows + 4) % 8);
        }
        if (c < 0) {
            c += cols;
            r += 4 - ((cols + 4) % 8);
        }
        grid[r][c] = (codewords[cw] >>> (8 - bit)) & 1;
    };
    const utah = (r: number, c: number, cw: number) => {
        module(r - 2, c - 2, cw, 1);
        module(r - 2, c - 1, cw, 2);
        module(r - 1, c - 2, cw, 3);
        module(r - 1, c - 1, cw, 4);
        module(r - 1, c, cw, 5);
        module(r, c - 2, cw, 6);
        module(r, c - 1, cw, 7);
        module(r, c, cw, 8);
    };
    const corner1 = (cw: number) => {
        module(rows - 1, 0, cw, 1);
        module(rows - 1, 1, cw, 2);
        module(rows - 1, 2, cw, 3);
        module(0, cols - 2, cw, 4);
        module(0, cols - 1, cw, 5);
        module(1, cols - 1, cw, 6);
        module(2, cols - 1, cw, 7);
        module(3, cols - 1, cw, 8);
    };
    const corner2 = (cw: number) => {
        module(rows - 3, 0, cw, 1);
        module(rows - 2, 0, cw, 2);
        module(rows - 1, 0, cw, 3);
        module(0, cols - 4, cw, 4);
        module(0, cols - 3, cw, 5);
        module(0, cols - 2, cw, 6);
        module(0, cols - 1, cw, 7);
        module(1, cols - 1, cw, 8);
    };
    const corner3 = (cw: number) => {
        module(rows - 3, 0, cw, 1);
        module(rows - 2, 0, cw, 2);
        module(rows - 1, 0, cw, 3);
        module(0, cols - 2, cw, 4);
        module(0, cols - 1, cw, 5);
        module(1, cols - 1, cw, 6);
        module(2, cols - 1, cw, 7);
        module(3, cols - 1, cw, 8);
    };
    const corner4 = (cw: number) => {
        module(rows - 1, 0, cw, 1);
        module(rows - 1, cols - 1, cw, 2);
        module(0, cols - 3, cw, 3);
        module(0, cols - 2, cw, 4);
        module(0, cols - 1, cw, 5);
        module(1, cols - 3, cw, 6);
        module(1, cols - 2, cw, 7);
        module(1, cols - 1, cw, 8);
    };
    let cw = 0;
    let r = 4;
    let c = 0;
    do {
        if (r === rows && c === 0) corner1(cw++);
        if (r === rows - 2 && c === 0 && cols % 4 !== 0) corner2(cw++);
        if (r === rows - 2 && c === 0 && cols % 8 === 4) corner3(cw++);
        if (r === rows + 4 && c === 2 && cols % 8 === 0) corner4(cw++);
        do {
            if (r < rows && c >= 0 && grid[r][c] === -1) utah(r, c, cw++);
            r -= 2;
            c += 2;
        } while (r >= 0 && c < cols);
        r += 1;
        c += 3;
        do {
            if (r >= 0 && c < cols && grid[r][c] === -1) utah(r, c, cw++);
            r += 2;
            c -= 2;
        } while (r < rows && c >= 0);
        r += 3;
        c += 1;
    } while (r < rows || c < cols);
    // the unused corner of some sizes: a fixed checker
    if (grid[rows - 1][cols - 1] === -1) {
        grid[rows - 1][cols - 1] = 1;
        grid[rows - 2][cols - 2] = 1;
        grid[rows - 1][cols - 2] = 0;
        grid[rows - 2][cols - 1] = 0;
    }
    return grid.map((row) => row.map((v) => v === 1));
}

export interface DataMatrixResult {
    size: number;
    codewords: number[];
    modules: Matrix;
}

/** The smallest square ECC 200 symbol up to 48×48 that holds the text; undefined past it. */
export function encodeDataMatrix(text: string): DataMatrixResult | undefined {
    const data = dataMatrixCodewords(text);
    if (data === undefined) return undefined;
    const spec = DM_SIZES.find(([, capacity]) => capacity >= data.length);
    if (spec === undefined) return undefined;
    const [size, capacity, ecCount, region] = spec;
    const padded = dmPad(data, capacity);
    const codewords = [...padded, ...dataMatrixErrorCodewords(padded, ecCount)];
    // 32×32 and up: 2×2 data regions, each with its own finder and timing
    const regions = size / (region + 2);
    const mapSize = regions * region;
    const map = dmPlacement(mapSize, mapSize, codewords);
    const modules: Matrix = Array.from({ length: size }, () => new Array(size).fill(false));
    const step = region + 2;
    for (let ry = 0; ry < regions; ry++)
        for (let rx = 0; rx < regions; rx++) {
            const x0 = rx * step;
            const y0 = ry * step;
            for (let i = 0; i < step; i++) {
                // finder: solid left and bottom, alternating top and right
                modules[y0 + step - 1][x0 + i] = true;
                modules[y0 + i][x0] = true;
                modules[y0][x0 + i] = i % 2 === 0;
                modules[y0 + i][x0 + step - 1] = i % 2 === 1;
            }
            for (let y = 0; y < region; y++)
                for (let x = 0; x < region; x++)
                    modules[y0 + 1 + y][x0 + 1 + x] = map[ry * region + y][rx * region + x];
        }
    return { size, codewords, modules };
}
