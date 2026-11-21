// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import {
    CODE128_PATTERNS,
    code128Values,
    code128Widths,
    dataMatrixErrorCodewords,
    ean13CheckDigit,
    ean13Modules,
    encodeDataMatrix,
    encodeQr,
    qrDataCodewords,
    qrErrorCodewords,
    qrFormatBits,
} from "../../src/laser/barcodes";

describe("QR Code", () => {
    test("HELLO WORLD, 1-M: the data and error codewords of the standard's worked example", () => {
        const data = qrDataCodewords("HELLO WORLD", 1, "M");
        expect(data).toEqual([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]);
        expect(qrErrorCodewords(data ?? [], 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
    });

    test("format bits: level M mask 0 is the fixed mask itself, level L mask 0 is 0x77C4", () => {
        expect(qrFormatBits("M", 0)).toBe(0x5412);
        expect(qrFormatBits("L", 0)).toBe(0x77c4);
        expect(qrFormatBits("H", 7)).toBe(0x083b);
    });

    test("version 1: 21 modules, three finders, the timing rows, the dark module, format bits read back", () => {
        const r = encodeQr("HELLO WORLD", "Q");
        if (r === undefined) throw new Error("not encoded");
        const m = r.modules;
        expect(r.version).toBe(1);
        expect(m).toHaveLength(21);
        for (const [cx, cy] of [
            [3, 3],
            [17, 3],
            [3, 17],
        ]) {
            expect(m[cy][cx]).toBe(true);
            expect(m[cy][cx + 2]).toBe(false);
            expect(m[cy][cx + 3]).toBe(true);
        }
        for (let i = 8; i <= 12; i++) {
            expect(m[6][i]).toBe(i % 2 === 0);
            expect(m[i][6]).toBe(i % 2 === 0);
        }
        expect(m[21 - 8][8]).toBe(true);
        // the first copy of the format bits, as placed: bits 0–5 down column 8
        let bits = 0;
        for (let i = 0; i <= 5; i++) if (m[i][8]) bits |= 1 << i;
        if (m[7][8]) bits |= 1 << 6;
        if (m[8][8]) bits |= 1 << 7;
        if (m[8][7]) bits |= 1 << 8;
        for (let i = 9; i < 15; i++) if (m[8][14 - i]) bits |= 1 << i;
        expect(bits).toBe(qrFormatBits("Q", r.mask));
    });

    test("capacity: 41 digits fit version 1-L, 42 do not; 2953 bytes fit version 40-L, 2954 nothing", () => {
        expect(encodeQr("1".repeat(41), "L")?.version).toBe(1);
        expect(encodeQr("1".repeat(42), "L")?.version).toBe(2);
        expect(encodeQr("a".repeat(2953), "L")?.version).toBe(40);
        expect(encodeQr("a".repeat(2954), "L")).toBeUndefined();
    });

    test("version 7 and up carry the version bits (0x07C94 for 7) in both corners", () => {
        const r = encodeQr("x".repeat(60), "H");
        if (r === undefined) throw new Error("not encoded");
        expect(r.version).toBe(7);
        const n = r.modules.length;
        let bits = 0;
        for (let i = 0; i < 18; i++) if (r.modules[Math.floor(i / 3)][n - 11 + (i % 3)]) bits |= 1 << i;
        expect(bits).toBe(0x07c94);
    });

    test("Cyrillic is UTF-8 in byte mode", () => {
        const data = qrDataCodewords("Да", 1, "L");
        // mode 0100, count 4 (bytes), D0 94 D0 B0
        expect(data?.slice(0, 5)).toEqual([0x40, 0x4d, 0x09, 0x4d, 0x0b]);
    });
});

describe("Code 128", () => {
    test("every symbol is 11 modules of 3 bars and 3 spaces; the stop 13", () => {
        expect(CODE128_PATTERNS).toHaveLength(107);
        for (const p of CODE128_PATTERNS.slice(0, 106)) {
            expect(p).toHaveLength(6);
            expect([...p].reduce((a, c) => a + Number(c), 0)).toBe(11);
        }
        expect(CODE128_PATTERNS[106]).toBe("2331112");
        expect(CODE128_PATTERNS[104]).toBe("211214");
    });

    test("digits go in pairs through set C; the check is the weighted sum mod 103", () => {
        // (105 + 12·1 + 34·2 + 56·3) mod 103 = 44
        expect(code128Values("123456")).toEqual([105, 12, 34, 56, 44, 106]);
        // B: 'A' = 33, 'b' = 66
        expect(code128Values("Ab")).toEqual([104, 33, 66, (104 + 33 + 66 * 2) % 103, 106]);
        expect(code128Values("Ж")).toBeUndefined();
    });

    test("letters then a long number switch from set B to C", () => {
        const v = code128Values("AB12345678") ?? [];
        expect(v.slice(0, 4)).toEqual([104, 33, 34, 99]);
        expect(v.slice(4, 8)).toEqual([12, 34, 56, 78]);
        const widths = code128Widths("AB12345678") ?? [];
        expect(widths.reduce((a, b) => a + b, 0)).toBe(11 * (v.length - 1) + 13);
    });
});

describe("EAN-13", () => {
    test("the check digit of 400638133393 is 1; 95 modules with guards", () => {
        expect(ean13CheckDigit("400638133393")).toBe(1);
        const r = ean13Modules("400638133393");
        expect(r?.digits).toBe("4006381333931");
        expect(r?.modules).toHaveLength(95);
        expect(r?.modules.slice(0, 3)).toBe("101");
        expect(r?.modules.slice(45, 50)).toBe("01010");
        expect(r?.modules.slice(92)).toBe("101");
        // first digit 4: parity LGLLGG; the second digit 0 in L is 0001101
        expect(r?.modules.slice(3, 10)).toBe("0001101");
        expect(ean13Modules("4006381333932")).toBeUndefined();
    });
});

describe("Data Matrix", () => {
    test("123456: the standard's example codewords, a 10×10 symbol with its finder", () => {
        expect(dataMatrixErrorCodewords([142, 164, 186], 5)).toEqual([114, 25, 5, 88, 102]);
        const r = encodeDataMatrix("123456");
        if (r === undefined) throw new Error("not encoded");
        expect(r.size).toBe(10);
        expect(r.codewords).toEqual([142, 164, 186, 114, 25, 5, 88, 102]);
        for (let i = 0; i < 10; i++) {
            expect(r.modules[i][0]).toBe(true);
            expect(r.modules[9][i]).toBe(true);
            expect(r.modules[0][i]).toBe(i % 2 === 0);
        }
    });

    test("70 characters need a 2×2-region 32×32 symbol with its inner finders", () => {
        const r = encodeDataMatrix("A".repeat(60));
        if (r === undefined) throw new Error("not encoded");
        expect(r.size).toBe(32);
        // the solid edge of the lower-right region's finder runs down column 16
        for (let y = 16; y < 32; y++) expect(r.modules[y][16]).toBe(true);
    });
});
