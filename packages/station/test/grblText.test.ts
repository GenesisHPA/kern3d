// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { grblErrorText } from "../src/grblText";

describe("grblErrorText", () => {
    test("home without homing enabled", () => {
        expect(grblErrorText("error:5 $H")).toBe(
            "Домой: поиск нуля (Домой) выключен в контроллере: нет концевиков или $22=0 (error:5)",
        );
    });
    test("a program line", () => {
        expect(grblErrorText("error:22 G1 X5")).toBe("G1 X5: не задана подача F (error:22)");
    });
    test("unknown codes stay as they are", () => {
        expect(grblErrorText("error:77 G1")).toBe("error:77 G1");
        expect(grblErrorText("something")).toBe("something");
    });
});
