import { describe, expect, test } from "@rstest/core";
import {
    checkFrame,
    commandFrames,
    crc16,
    defaultVfd,
    parseSpeed,
    VFD_PRESETS,
    VfdSpindle,
} from "../../src/cam/vfd";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

describe("vfd", () => {
    test("Modbus CRC: the textbook frame", () => {
        // 01 03 00 00 00 01 → CRC 84 0A
        expect(crc16([1, 3, 0, 0, 0, 1])).toBe(0x0a84);
    });
    test("Huanyang: frequency then run forward; stop", () => {
        const s = defaultVfd();
        const [freq, run] = commandFrames(s, { kind: "run", rpm: 12000 });
        expect(hex(freq).startsWith("01 05 02 4e 20")).toBe(true); // 200.00 Hz
        expect(hex(run)).toBe("01 03 01 01 31 88");
        expect(hex(commandFrames(s, { kind: "stop" })[0])).toBe("01 03 01 08 f1 8e");
        expect(checkFrame(freq)).toBe(true);
    });
    test("Modbus H100: register writes", () => {
        const s = { ...defaultVfd(), ...VFD_PRESETS["H100"] };
        const [freq, run] = commandFrames(s, { kind: "run", rpm: 24000 });
        expect(hex(freq).startsWith("01 06 20 01 0f a0")).toBe(true); // 400.0 Hz ×10
        expect(hex(run).startsWith("01 06 20 00 00 01")).toBe(true);
    });
    test("speed read back and clamped", () => {
        const s = { ...defaultVfd(), ...VFD_PRESETS["H100"] };
        const body = [1, 3, 2, 0x07, 0xd0];
        const c = crc16(body);
        expect(parseSpeed(s, Uint8Array.from([...body, c & 0xff, c >> 8]))).toBe(12000);
        const [f] = commandFrames(defaultVfd(), { kind: "run", rpm: 100 });
        expect(hex(f).startsWith("01 05 02 27 10")).toBe(true); // min 6000 rpm = 100 Hz
    });
    test("G-code lines drive it", async () => {
        const sent: string[] = [];
        const v = new VfdSpindle(
            { write: async (b) => void sent.push(hex(b)), read: async () => undefined },
            defaultVfd(),
        );
        await v.onLine("S18000 M3");
        await v.onLine("G1 X1 F100");
        await v.onLine("M5");
        expect(sent.length).toBe(3);
        expect(sent[2]).toBe("01 03 01 08 f1 8e");
    });
});
