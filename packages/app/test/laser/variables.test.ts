import { describe, expect, test } from "@rstest/core";
import { expandVariables, hasVariables, parseSerial } from "../../src/laser/variables";

describe("laser variables", () => {
    const at = new Date(2026, 10, 24, 9, 5);
    test("serial padded, date and time", () => {
        expect(expandVariables("SN {N} {date} {time}", { next: 7, step: 1, digits: 4 }, at)).toBe(
            "SN 0007 24.11.2026 09:05",
        );
        expect(expandVariables("{year}-{month}-{day}", undefined, at)).toBe("2026-11-24");
    });
    test("unknown braces stay, plain text untouched", () => {
        expect(expandVariables("{x} {N}", { next: 12, step: 1, digits: 0 }, at)).toBe("{x} 12");
        expect(hasVariables("abc {N}")).toBe(true);
        expect(hasVariables("abc {x}")).toBe(false);
    });
    test("parse clamps", () => {
        expect(parseSerial({ next: 3.4, digits: 99 })).toEqual({ next: 3, step: 1, digits: 12 });
        expect(parseSerial(undefined)).toBeUndefined();
    });
});
