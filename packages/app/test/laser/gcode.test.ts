// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { fmt, frameGcode, generateGcode } from "../../src/laser/gcode";
import {
    defaultOperation,
    type LaserImageObject,
    type LaserJobData,
    type LaserVectorObject,
    parseLaserJob,
    stringifyLaserJob,
} from "../../src/laser/laserData";
import { defaultMachineProfile, type MachineProfile, normalizeProfile } from "../../src/laser/machineProfile";
import { dither, type GrayImage, grayFromRgba, powerMap, resampleGray } from "../../src/laser/raster";
import { estimateTime, formatDuration, parseToolpath, trapezoidTime } from "../../src/laser/toolpath";

const profile: MachineProfile = { ...defaultMachineProfile(), returnHome: false };

function squareObject(): LaserVectorObject {
    return {
        id: "sq",
        name: "square",
        kind: "vector",
        x: 0,
        y: 0,
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
        op: { ...defaultOperation("line"), power: 50, speed: 1000 },
    };
}

function body(lines: string[]): string[] {
    return lines.filter((l) => !l.startsWith(";"));
}

describe("vector G-code", () => {
    test("a 10 × 10 square is traced once round at S500 F1000", () => {
        const job: LaserJobData = { version: 1, objects: [squareObject()] };
        const { lines, warnings } = generateGcode(job, profile);
        expect(warnings).toEqual([]);
        expect(body(lines)).toEqual([
            "G21",
            "G90",
            "M4 S0",
            "G0 X0 Y0",
            "G1 X10 S500 F1000",
            "G1 Y10",
            "G1 X0",
            "G1 Y0",
            "M5",
        ]);
    });

    test("M3 when dynamic power is off, two passes, air assist and the return home", () => {
        const square = { ...squareObject(), x: 20, y: 20 };
        square.op.passes = 2;
        square.op.air = true;
        const { lines } = generateGcode(
            { version: 1, objects: [square] },
            { ...profile, dynamicPower: false, returnHome: true },
        );
        const b = body(lines);
        expect(b[2]).toBe("M3 S0");
        expect(b[3]).toBe("M8");
        expect(b.filter((l) => l.startsWith("G1")).length).toBe(8);
        expect(b.slice(-3)).toEqual(["M9", "M5", "G0 X0 Y0"]);
    });

    test("the object's placement moves, scales and turns its outline", () => {
        const square = { ...squareObject(), x: 20, y: 30, width: 20, height: 20, angle: 90 };
        const { lines } = generateGcode({ version: 1, objects: [square] }, profile);
        const moves = parseToolpath(lines, profile.rapid);
        const xs = moves.flatMap((m) => [m.x1]);
        const ys = moves.flatMap((m) => [m.y1]);
        expect(Math.min(...xs)).toBeCloseTo(20, 6);
        expect(Math.max(...xs)).toBeCloseTo(40, 6);
        expect(Math.min(...ys)).toBeCloseTo(30, 6);
        expect(Math.max(...ys)).toBeCloseTo(50, 6);
    });

    test("fill mode hatches the square bidirectionally", () => {
        const square = squareObject();
        square.op = { ...square.op, mode: "fill", fillInterval: 2.5 };
        const b = body(generateGcode({ version: 1, objects: [square] }, profile).lines);
        expect(b.slice(3, -1)).toEqual([
            "G0 X0 Y1.25",
            "G1 X10 S500 F1000",
            "G0 Y3.75",
            "G1 X0",
            "G0 Y6.25",
            "G1 X10",
            "G0 Y8.75",
            "G1 X0",
        ]);
    });

    test("a job past the bed is flagged", () => {
        const square = { ...squareObject(), x: 395 };
        expect(generateGcode({ version: 1, objects: [square] }, profile).warnings).toContain(
            "laser.warn.outsideBed",
        );
    });

    test("numbers are written the way GRBL reads them", () => {
        expect(fmt(1.23456)).toBe("1.235");
        expect(fmt(-0.0001)).toBe("0");
        expect(fmt(10)).toBe("10");
    });
});

function imageObject(
    width: number,
    height: number,
    pixelWidth: number,
    pixelHeight: number,
): LaserImageObject {
    const op = defaultOperation("image");
    op.power = 100;
    op.speed = 1000;
    op.raster = { ...op.raster, resolution: 10, overscan: 0, whiteClip: 0 };
    return {
        id: "img",
        name: "img",
        kind: "image",
        x: 0,
        y: 0,
        width,
        height,
        angle: 0,
        lockAspect: true,
        dataUrl: "data:,",
        pixelWidth,
        pixelHeight,
        op,
    };
}

describe("raster G-code", () => {
    test("a 2 × 2 gray image burns each pixel with power by darkness, bottom row first", () => {
        // top row: black, mid grey; bottom row: white, quarter grey
        const image: GrayImage = { width: 2, height: 2, data: Float32Array.from([0, 0.5, 1, 0.75]) };
        const o = imageObject(0.2, 0.2, 2, 2);
        const b = body(generateGcode({ version: 1, objects: [o] }, profile, new Map([["img", image]])).lines);
        expect(b.slice(3, -1)).toEqual([
            // bottom row (y 0.05), left to right: the white pixel is the leading blank, skipped
            "G0 X0.1 Y0.05",
            "G1 X0.2 S250 F1000",
            // top row (y 0.15) runs back: grey then black
            "G0 Y0.15",
            "G1 X0.1 S500",
            "G1 X0 S1000",
        ]);
    });

    test("overscan runs the head past each line with the laser at S0", () => {
        const image: GrayImage = { width: 2, height: 1, data: Float32Array.from([0, 0]) };
        const o = imageObject(0.2, 0.1, 2, 1);
        o.x = 10;
        o.op.raster.overscan = 2;
        const b = body(generateGcode({ version: 1, objects: [o] }, profile, new Map([["img", image]])).lines);
        expect(b.slice(3, -1)).toEqual(["G0 X8 Y0.05", "G1 X10 S0 F1000", "G1 X10.2 S1000", "G1 X12.2 S0"]);
    });

    test("a long white gap inside a line is crossed with G0", () => {
        // 30 pixels at 10/mm: black, 28 white (2.8 mm), black
        const data = new Float32Array(30).fill(1);
        data[0] = 0;
        data[29] = 0;
        const o = imageObject(3, 0.1, 30, 1);
        const b = body(
            generateGcode(
                { version: 1, objects: [o] },
                profile,
                new Map([["img", { width: 30, height: 1, data }]]),
            ).lines,
        );
        expect(b.slice(3, -1)).toEqual(["G0 X0 Y0.05", "G1 X0.1 S1000 F1000", "G0 X2.9", "G1 X3"]);
    });

    test("a missing picture is reported, not burnt", () => {
        const o = imageObject(1, 1, 2, 2);
        expect(generateGcode({ version: 1, objects: [o] }, profile).warnings).toEqual([
            "laser.warn.imageMissing",
        ]);
    });
});

describe("image processing", () => {
    test("RGBA to lightness, transparent as white", () => {
        const g = grayFromRgba([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0], 3, 1);
        expect(Array.from(g.data)).toEqual([0, 1, 1]);
    });

    test("area resampling averages a 2 × 2 block", () => {
        const g = resampleGray({ width: 2, height: 2, data: Float32Array.from([0, 1, 1, 0]) }, 1, 1);
        expect(g.data[0]).toBeCloseTo(0.5, 6);
    });

    test("Floyd–Steinberg is deterministic and keeps the mean tone", () => {
        const image: GrayImage = { width: 8, height: 8, data: new Float32Array(64).fill(0.5) };
        const a = dither(image, "floyd");
        const b = dither(image, "floyd");
        expect(Array.from(a)).toEqual(Array.from(b));
        const burnt = a.reduce((n, v) => n + v, 0);
        expect(burnt).toBeGreaterThanOrEqual(28);
        expect(burnt).toBeLessThanOrEqual(36);
        // a flat half-grey row alternates
        expect(
            Array.from(dither({ width: 4, height: 1, data: new Float32Array(4).fill(0.5) }, "floyd")),
        ).toEqual([0, 1, 0, 1]);
    });

    test("Jarvis dithering is deterministic", () => {
        const data = Float32Array.from({ length: 36 }, (_, i) => i / 35);
        const image: GrayImage = { width: 6, height: 6, data };
        expect(Array.from(dither(image, "jarvis"))).toEqual(Array.from(dither(image, "jarvis")));
    });

    test("threshold and invert", () => {
        const image: GrayImage = { width: 3, height: 1, data: Float32Array.from([0.2, 0.6, 0.9]) };
        const raster = { ...defaultOperation("image").raster, mode: "threshold" as const, threshold: 50 };
        expect(Array.from(powerMap(image, raster))).toEqual([1, 0, 0]);
        expect(Array.from(powerMap(image, { ...raster, invert: true }))).toEqual([0, 1, 1]);
    });
});

describe("time estimate", () => {
    test("one 100 mm move at 100 mm/s with 1000 mm/s² takes 1.1 s", () => {
        const moves = parseToolpath(["G1 X100 F6000"], 6000);
        expect(estimateTime(moves, { accel: 1000, junctionDeviation: 0.01 })).toBeCloseTo(1.1, 6);
    });

    test("a short move never reaches its feed", () => {
        // 10 mm: accelerate 5 mm, decelerate 5 mm, peak 100 mm/s
        expect(trapezoidTime(10, 0, 0, 1000, 1000)).toBeCloseTo(0.2, 6);
    });

    test("a straight continuation does not stop between moves", () => {
        const split = parseToolpath(["G1 X50 F6000", "G1 X100"], 6000);
        expect(estimateTime(split, { accel: 1000, junctionDeviation: 0.01 })).toBeCloseTo(1.1, 6);
    });

    test("G0 runs at the rapid rate and the laser is off on it", () => {
        const moves = parseToolpath(["M4 S0", "G0 X10", "G1 X20 S300 F600", "M5", "G1 X30"], 3000);
        expect(moves.map((m) => [m.rapid, m.power, m.feed])).toEqual([
            [true, 0, 3000],
            [false, 300, 600],
            [false, 0, 600],
        ]);
    });

    test("durations read as h:mm:ss", () => {
        expect(formatDuration(3909)).toBe("1:05:09");
        expect(formatDuration(247)).toBe("4:07");
    });
});

describe("frame", () => {
    test("laser off: M5 and the box traced", () => {
        const lines = frameGcode({ minX: 1, minY: 2, maxX: 11, maxY: 12 }, profile);
        expect(lines).toEqual([
            "G21",
            "G90",
            "M5",
            "G0 X1 Y2",
            "G1 X11 Y2 F3000",
            "G1 X11 Y12 F3000",
            "G1 X1 Y12 F3000",
            "G1 X1 Y2 F3000",
        ]);
    });

    test("low power: M3 at the frame power, off at the end", () => {
        const lines = frameGcode({ minX: 0, minY: 0, maxX: 5, maxY: 5 }, { ...profile, framePower: 1 });
        expect(lines).toContain("M3 S0");
        expect(lines).toContain("G1 X5 S10 F3000");
        expect(lines[lines.length - 1]).toBe("M5");
    });
});

describe("stored data", () => {
    test("a job survives its JSON", () => {
        const job: LaserJobData = { version: 1, objects: [squareObject()] };
        expect(parseLaserJob(stringifyLaserJob(job))).toEqual(job);
    });

    test("junk reads as an empty job", () => {
        expect(parseLaserJob("{not json")).toEqual({ version: 1, objects: [] });
    });

    test("a machine profile keeps sane values and defaults the rest", () => {
        const p = normalizeProfile({ bedWidth: 300, maxS: -5, dynamicPower: false } as never);
        expect(p.bedWidth).toBe(300);
        expect(p.maxS).toBe(1000);
        expect(p.dynamicPower).toBe(false);
        expect(p.baud).toBe(115200);
    });
});
