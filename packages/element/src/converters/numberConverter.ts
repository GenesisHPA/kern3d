// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type IConverter, Result } from "@chili3d/core";

export class NumberConverter implements IConverter<number> {
    convert(value: number): Result<string> {
        return Number.isNaN(value)
            ? Result.err(I18n.translate("error.input.numberNaN"))
            : Result.ok(String(value));
    }

    convertBack(value: string): Result<number> {
        const n = Number(value);
        return Number.isNaN(n)
            ? Result.err(I18n.translate("error.input.canNotConvertNumber{0}", value))
            : Result.ok(n);
    }
}
