// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { importMarkcfg, importMarkParam } from "../../src/laser/ezcadImport";
import { GalvoMapper, galvosPerMm, jczLightRound, jczProgram } from "../../src/laser/jczProgram";
import { defaultJczSettings } from "../../src/laser/jczSettings";
import { defaultOperation, type LaserJobData, type LaserVectorObject } from "../../src/laser/laserData";
import {
    Cmd,
    correctionCommands,
    decodeReply,
    encodeCommand,
    jumpTo,
    List,
    LMC_LIST_SIZE,
    listDelay,
    markCurrent,
    markTo,
    packLists,
    parseCorrectionFile,
    qSwitchPeriod,
    roundHalfEven,
    speedWord,
} from "../../src/laser/lmc";
import { defaultMachineProfile, type MachineProfile } from "../../src/laser/machineProfile";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");

/**
 * Golden bytes: what the reference (galvoplotter / MeerK40t balor, struct.pack("<6H", …)) puts
 * on the wire for the same calls, worked out by hand from their source.
 */
describe("LMC packets", () => {
    test("a jump to the field centre from the centre: 0x8001, x, y, angle 0, distance 0", () => {
        expect(hex(encodeCommand(jumpTo(0x8000, 0x8000, 0x8000, 0x8000)))).toBe(
            "01 80 00 80 00 80 00 00 00 00 00 00",
        );
    });

    test("a mark 4096 units along x carries the distance in the fifth word", () => {
        expect(hex(encodeCommand(markTo(0x9000, 0x8000, 0x8000, 0x8000)))).toBe(
            "05 80 00 90 00 80 00 00 00 10 00 00",
        );
    });

    test("fiber power and frequency: 50 % → current 2048, 30 kHz → Q-switch period 667", () => {
        expect(markCurrent(50)).toBe(2048);
        expect(hex(encodeCommand([List.MarkCurrent, markCurrent(50)]))).toBe(
            "12 80 00 08 00 00 00 00 00 00 00 00",
        );
        expect(qSwitchPeriod(30)).toBe(667);
        expect(hex(encodeCommand([List.QSwitchPeriod, qSwitchPeriod(30)]))).toBe(
            "1b 80 9b 02 00 00 00 00 00 00 00 00",
        );
    });

    test("the red pointer: port bit 8 written now, or in a list", () => {
        expect(hex(encodeCommand([Cmd.WritePort, 1 << 8]))).toBe("21 00 00 01 00 00 00 00 00 00 00 00");
        expect(hex(encodeCommand([List.WritePort, 1 << 8]))).toBe("11 80 00 01 00 00 00 00 00 00 00 00");
    });

    test("a negative delay sets the 0x8000 sign word", () => {
        expect(hex(encodeCommand(listDelay(List.LaserOnDelay, -20)))).toBe(
            "07 80 14 00 00 80 00 00 00 00 00 00",
        );
        expect(hex(encodeCommand(listDelay(List.LaserOffDelay, 180)))).toBe(
            "08 80 b4 00 00 00 00 00 00 00 00 00",
        );
    });

    test("speed: 1000 mm/s on a 150 mm lens is 436 galvo units per ms", () => {
        const k = galvosPerMm({ ...defaultJczSettings(), field: 150 });
        expect(speedWord(1000, k)).toBe(436);
        expect(speedWord(1e6, k)).toBe(0xffff);
    });

    test("rounding halves to even, as Python's round() does", () => {
        expect(roundHalfEven(2.5)).toBe(2);
        expect(roundHalfEven(3.5)).toBe(4);
        expect(roundHalfEven(-2.5)).toBe(-2);
        expect(roundHalfEven(2.4)).toBe(2);
    });

    test("lists come in 0xC00-byte packets of 256 commands, padded with end-of-list", () => {
        const commands = Array.from({ length: 300 }, (_, i) => jumpTo(i, i, 0, 0));
        const packets = packLists(commands);
        expect(packets).toHaveLength(2);
        expect(packets[0].length).toBe(LMC_LIST_SIZE);
        expect(hex(packets[1].subarray(44 * 12, 44 * 12 + 2))).toBe("02 80");
        expect(hex(packets[1].subarray(43 * 12, 43 * 12 + 2))).toBe("01 80");
    });

    test("a reply is four little-endian words, the status last", () => {
        expect(decodeReply([1, 0, 2, 0, 3, 0, 0x20, 0])).toEqual([1, 2, 3, 0x20]);
    });

    test("no correction file: a blank table; a float .cor file: 65 × 65 lines", () => {
        expect(correctionCommands(undefined)).toEqual([[Cmd.WriteCorTable, 0]]);
        const header = 0x16 + 0x1fa;
        const bytes = new Uint8Array(header + 65 * 65 * 16);
        const view = new DataView(bytes.buffer);
        const label = "LMC1COR_1.0";
        for (let i = 0; i < label.length; i++) view.setUint16(2 * i, label.charCodeAt(i), true);
        view.setFloat64(header, 12.4, true);
        view.setFloat64(header + 8, -3, true);
        const table = parseCorrectionFile(bytes);
        expect(table).toHaveLength(65 * 65);
        expect(table?.[0]).toEqual([12, 0x8003]);
        const commands = correctionCommands(table);
        expect(commands[0]).toEqual([Cmd.WriteCorTable, 1]);
        expect(commands[1]).toEqual([Cmd.WriteCorLine, 12, 0x8003, 0]);
        expect(commands[2][3]).toBe(1);
    });
});

const square = (): LaserVectorObject => ({
    id: "sq",
    name: "sq",
    kind: "vector",
    x: -5,
    y: -5,
    width: 10,
    height: 10,
    angle: 0,
    lockAspect: true,
    sourceWidth: 10,
    sourceHeight: 10,
    paths: [
        {
            closed: true,
            points: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 10 },
                { x: 0, y: 10 },
            ],
        },
    ],
    op: { ...defaultOperation("line"), power: 50, speed: 60000, frequency: 30 },
});

function galvoProfile(edit: Partial<MachineProfile["jcz"]> = {}): MachineProfile {
    const p = defaultMachineProfile();
    return {
        ...p,
        controller: "jcz",
        origin: "center",
        bedWidth: 150,
        bedHeight: 150,
        jcz: { ...p.jcz, field: 150, swapXY: false, ...edit },
    };
}

describe("galvo mapping", () => {
    test("the bed centre is 0x8000; ±75 mm on a 150 mm lens is the ends of the range", () => {
        const m = new GalvoMapper(galvoProfile());
        expect(m.map({ x: 0, y: 0 })).toEqual([0x8000, 0x8000]);
        expect(m.map({ x: 75, y: -76 })).toEqual([0xffff, 0]);
        expect(m.clipped).toBe(true);
    });

    test("swap, reverse, scale and angle", () => {
        expect(new GalvoMapper(galvoProfile({ swapXY: true })).map({ x: 10, y: 0 })[1]).toBe(0x8000 + 4369);
        expect(new GalvoMapper(galvoProfile({ negate0: true })).map({ x: 10, y: 0 })[0]).toBe(0x8000 - 4369);
        expect(new GalvoMapper(galvoProfile({ scale0: 50 })).map({ x: 10, y: 0 })[0]).toBe(0x8000 + 2185);
        const [a, b] = new GalvoMapper(galvoProfile({ angle: 90 })).map({ x: 10, y: 0 });
        expect([a, b]).toEqual([0x8000, 0x8000 + 4369]);
    });
});

describe("galvo program", () => {
    test("a 10 mm square: header, the pen's settings, a jump and four marks, end of list", () => {
        const job: LaserJobData = { version: 1, origin: "center", objects: [square()] };
        const { commands, seconds } = jczProgram(job, galvoProfile());
        expect(commands.slice(0, 4)).toEqual([
            [List.ReadyMark],
            [List.DelayTime, 800],
            [List.WritePort, 1],
            [List.JumpSpeed, 873],
        ]);
        expect(commands.slice(4, 10)).toEqual([
            [List.MarkCurrent, 2048],
            [List.QSwitchPeriod, 667],
            [List.MarkSpeed, 436],
            [List.LaserOnDelay, 100, 0],
            [List.LaserOffDelay, 100, 0],
            [List.PolygonDelay, 100, 0],
        ]);
        const moves = commands.filter((c) => c[0] === List.JumpTo || c[0] === List.MarkTo);
        expect(moves.map((c) => c[0])).toEqual([
            List.JumpTo,
            List.MarkTo,
            List.MarkTo,
            List.MarkTo,
            List.MarkTo,
        ]);
        // −5 mm is 2184.5 galvo units below the centre
        expect(moves[0].slice(1, 3)).toEqual([0x8000 - 2184, 0x8000 - 2184]);
        expect(commands[commands.length - 1]).toEqual([List.EndOfList]);
        // 40 mm at 1000 mm/s plus the jump and the delays
        expect(seconds).toBeGreaterThan(0.04);
        expect(seconds).toBeLessThan(0.05);
    });

    test("a red-light round: light off for the jump, on along the path, never a mark", () => {
        const round = jczLightRound(
            [
                [
                    { x: 0, y: 0 },
                    { x: 10, y: 0 },
                    { x: 0, y: 0 },
                ],
            ],
            galvoProfile(),
        );
        expect(round[0]).toEqual([List.WritePort, 0]);
        expect(round).toContainEqual([List.WritePort, 1 << 8]);
        expect(round.some((c) => c[0] === List.MarkTo)).toBe(false);
    });
});

const MARKCFG = [
    "[LMC_CFG]",
    "LASERTYPE=3",
    "FIELDSIZE=1.100000e+002",
    "FIELDOFFSETX=1.000000e+000",
    "FIELDOFFSETY=-2.000000e+000",
    "FIELDANGLE=9.000000e+001",
    "GALVOX=1",
    "GALVODISTOR0=9.800000e-001",
    "GALVODISTOR1=1.000000e+000",
    "GALVOASPECT0=9.900000e+001",
    "GALVOASPECT1=1.010000e+002",
    "GALVONEGATE0=1",
    "GALVONEGATE1=0",
    "MAXPWMFREQ=80000",
    "MINPWMFREQ=20000",
    "REDLIGHTSPEED=2.500000e+003",
    "REDLIGHTOFFSETX=5.000000e-001",
    "REDLIGHTOFFSETY=0.000000e+000",
    "m_nIPGOpenMoDelayTimeMs=10",
    "ENABLECORFILE=1",
    "CORFILE=C:\\lens\\f110.cor",
].join("\r\n");

const MARKPARAM = [
    "[LASERMODE]",
    "YAG=1",
    "",
    "[Default]",
    "MARKSPEED=5.000000e+002",
    "POWERRATIO=6.000000e+001",
    "FREQ=40000",
    "STARTTC=-50",
    "LASEROFFTC=150",
    "POLYTC=80",
    "JUMPSPEED=3.000000e+003",
    "m_nMinJumpDelayTCUs=200",
    "m_nMaxJumpDelayTCUs=400",
    "m_dJumpLengthLimit=3.000000e+001",
    "QPULSEWIDTH=4.000000e+000",
    "",
    "[Deep]",
    "MARKSPEED=1.000000e+002",
    "POWERRATIO=1.000000e+002",
    "FREQ=20000",
].join("\r\n");

describe("EzCAD settings import", () => {
    test("markcfg: field, offset, angle, galvo wiring and scale, frequency range, red pointer", () => {
        const result = importMarkcfg(MARKCFG, defaultJczSettings());
        const j = result.jcz;
        expect([j.field, j.offsetX, j.offsetY, j.angle]).toEqual([110, 1, -2, 90]);
        expect([j.swapXY, j.negate0, j.negate1]).toEqual([true, true, false]);
        expect([j.scale0, j.scale1]).toEqual([99, 101]);
        expect([j.minFrequency, j.maxFrequency, j.laserType]).toEqual([20, 80, 3]);
        expect([j.lightSpeed, j.lightOffsetX, j.openMoDelay]).toEqual([2500, 0.5, 10]);
        expect(result.correctionFile).toBe("C:\\lens\\f110.cor");
        expect(result.notApplied).toEqual(["GALVODISTOR0=0.98"]);
        expect(j.distortion).toEqual([0.98, 1]);
    });

    test("MarkParam.lib: one pen per section, the first pen's jumps for the machine", () => {
        const result = importMarkParam(MARKPARAM, defaultJczSettings());
        const j = result.jcz;
        expect(j.pens.map((p) => p.name)).toEqual(["Default", "Deep"]);
        expect(j.pens[0]).toEqual({
            name: "Default",
            speed: 500,
            power: 60,
            frequency: 40,
            pulseWidth: 4,
            laserOnDelay: -50,
            laserOffDelay: 150,
            polygonDelay: 80,
        });
        expect([j.jumpSpeed, j.jumpDelayShort, j.jumpDelayLong, j.jumpLongDistance]).toEqual([
            3000, 200, 400, 30,
        ]);
    });
});
