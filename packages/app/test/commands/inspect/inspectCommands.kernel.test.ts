// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
    type AsyncController,
    CancelableCommand,
    EditableShapeNode,
    type IApplication,
    type IDocument,
    type INode,
    type IView,
    Plane,
    PointOnAxisStep,
    Result,
    type ShapeMeshData,
    XYZ,
} from "@chili3d/core";
import { createMockDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { afterEach, beforeAll, describe, expect, rs, test } from "@rstest/core";
import { InterferenceCommand } from "../../../src/commands/inspect/interferenceCommand";
import { DENSITY_PRESETS } from "../../../src/commands/inspect/massProperties";
import { MATERIAL_KEYS, MassPropertiesCommand } from "../../../src/commands/inspect/massPropertiesCommand";
import {
    clearSection,
    SectionAnalysisCommand,
    sectionPlaneOf,
} from "../../../src/commands/inspect/sectionCommand";

beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(path.resolve(import.meta.dirname, "../../../../wasm/lib/chili-wasm.wasm")),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

afterEach(() => {
    rs.restoreAllMocks();
});

interface Harness {
    app: IApplication;
    doc: IDocument;
    view: IView & { sectionPlane?: Plane };
    displayMesh: ReturnType<typeof rs.fn>;
    removeMesh: ReturnType<typeof rs.fn>;
    nodes: INode[];
}

/**
 * A document whose selection holds `boxes` as real kernel bodies and whose picker cancels the
 * follow-up pick, calling `onPick` first so a test can read the panel while the tool still runs.
 */
function harness(boxes: [number, number, number, number][], onPick: () => void = () => {}): Harness {
    const nodes: INode[] = [];
    const doc = createMockDocument({
        selection: { getSelectedNodes: () => nodes },
        modelManager: {
            findNodes: (predicate?: (node: INode) => boolean) => nodes.filter((n) => predicate?.(n) ?? true),
        },
    });
    for (const [x, y, z, size] of boxes) {
        const shape = shapeFactory.box(Plane.XY.translateTo(new XYZ({ x, y, z })), size, size, size).value;
        nodes.push(
            new EditableShapeNode({ document: doc, name: `box${nodes.length + 1}`, shape: Result.ok(shape) }),
        );
    }
    (doc as any).picker = {
        pickNode: async (_prompt: string, controller: AsyncController) => {
            onPick();
            controller.cancel();
            return [];
        },
    };
    const displayMesh = rs.fn((_datas: ShapeMeshData[], _option?: unknown) => 42);
    const removeMesh = rs.fn((_id: number) => {});
    Object.assign(doc.visual.context, { displayMesh, removeMesh });
    const dom = document.createElement("div");
    const state: { sectionPlane?: Plane } = {};
    const view = Object.assign(state, {
        document: doc,
        dom,
        workplane: Plane.XY,
        update: () => {},
        htmlText: () => ({ dispose: () => {}, update: () => {} }),
        setSectionPlane: (plane: Plane | undefined) => {
            state.sectionPlane = plane;
        },
    }) as unknown as Harness["view"];
    const app = { activeView: view, views: [view] } as unknown as IApplication;
    return { app, doc, view, displayMesh, removeMesh, nodes };
}

function panelText(view: IView) {
    return view.dom!.textContent ?? "";
}

describe("MassPropertiesCommand", () => {
    test("every material in the list names a density preset", () => {
        expect(Object.values(MATERIAL_KEYS).sort()).toEqual(Object.keys(DENSITY_PRESETS).sort());
    });

    test("shows mass at the material's density and marks the centre of mass", async () => {
        let text = "";
        // A starting command reads its parameters from the shared cache, so seed it there.
        CancelableCommand.seedOptions("inspect.massProperties", {
            material: "inspect.material.pla",
            density: DENSITY_PRESETS.PLA,
        });
        const cmd = new MassPropertiesCommand();
        const h = harness([[0, 0, 0, 20]], () => {
            text = panelText(h.view);
            cmd.material = "inspect.material.steel";
            text += `|${panelText(h.view)}`;
        });
        await cmd.execute(h.app);

        const [pla, steel] = text.split("|");
        expect(pla).toContain(`${((8000 / 1000) * 1.24).toFixed(2)} g`);
        expect(pla).toContain("8000.00 mm³");
        expect(pla).toContain("2400.00 mm²");
        expect(pla).toContain("20.00 × 20.00 × 20.00 mm");
        expect(pla).toContain("10.00, 10.00, 10.00");
        expect(cmd.density).toBe(DENSITY_PRESETS.steel);
        expect(steel).toContain(`${(8 * 7.85).toFixed(2)} g`);

        const marker = h.displayMesh.mock.calls[0][0][0] as { position: Float32Array };
        expect([...marker.position]).toEqual([10, 10, 10]);
        // The tool ended (the pick was cancelled): its card is gone.
        expect(h.view.dom!.childElementCount).toBe(0);
    });
});

describe("InterferenceCommand", () => {
    test("lists the overlapping pair with its volume and highlights the overlap", async () => {
        let text = "";
        const h = harness(
            [
                [0, 0, 0, 10],
                [6, 7, 8, 10],
                [40, 0, 0, 5],
            ],
            () => {
                text = panelText(h.view);
            },
        );
        await new InterferenceCommand().execute(h.app);

        expect(text).toContain("box1 ↔ box2");
        expect(text).toContain("24.00 mm³");
        expect(text).not.toContain("box3 ↔");
        expect(h.displayMesh).toHaveBeenCalledTimes(1);
        // The highlight is removed when the tool ends — the model is never touched.
        expect(h.removeMesh).toHaveBeenCalledWith(42);
    });

    test("reports no interference for separate bodies", async () => {
        let text = "";
        const h = harness(
            [
                [0, 0, 0, 10],
                [20, 0, 0, 10],
            ],
            () => {
                text = panelText(h.view);
            },
        );
        await new InterferenceCommand().execute(h.app);
        expect(text).toContain("inspect.interference.none");
        expect(h.displayMesh).not.toHaveBeenCalled();
    });
});

describe("SectionAnalysisCommand", () => {
    test("sectionPlaneOf offsets along the normal and flips the removed side", () => {
        const base = Plane.XY;
        const plane = sectionPlaneOf(base, 3, false);
        expect(plane.origin.isEqualTo(new XYZ({ x: 0, y: 0, z: 3 }))).toBe(true);
        expect(plane.normal.isEqualTo(XYZ.unitZ)).toBe(true);
        expect(sectionPlaneOf(base, -2, true).normal.isEqualTo(XYZ.unitNZ)).toBe(true);
    });

    function cancelDrag() {
        return rs
            .spyOn(PointOnAxisStep.prototype, "execute")
            .mockImplementation(async (_doc: IDocument, controller: AsyncController) => {
                controller.cancel();
                return undefined;
            });
    }

    test("clips the view by the chosen plane, caps the visible bodies, and toggles off", async () => {
        const drag = cancelDrag();
        const h = harness([[0, 0, 0, 10]]);
        CancelableCommand.seedOptions("inspect.section", {
            source: "inspect.section.xy",
            flip: false,
            caps: true,
            offset: 4,
        });
        await new SectionAnalysisCommand().execute(h.app);

        expect(drag).toHaveBeenCalledTimes(1);
        expect(h.view.sectionPlane?.origin.z).toBeCloseTo(4, 9);
        expect(h.view.sectionPlane?.normal.isEqualTo(XYZ.unitZ)).toBe(true);
        expect(h.displayMesh).toHaveBeenCalledTimes(1);
        const cap = h.displayMesh.mock.calls[0][0].find((m: any) => m.index) as { position: Float32Array };
        for (let i = 2; i < cap.position.length; i += 3) expect(cap.position[i]).toBeCloseTo(4, 5);

        // The section survives the tool; running it again turns it off and drops the caps.
        await new SectionAnalysisCommand().execute(h.app);
        expect(h.view.sectionPlane).toBeUndefined();
        expect(h.removeMesh).toHaveBeenCalledWith(42);
    });

    test("without caps only the clip is set", async () => {
        cancelDrag();
        const h = harness([[0, 0, 0, 10]]);
        CancelableCommand.seedOptions("inspect.section", {
            source: "inspect.section.yz",
            flip: true,
            caps: false,
            offset: 5,
        });
        await new SectionAnalysisCommand().execute(h.app);
        expect(h.view.sectionPlane?.origin.x).toBeCloseTo(5, 9);
        expect(h.view.sectionPlane?.normal.isEqualTo(XYZ.unitNX)).toBe(true);
        expect(h.displayMesh).not.toHaveBeenCalled();
        clearSection(h.view);
        expect(h.view.sectionPlane).toBeUndefined();
    });
});
