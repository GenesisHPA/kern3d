// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { EditableShapeNode, type GroupNode, type INode, MeshNode, PubSub, ShapeTypes } from "@chili3d/core";
import {
    binaryStl,
    boxTriangles,
    createMockApplication,
    createMockVisualWithDocument,
    TestDocument,
} from "@chili3d/core/test-utils";
import { initWasm, OccShapeConverter, runInSandboxKernel, ShapeFactory } from "@chili3d/wasm";
import { rs } from "@rstest/core";
import { importStlNode } from "../src/stlImport";
import { stlToMesh } from "../src/stlMesh";

beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(path.resolve(import.meta.dirname, "../../wasm/lib/chili-wasm.wasm")),
    });
    for (const [name, value] of [
        ["shapeFactory", new ShapeFactory()],
        ["shapeConverter", new OccShapeConverter()],
    ] as const) {
        Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
    }
});

function newDocument() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

const children = (node: INode) => {
    const out: INode[] = [];
    for (let c = (node as GroupNode).firstChild; c !== undefined; c = c.nextSibling) out.push(c);
    return out;
};

const CUBE = binaryStl(boxTriangles([0, 0, 0], [10, 10, 10]));
const trap = () => {
    throw new WebAssembly.RuntimeError("memory access out of bounds");
};

describe("STL import through a sandbox kernel", () => {
    test("a good STL comes in as one solid body named after the file", async () => {
        const doc = newDocument();
        const imported = await importStlNode(doc, "cube.stl", CUBE);
        expect(imported.isOk).toBe(true);
        expect(imported.value.name).toBe("cube.stl");
        const [body] = children(imported.value);
        expect(body).toBeInstanceOf(EditableShapeNode);
        expect(body.name).toBe("cube");
        const shape = (body as EditableShapeNode).shape.value;
        expect(shape.shapeType).toBe(ShapeTypes.solid);
        expect(shape.volume()).toBeCloseTo(1000, 6);
        expect(shape.findSubShapes(ShapeTypes.face).length).toBe(6);
    });

    test("a kernel crash converting one file costs that file, not the next import", async () => {
        const doc = newDocument();
        const shared = globalThis.wasm;
        const sewing = shapeFactory.sewing;
        const toasts: unknown[][] = [];
        const pub = rs.spyOn(PubSub.default, "pub").mockImplementation((...args: unknown[]) => {
            toasts.push(args);
        });
        try {
            // the trap the user's 124 300-triangle STL raised, inside the conversion
            shapeFactory.sewing = trap;
            const bad = await importStlNode(doc, "bad.stl", CUBE);
            expect(globalThis.wasm).toBe(shared);
            expect(bad.isOk).toBe(true);
            const [mesh] = children(bad.value);
            expect(mesh).toBeInstanceOf(MeshNode);
            expect((mesh as MeshNode).mesh.position?.length).toBe(12 * 9);
            expect(toasts).toContainEqual(["showToast", "toast.import.stlKernelCrash"]);
        } finally {
            shapeFactory.sewing = sewing;
            pub.mockRestore();
        }
        const good = await importStlNode(doc, "good.stl", CUBE);
        const [body] = children(good.value);
        expect(body).toBeInstanceOf(EditableShapeNode);
        expect((body as EditableShapeNode).shape.value.volume()).toBeCloseTo(1000, 6);
    });

    test("bytes that are no STL at all are refused, not turned into an empty mesh", async () => {
        const imported = await importStlNode(newDocument(), "junk.stl", new Uint8Array([1, 2, 3]));
        expect(imported.isOk).toBe(false);
    });
});

describe("runInSandboxKernel", () => {
    test("the action runs against a kernel of its own, and the shared one is back after", async () => {
        const shared = globalThis.wasm;
        let inside: unknown;
        const run = await runInSandboxKernel(() => {
            inside = globalThis.wasm;
            return 7;
        });
        expect(run).toEqual({ ok: true, value: 7 });
        expect(inside).not.toBe(shared);
        expect(globalThis.wasm).toBe(shared);
    });

    test("a trap is reported as a crash, a plain failure is not", async () => {
        const crashed = await runInSandboxKernel(trap);
        expect(crashed).toEqual({ ok: false, crashed: true, error: "memory access out of bounds" });
        const failed = await runInSandboxKernel(() => {
            throw new Error("can not convert");
        });
        expect(failed).toEqual({ ok: false, crashed: false, error: "can not convert" });
    });
});

describe("stlToMesh", () => {
    test("binary and ASCII STL read alike", () => {
        const ascii = new TextEncoder().encode(
            "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n",
        );
        expect(Array.from(stlToMesh(ascii)!.position!)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        expect(Array.from(stlToMesh(ascii)!.normal!.slice(0, 3))).toEqual([0, 0, 1]);
        expect(stlToMesh(CUBE)!.position!.length).toBe(12 * 9);
    });
});

/**
 * The user's files (`KERN3D_STL_FILES`, `;`-separated, not committed) — each takes minutes. The
 * point is the second import: before the sandbox, the first one's trap left every later import
 * failing until the app was restarted.
 */
const REAL_FILES = (process.env["KERN3D_STL_FILES"] ?? "").split(";").filter((f) => f && existsSync(f));

describe.skipIf(REAL_FILES.length === 0)("the user's STL files", () => {
    test.each(
        REAL_FILES,
    )("%s imports (as a body or a mesh), and a good STL still imports after it", async (file) => {
        const doc = newDocument();
        const imported = await importStlNode(doc, path.basename(file), new Uint8Array(readFileSync(file)));
        expect(imported.isOk).toBe(true);
        expect(children(imported.value).length).toBeGreaterThan(0);
        const good = await importStlNode(doc, "good.stl", CUBE);
        const [body] = children(good.value);
        expect((body as EditableShapeNode).shape.value.volume()).toBeCloseTo(1000, 6);
    }, 1_800_000);
});
