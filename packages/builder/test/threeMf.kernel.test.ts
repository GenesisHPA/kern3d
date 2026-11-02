// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Plane, XYZ } from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { beforeAll, describe, expect, test } from "@rstest/core";
import JSZip from "jszip";
import { buildThreeMf, threeMfModelXml, weldMesh } from "../src/threeMf";

beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(path.resolve(import.meta.dirname, "../../wasm/lib/chili-wasm.wasm")),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

function boxObject(name: string, x: number) {
    const shape = shapeFactory.box(Plane.XY.translateTo(new XYZ({ x, y: 0, z: 0 })), 10, 20, 30).value;
    const faces = shape.mesh.faces!;
    return { name, position: faces.position, index: faces.index };
}

function countOf(xml: string, tag: string) {
    return xml.match(new RegExp(`<${tag}\\b`, "g"))?.length ?? 0;
}

/** Twice the signed volume sum, read back from the parsed XML, so winding is checked as written. */
function signedVolumeOf(object: Element) {
    const v = [...object.getElementsByTagName("vertex")].map((e) =>
        ["x", "y", "z"].map((k) => Number(e.getAttribute(k))),
    );
    let volume = 0;
    for (const t of object.getElementsByTagName("triangle")) {
        const [a, b, c] = ["v1", "v2", "v3"].map((k) => v[Number(t.getAttribute(k))]);
        volume +=
            a[0] * (b[1] * c[2] - b[2] * c[1]) -
            a[1] * (b[0] * c[2] - b[2] * c[0]) +
            a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    return volume / 6;
}

describe("3MF export", () => {
    test("welding a kernel box mesh leaves a closed 8-vertex, 12-triangle mesh", () => {
        const box = boxObject("b", 0);
        const welded = weldMesh(box.position, box.index);
        expect(welded.vertices.length / 3).toBe(8);
        expect(welded.triangles.length / 3).toBe(12);
        // Closed: every undirected edge is shared by exactly two triangles.
        const edges = new Map<string, number>();
        for (let t = 0; t < welded.triangles.length; t += 3) {
            for (let k = 0; k < 3; k++) {
                const a = welded.triangles[t + k];
                const b = welded.triangles[t + ((k + 1) % 3)];
                const key = a < b ? `${a}-${b}` : `${b}-${a}`;
                edges.set(key, (edges.get(key) ?? 0) + 1);
            }
        }
        expect([...edges.values()].every((n) => n === 2)).toBe(true);
    });

    test("welding flips an inward-wound mesh so it encloses positive volume", () => {
        const box = boxObject("b", 0);
        const reversed = new Uint32Array(box.index);
        for (let t = 0; t < reversed.length; t += 3)
            [reversed[t + 1], reversed[t + 2]] = [reversed[t + 2], reversed[t + 1]];
        const xml = threeMfModelXml([{ name: "r", position: box.position, index: reversed }]);
        const doc = new DOMParser().parseFromString(xml, "application/xml");
        expect(signedVolumeOf(doc.getElementsByTagName("object")[0])).toBeCloseTo(6000, 3);
    });

    test("the package holds the three core parts with one object and build item per body", async () => {
        const data = await buildThreeMf([boxObject("left & <one>", 0), boxObject("right", 50)]);
        const zip = await JSZip.loadAsync(data);
        expect(
            Object.keys(zip.files)
                .filter((f) => !zip.files[f].dir)
                .sort(),
        ).toEqual(["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]);

        const types = await zip.file("[Content_Types].xml")!.async("string");
        expect(types).toContain(
            'Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"',
        );
        const rels = await zip.file("_rels/.rels")!.async("string");
        expect(rels).toContain('Target="/3D/3dmodel.model"');
        expect(rels).toContain('Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"');

        const model = await zip.file("3D/3dmodel.model")!.async("string");
        const doc = new DOMParser().parseFromString(model, "application/xml");
        expect(doc.getElementsByTagName("parsererror").length).toBe(0);
        const root = doc.documentElement;
        expect(root.getAttribute("unit")).toBe("millimeter");
        expect(root.getAttribute("xmlns")).toBe("http://schemas.microsoft.com/3dmanufacturing/core/2015/02");

        const objects = [...doc.getElementsByTagName("object")];
        expect(objects.map((o) => o.getAttribute("name"))).toEqual(["left & <one>", "right"]);
        expect(objects.map((o) => o.getAttribute("id"))).toEqual(["1", "2"]);
        for (const object of objects) {
            expect(object.getElementsByTagName("vertex").length).toBe(8);
            expect(object.getElementsByTagName("triangle").length).toBe(12);
            expect(signedVolumeOf(object)).toBeCloseTo(6000, 3);
        }
        expect(countOf(model, "item")).toBe(2);
        const xs = [...objects[1].getElementsByTagName("vertex")].map((e) => Number(e.getAttribute("x")));
        expect(Math.min(...xs)).toBe(50);
        expect(Math.max(...xs)).toBe(60);
    });
});
