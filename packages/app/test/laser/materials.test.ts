import { describe, expect, test } from "@rstest/core";
import { defaultOperation } from "../../src/laser/laserData";
import {
    applyMaterial,
    defaultTestMatrix,
    matrixCells,
    parseMaterials,
    presetOf,
    steps,
} from "../../src/laser/materials";

describe("laser materials", () => {
    test("steps include both ends", () => {
        expect(steps(20, 100, 5)).toEqual([20, 40, 60, 80, 100]);
        expect(steps(7, 9, 1)).toEqual([7]);
    });
    test("matrix: power across, speed down, top row at 0", () => {
        const spec = { ...defaultTestMatrix(), columns: 3, rows: 2, cell: 5, gap: 2 };
        const cells = matrixCells(spec);
        expect(cells.length).toBe(6);
        expect(cells[0]).toEqual({ x: 0, y: -5, power: 20, speed: 500 });
        expect(cells[2].x).toBe(14);
        expect(cells[3].y).toBe(-12);
        expect(cells[5].speed).toBe(3000);
    });
    test("preset round trip; an image keeps its mode", () => {
        const op = { ...defaultOperation("fill"), power: 33, speed: 777 };
        const [m] = parseMaterials(JSON.stringify([presetOf("Al", op), { name: "" }]));
        expect(m.power).toBe(33);
        const img = defaultOperation("image");
        applyMaterial(img, m);
        expect(img.mode).toBe("image");
        expect(img.speed).toBe(777);
    });
});
