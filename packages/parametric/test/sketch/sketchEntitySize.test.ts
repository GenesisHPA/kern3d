// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ICameraController, Plane, PubSub, Result, XYZ } from "@chili3d/core";
import {
    createMockApplication,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import { entitySize } from "../../src/sketch/entitySize";
import { ConstraintKind, entityRadius } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import "./setup";

/** A sketch session on XY with one Ø60 circle and one 40 long line, no dimensions yet. */
function setup() {
    const camera = {
        cameraPosition: new XYZ({ x: 0, y: 0, z: 500 }),
        cameraTarget: XYZ.zero,
        cameraUp: XYZ.unitY,
        cameraType: "perspective" as const,
        lookAt: rs.fn(),
        fitContent: rs.fn(),
    };
    const app = createMockApplication();
    const doc = new TestDocument({ application: app, selection: { clearSelection: rs.fn() } as any });
    doc.visual = createMockVisualWithDocument(doc) as any;
    const view = createMockView({ document: doc, cameraController: camera as unknown as ICameraController });
    (app as any).activeView = view;
    (view as any).htmlText = rs.fn(() => ({ dispose: rs.fn() }));
    (doc.visual.context as any).displayMesh = rs.fn(() => 1);
    (doc.visual.context as any).removeMesh = rs.fn();
    const toasts: string[] = [];
    const originalPub = PubSub.default.pub as unknown as (key: string, ...args: any[]) => void;
    PubSub.default.pub = ((key: string, ...args: any[]) => {
        if (key === "showToast") toasts.push(args[0]);
        originalPub.call(PubSub.default, key, ...args);
    }) as any;
    const previous = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
    Object.defineProperty(globalThis, "shapeFactory", {
        value: {
            line: () => Result.ok({ isEqual: () => false }),
            circle: () => Result.ok({ isEqual: () => false }),
            arc: () => Result.ok({ isEqual: () => false }),
            wire: () => Result.ok({ isEqual: () => false }),
            combine: () => Result.ok({ isEqual: () => false }),
        },
        writable: true,
        configurable: true,
    });
    const host = document.createElement("div");
    (view as any).dom = host;
    const node = new SketchNode({ document: doc, plane: Plane.XY });
    const editor = SketchEditor.enter(node);
    const circle = editor.solver.addCircle(50, 0, 30);
    const line = editor.solver.addLine(0, 0, 40, 0);
    editor.solve(true);
    return {
        editor,
        circle,
        line,
        host,
        toasts,
        restore: () => {
            editor.dispose();
            PubSub.default.pub = originalPub as any;
            if (previous) Object.defineProperty(globalThis, "shapeFactory", previous);
            else delete (globalThis as any).shapeFactory;
        },
    };
}

const panelInput = (host: HTMLElement) => host.querySelector("input") as HTMLInputElement;

function typeInto(input: HTMLInputElement, text: string) {
    input.value = text;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

describe("the selected entity's size panel", () => {
    test("reads a circle as its diameter and a line as its length", () => {
        const { editor, circle, line, restore } = setup();
        try {
            expect(entitySize(editor.solver, circle)).toMatchObject({ kind: "diameter", value: 60 });
            expect(entitySize(editor.solver, line)).toMatchObject({ kind: "length", value: 40 });
        } finally {
            restore();
        }
    });

    test("typing a diameter adds a driving Ø dimension and resizes the circle", () => {
        const { editor, circle, host, restore } = setup();
        try {
            editor.showEntitySize([circle]);
            const input = panelInput(host);
            expect(input.value).toBe("60");
            typeInto(input, "20");
            expect(entityRadius(editor.solver.entity(circle)!)).toBeCloseTo(10, 6);
            const radius = editor.solver.toData().constraints.filter((c) => c.kind === ConstraintKind.Radius);
            expect(radius).toHaveLength(1);
            expect(radius[0].display).toBe("diameter");
            // the panel follows the solve
            expect(input.value).toBe("20");

            // a second edit writes the same dimension rather than adding another
            typeInto(input, "35,5");
            expect(entityRadius(editor.solver.entity(circle)!)).toBeCloseTo(17.75, 6);
            expect(
                editor.solver.toData().constraints.filter((c) => c.kind === ConstraintKind.Radius),
            ).toHaveLength(1);
        } finally {
            restore();
        }
    });

    test("typing a line length dimensions the line", () => {
        const { editor, line, host, restore } = setup();
        try {
            editor.showEntitySize([line]);
            typeInto(panelInput(host), "75");
            const e = editor.solver.entity(line)!;
            expect(Math.hypot(e.params[2] - e.params[0], e.params[3] - e.params[1])).toBeCloseTo(75, 6);
        } finally {
            restore();
        }
    });

    test("hides for no selection or several entities, and refuses a zero size", () => {
        const { editor, circle, line, host, toasts, restore } = setup();
        try {
            editor.showEntitySize([circle, line]);
            expect(host.firstElementChild).toBeNull();
            editor.showEntitySize([circle]);
            const panel = host.firstElementChild as HTMLElement;
            editor.showEntitySize([]);
            expect(panel.style.display).toBe("none");
            editor.showEntitySize([circle]);
            typeInto(panelInput(host), "0");
            expect(toasts).toContain("sketch.size.invalid");
            expect(entityRadius(editor.solver.entity(circle)!)).toBeCloseTo(30, 6);
        } finally {
            restore();
        }
    });
});
