// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { GamepadJog, WebSocketConnection } from "../../src/cam/camNet";

describe("network and gamepad", () => {
    test("addresses", () => {
        expect(WebSocketConnection.address("192.168.1.50")).toBe("ws://192.168.1.50:81");
        expect(WebSocketConnection.address("10.0.0.2:8080")).toBe("ws://10.0.0.2:8080");
        expect(WebSocketConnection.address("ws://cnc.local/")).toBe("ws://cnc.local/");
    });

    test("stick to jog", () => {
        expect(GamepadJog.tick(0.05, 0, 0, 1000)).toBeUndefined();
        // full right: 1000 mm/min for 0.13 s ≈ 2.167 mm
        expect(GamepadJog.tick(1, 0, 0, 1000)).toBe("$J=G91 G21 X2.167 F1000");
        expect(GamepadJog.tick(0, -0.5, 0, 1000)).toBe("$J=G91 G21 Y-0.542 F250");
    });
});
