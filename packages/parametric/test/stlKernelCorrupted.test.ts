// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { isKernelCrash } from "@chili3d/core";
import { describe, expect, test } from "@rstest/core";
import { KernelCorrupted } from "../src/stlRebuild/rebuild";

describe("STL rebuild: a damaged kernel", () => {
    test("the stop is worded as a kernel crash (the main window says: save and restart)", () => {
        const e = new KernelCorrupted("BooleanFuse Error: RuntimeError: memory access out of bounds");
        expect(e.message).toBe("RuntimeError: memory access out of bounds");
        expect(isKernelCrash(e.message)).toBe(true);
    });
});
