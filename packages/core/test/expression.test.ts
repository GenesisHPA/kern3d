// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    type EvaluatedValue,
    evaluateExpression,
    isConstantName,
    LENGTH_UNITS,
    resolveUnitSpec,
    type Scope,
    UNITLESS,
    type UnitSpec,
} from "../src";

const length = (value: number): EvaluatedValue => ({ value, unit: LENGTH_UNITS });
const angle = (value: number): EvaluatedValue => ({ value, unit: ANGLE_UNITS });

const scope = (entries: Record<string, EvaluatedValue>): Scope => new Map(Object.entries(entries));

/** Evaluates successfully, returning the value; use `expectError` for the failing cases. */
function evaluate(source: string, entries: Record<string, EvaluatedValue> = {}): EvaluatedValue {
    const result = evaluateExpression(source, scope(entries));
    expect(result.isOk).toBe(true);
    return result.value;
}

function expectError(source: string, entries: Record<string, EvaluatedValue> = {}): string {
    const result = evaluateExpression(source, scope(entries));
    expect(result.isOk).toBe(false);
    return result.error;
}

describe("evaluateExpression", () => {
    test.each([
        { source: "42", expected: 42 },
        { source: "1 + 2 * 3", expected: 7 },
        { source: "(1 + 2) * 3", expected: 9 },
        { source: "-3 + -2", expected: -5 },
        { source: "10 / 4", expected: 2.5 },
        { source: "7 % 3", expected: 1 },
        { source: "2 * -3", expected: -6 },
        { source: "1e2 + 0.5", expected: 100.5 },
    ])("evaluates `$source` to $expected", ({ source, expected }) => {
        expect(evaluate(source).value).toBe(expected);
    });

    test("resolves identifiers from the scope", () => {
        const scope = { width: length(10), depth: length(5) };
        expect(evaluate("width * 2 + depth", scope).value).toBe(25);
    });

    test("supports functions, constants and nested calls", () => {
        expect(evaluate("max(2, min(10, 4))").value).toBe(4);
        expect(evaluate("sqrt(16) + abs(-2)").value).toBe(6);
        expect(evaluate("cos(60)").value).toBeCloseTo(0.5);
        expect(evaluate("pi").value).toBeCloseTo(Math.PI);
    });

    test.each([
        { source: "", error: "error.expression.unexpectedEndExpression" },
        { source: "1 +", error: "error.expression.unexpectedEndExpression" },
        { source: "unknown", error: "error.expression.unknownIdentifierunknown" },
        { source: "foo(1)", error: "error.expression.unknownFunctionfoo" },
        { source: "(1 + 2", error: "error.expression.missingClosingParenthesis" },
        { source: "1 / 0", error: "error.expression.divisionByZero" },
        { source: "1 2", error: "error.expression.unexpectedCharacter2" },
        { source: "1 + @", error: "error.expression.unexpectedCharacter@" },
    ])("rejects `$source` with `$error`", ({ source, error }) => {
        expect(expectError(source)).toBe(error);
    });

    // A missing argument used to reach `args[0].unit` and throw a TypeError straight out of
    // `evaluateExpression`, which returns a `Result` — the caller has no catch for it.
    test.each([
        { source: "sin()", error: "error.expression.expectsGotsinerror.expression.arityOne10" },
        { source: "sqrt()", error: "error.expression.expectsGotsqrterror.expression.arityOne10" },
        { source: "abs()", error: "error.expression.expectsGotabserror.expression.arityOne10" },
        { source: "sin(1, 2)", error: "error.expression.expectsGotsinerror.expression.arityOne12" },
        { source: "atan2(1)", error: "error.expression.expectsGotatan2error.expression.arityMany21" },
        { source: "min()", error: "error.expression.expectsGotminerror.expression.arityAtLeastOne10" },
    ])("rejects `$source` for its argument count", ({ source, error }) => {
        expect(expectError(source)).toBe(error);
    });
});

describe("names that collide with Object.prototype", () => {
    test.each(["constructor", "toString", "valueOf", "hasOwnProperty"])("%s is not a constant", (name) => {
        expect(isConstantName(name)).toBe(false);
    });

    test("pi and e still are", () => {
        expect(isConstantName("pi")).toBe(true);
        expect(isConstantName("e")).toBe(true);
    });

    test.each([
        { source: "valueOf(1)", error: "error.expression.unknownFunctionvalueOf" },
        { source: "toString(1)", error: "error.expression.unknownFunctiontoString" },
        { source: "toString", error: "error.expression.unknownIdentifiertoString" },
        { source: "constructor", error: "error.expression.unknownIdentifierconstructor" },
    ])("`$source` reads as unknown, not as a prototype member", ({ source, error }) => {
        expect(expectError(source)).toBe(error);
    });

    test("a parameter may carry one of those names", () => {
        // The name only has to avoid the real constants — `pi` and `e`.
        expect(evaluate("constructor * 2", { constructor: length(5) }).value).toBe(10);
    });
});

describe("unit propagation", () => {
    const scope = { w: length(50), h: length(25), a: angle(45) };

    test("a variable keeps its declared unit", () => {
        expect(evaluate("w", scope).unit).toEqual(LENGTH_UNITS);
        expect(evaluate("a", scope).unit).toEqual(ANGLE_UNITS);
    });

    test("a literal is unitless, so it adopts whatever it is combined with", () => {
        expect(evaluate("50").unit).toEqual(UNITLESS);
        expect(evaluate("w + 1", scope).unit).toEqual(LENGTH_UNITS);
        expect(evaluate("1 + w", scope).unit).toEqual(LENGTH_UNITS);
        expect(evaluate("a % 360", scope).unit).toEqual(ANGLE_UNITS);
    });

    test("multiplying and dividing move the exponents", () => {
        expect(evaluate("w * 2", scope).unit).toEqual(LENGTH_UNITS);
        expect(evaluate("w / h", scope).unit).toEqual(UNITLESS);
        expect(evaluate("w * h", scope).unit).toEqual({ length: 2, angle: 0 });
        expect(evaluate("w * h / w", scope).unit).toEqual(LENGTH_UNITS);
    });

    test("unary minus leaves the unit alone", () => {
        expect(evaluate("-w", scope).unit).toEqual(LENGTH_UNITS);
    });

    test("adding incompatible quantities is rejected", () => {
        expect(expectError("w + a", scope)).toBe(
            "error.expression.dimensionMismatchCannotCombineWithlengthangle",
        );
        expect(expectError("a - w", scope)).toBe(
            "error.expression.dimensionMismatchCannotCombineWithanglelength",
        );
    });

    test("trigonometry takes an angle (or a literal) and yields a ratio", () => {
        expect(evaluate("sin(a)", scope).unit).toEqual(UNITLESS);
        expect(evaluate("cos(60)").unit).toEqual(UNITLESS);
        expect(evaluate("tan(a) * w", scope).unit).toEqual(LENGTH_UNITS);
        expect(expectError("sin(w)", scope)).toBe("error.expression.expectsAngleGotsinlength");
    });

    test("inverse trigonometry takes a ratio and yields degrees", () => {
        expect(evaluate("asin(0.5)").value).toBeCloseTo(30);
        expect(evaluate("acos(0.5)").value).toBeCloseTo(60);
        expect(evaluate("atan(1)").value).toBeCloseTo(45);
        expect(evaluate("atan2(w, h)", scope).value).toBeCloseTo(63.435);
    });

    test("inverse trigonometry yields an angle and refuses anything but a ratio", () => {
        expect(evaluate("asin(h / w)", scope).unit).toEqual(ANGLE_UNITS);
        expect(evaluate("atan2(w, h)", scope).unit).toEqual(ANGLE_UNITS);
        expect(expectError("asin(w)", scope)).toBe("error.expression.expectsUnitlessRatioGotasinlength");
        expect(expectError("atan2(w, a)", scope)).toBe("error.expression.atan2MixesWithlengthangle");
    });

    test("abs and rounding pass the unit through", () => {
        expect(evaluate("abs(w)", scope).unit).toEqual(LENGTH_UNITS);
        expect(evaluate("round(a)", scope).unit).toEqual(ANGLE_UNITS);
        expect(evaluate("floor(w / h)", scope).unit).toEqual(UNITLESS);
    });

    test("min and max need their arguments to agree", () => {
        expect(evaluate("min(w, h)", scope).unit).toEqual(LENGTH_UNITS);
        expect(evaluate("max(w, 10)", scope).unit).toEqual(LENGTH_UNITS);
        expect(expectError("min(w, a)", scope)).toBe("error.expression.mixesWithminlengthangle");
    });

    test("sqrt halves even exponents and refuses odd ones", () => {
        expect(evaluate("sqrt(w * h)", scope).unit).toEqual(LENGTH_UNITS);
        // `length^0.5` is not a quantity a parameter could carry — same line Onshape draws.
        expect(expectError("sqrt(w)", scope)).toBe("error.expression.expectsEvenUnitExponentsGotsqrtlength");
    });
});

describe("resolveUnitSpec", () => {
    const scope = { w: length(2), a: angle(45) } as Record<string, EvaluatedValue>;
    const scoped: Scope = new Map(Object.entries(scope));

    test("passes a literal through without judging it", () => {
        expect(resolveUnitSpec(7, scoped, LENGTH_UNITS).unchecked()).toBe(7);
        expect(resolveUnitSpec(7, scoped, ANGLE_UNITS).unchecked()).toBe(7);
    });

    test("accepts an expression of the expected unit", () => {
        expect(resolveUnitSpec("w + 1", scoped, LENGTH_UNITS).unchecked()).toBe(3);
        expect(resolveUnitSpec("a", scoped, ANGLE_UNITS).unchecked()).toBe(45);
    });

    test("accepts a unitless expression anywhere — same adoptability as a literal", () => {
        const unit: UnitSpec = LENGTH_UNITS;
        expect(resolveUnitSpec("w / w", scoped, unit).unchecked()).toBe(1);
        expect(resolveUnitSpec("w / w", scoped, ANGLE_UNITS).unchecked()).toBe(1);
    });

    test("rejects a unit that does not fit the slot", () => {
        const result = resolveUnitSpec("a", scoped, LENGTH_UNITS);
        expect(result.isOk).toBe(false);
        expect(result.error).toBe("error.expression.dimensionMismatchExpectedGotlengthangle");
    });

    test("reports the expression's own error", () => {
        expect(resolveUnitSpec("oops", scoped, LENGTH_UNITS).error).toBe(
            "error.expression.unknownIdentifieroops",
        );
    });
});
