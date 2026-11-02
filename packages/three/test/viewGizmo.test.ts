// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { CAMERA_FLY_DURATION, type XYZ } from "@chili3d/core";
import { PerspectiveCamera, Vector3 } from "three";
import type { CameraController } from "../src/cameraController";
import type { ThreeView } from "../src/threeView";
import type { CubeTarget, ViewGizmo } from "../src/viewGizmo";

let ViewGizmoCtor: typeof ViewGizmo;

beforeAll(async () => {
    // Importing the real module registers the "view-gizmo" custom element tag, but the test
    // stub (test/viewGizmo.ts, wired via the "./viewGizmo" alias used by threeView) may have
    // claimed that tag already, depending on test-file evaluation order. Skip duplicate
    // registrations so the import cannot throw in either order.
    const originalDefine = customElements.define.bind(customElements);
    customElements.define = (name, ctor, options) => {
        if (!customElements.get(name)) {
            originalDefine(name, ctor, options);
        }
    };
    try {
        ViewGizmoCtor = (await import("../src/viewGizmo")).ViewGizmo;
    } finally {
        customElements.define = originalDefine;
    }
    // Happy-DOM rejects `new` on unregistered custom element classes, so make sure the real
    // class is registered under some tag even when the stub owns "view-gizmo".
    if (customElements.get("view-gizmo") !== ViewGizmoCtor) {
        customElements.define("view-gizmo-real", ViewGizmoCtor);
    }
});

/**
 * Happy-DOM does not implement the 2D canvas context, so stub getContext
 * with a call-counting fake for the duration of these tests.
 */
interface Fake2dContext {
    calls: { clearRect: number; fillText: number; fill: number; stroke: number; setTransform: number };
}

let fakeContext: Fake2dContext;
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

function createFake2dContext(): Fake2dContext {
    const calls = { clearRect: 0, fillText: 0, fill: 0, stroke: 0, setTransform: 0 };
    const count = (key: keyof typeof calls) => () => {
        calls[key]++;
    };
    return {
        calls,
        clearRect: count("clearRect"),
        beginPath: () => {},
        arc: () => {},
        fill: count("fill"),
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        stroke: count("stroke"),
        fillText: count("fillText"),
        save: () => {},
        restore: () => {},
        setTransform: count("setTransform"),
        measureText: () => ({ width: 100 }),
        font: "",
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 0,
        textBaseline: "",
        textAlign: "",
    } as unknown as Fake2dContext;
}

beforeEach(() => {
    fakeContext = createFake2dContext();
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() =>
        fakeContext) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
});

interface MockController {
    camera: PerspectiveCamera;
    target: Vector3;
    rotate: ReturnType<typeof rs.fn>;
    setRotateCenterToSelected: ReturnType<typeof rs.fn>;
    lookAt: ReturnType<typeof rs.fn>;
    fitContent: ReturnType<typeof rs.fn>;
}

/** The camera sits on +Z looking down (the top view), so the top face faces the viewer. */
function createGizmo(): { gizmo: ViewGizmo; cc: MockController; update: ReturnType<typeof rs.fn> } {
    const cc: MockController = {
        camera: new PerspectiveCamera(),
        target: new Vector3(0, 0, 0),
        rotate: rs.fn(),
        setRotateCenterToSelected: rs.fn(),
        lookAt: rs.fn(),
        fitContent: rs.fn(),
    };
    cc.camera.position.set(0, 0, 100);

    const update = rs.fn();
    const view = { cameraController: cc, update } as unknown as ThreeView;
    const gizmo = new ViewGizmoCtor(view);
    return { gizmo, cc, update };
}

function canvasOf(gizmo: ViewGizmo): HTMLCanvasElement {
    return (gizmo as any)._canvas;
}

function pointerEvent(props: Record<string, unknown>): PointerEvent {
    return { stopPropagation: () => {}, ...props } as unknown as PointerEvent;
}

function lookAtCall(cc: MockController) {
    return cc.lookAt.mock.calls[0] as unknown as [XYZ, XYZ, XYZ, { duration: number }];
}

describe("ViewGizmo — construction and dom", () => {
    test("constructor creates a 200x200 canvas, a home button and absolute positioning", () => {
        const { gizmo, cc } = createGizmo();

        const canvas = canvasOf(gizmo);
        expect(gizmo.children.length).toBe(2);
        expect(gizmo.children[0]).toBe(canvas);
        expect((gizmo.children[1] as HTMLElement).dataset["viewcube"]).toBe("home");
        expect(canvas.width).toBe(200);
        expect(canvas.height).toBe(200);
        expect(gizmo.style.position).toBe("absolute");
        expect(gizmo.cameraController).toBe(cc as unknown as CameraController);
    });

    test("setDom moves the gizmo into the given element", () => {
        const { gizmo } = createGizmo();
        const dom = document.createElement("div");
        document.body.appendChild(dom);
        try {
            gizmo.setDom(dom);
            expect(gizmo.parentElement).toBe(dom);
        } finally {
            dom.remove();
        }
    });

    test("dispose removes the gizmo from its parent", () => {
        const { gizmo } = createGizmo();
        const dom = document.createElement("div");
        gizmo.setDom(dom);
        expect(dom.contains(gizmo)).toBe(true);

        gizmo.dispose();
        expect(dom.contains(gizmo)).toBe(false);
    });
});

describe("ViewGizmo — pointer interaction", () => {
    test("pointerout clears the mouse and redraws", () => {
        const { gizmo, update } = createGizmo();
        document.body.appendChild(gizmo);
        try {
            (gizmo as any)._mouse = new Vector3(1, 2, 0);
            canvasOf(gizmo).dispatchEvent(new PointerEvent("pointerout"));
            expect((gizmo as any)._mouse).toBeUndefined();
            expect(update).toHaveBeenCalledTimes(1);
        } finally {
            gizmo.remove();
        }
    });

    test("detached gizmo no longer reacts to canvas events", () => {
        const { gizmo, update } = createGizmo();
        document.body.appendChild(gizmo);
        gizmo.remove();

        canvasOf(gizmo).dispatchEvent(new PointerEvent("pointerout"));
        expect(update).not.toHaveBeenCalled();
    });

    test("left-button drag rotates the camera by 4x the movement", () => {
        const { gizmo, cc, update } = createGizmo();

        (gizmo as any)._onPointerMove(
            pointerEvent({ buttons: 1, movementX: 2, movementY: 3, clientX: 16, clientY: 16 }),
        );

        expect(cc.rotate).toHaveBeenCalledTimes(1);
        expect(cc.rotate.mock.calls[0]).toEqual([8, 12]);
        expect((gizmo as any)._canClick).toBe(false);
        expect(update).toHaveBeenCalledTimes(1);
        // The mouse is tracked in canvas pixels: the canvas is shown at 0.8 of its size
        expect((gizmo as any)._mouse.x).toBeCloseTo(20);
        expect((gizmo as any)._mouse.y).toBeCloseTo(20);
    });

    test("pointer move without left button only tracks the mouse", () => {
        const { gizmo, cc, update } = createGizmo();

        (gizmo as any)._onPointerMove(
            pointerEvent({ buttons: 0, movementX: 2, movementY: 3, clientX: 5, clientY: 5 }),
        );

        expect(cc.rotate).not.toHaveBeenCalled();
        expect((gizmo as any)._canClick).toBe(true);
        expect(update).toHaveBeenCalledTimes(1);
    });

    test("left-button move without movement keeps the gizmo clickable", () => {
        const { gizmo, cc } = createGizmo();

        (gizmo as any)._onPointerMove(
            pointerEvent({ buttons: 1, movementX: 0, movementY: 0, clientX: 5, clientY: 5 }),
        );

        expect(cc.rotate).not.toHaveBeenCalled();
        expect((gizmo as any)._canClick).toBe(true);
    });

    test("pointerdown captures the pointer and sets the rotate center", () => {
        const { gizmo, cc } = createGizmo();
        const canvas = canvasOf(gizmo);
        canvas.setPointerCapture = rs.fn();
        canvas.releasePointerCapture = rs.fn();

        (gizmo as any)._onPointerDown(pointerEvent({ pointerId: 7 }));
        expect(canvas.setPointerCapture).toHaveBeenCalledWith(7);
        expect(cc.setRotateCenterToSelected).toHaveBeenCalledTimes(1);

        (gizmo as any)._onPointerUp(pointerEvent({ pointerId: 7 }));
        expect(canvas.releasePointerCapture).toHaveBeenCalledWith(7);
    });
});

describe("ViewGizmo — rendering and picking", () => {
    test("from the top only the top face is visible: one face with its label, three axes", () => {
        const { gizmo } = createGizmo();

        gizmo.update();

        expect(fakeContext.calls.clearRect).toBe(1);
        // one face outline + three axis lines
        expect(fakeContext.calls.stroke).toBe(4);
        expect(fakeContext.calls.fill).toBe(1);
        // the face label (drawn in the face's plane) plus the X/Y/Z axis labels
        expect(fakeContext.calls.setTransform).toBe(1);
        expect(fakeContext.calls.fillText).toBe(4);
    });

    test("the cube centre picks the face facing the viewer", () => {
        const { gizmo } = createGizmo();
        gizmo.update();

        const target = gizmo.pick(new Vector3(100, 100, 0));
        expect(target?.kind).toBe("face");
        expect((target as Extract<CubeTarget, { kind: "face" }>).face.key).toBe("top");
    });

    test("a projected corner picks the corner over the face", () => {
        const { gizmo } = createGizmo();
        gizmo.update();

        const target = gizmo.pick(gizmo.project(new Vector3(1, 1, 1)));
        expect(target?.kind).toBe("corner");
    });

    test("far outside the cube nothing is picked", () => {
        const { gizmo } = createGizmo();
        (gizmo as any)._mouse = new Vector3(2, 2, 0);
        gizmo.update();
        expect(gizmo.hovered).toBeUndefined();
    });
});

describe("ViewGizmo — click to align camera", () => {
    test("click right after a drag only re-arms clicking", () => {
        const { gizmo, cc } = createGizmo();
        (gizmo as any)._mouse = new Vector3(100, 100, 0);
        gizmo.update();
        (gizmo as any)._canClick = false;

        (gizmo as any)._onClick(pointerEvent({}));

        expect((gizmo as any)._canClick).toBe(true);
        expect(cc.lookAt).not.toHaveBeenCalled();
    });

    test("click with nothing under the pointer does nothing", () => {
        const { gizmo, cc } = createGizmo();
        gizmo.update();

        (gizmo as any)._onClick(pointerEvent({}));

        expect(cc.lookAt).not.toHaveBeenCalled();
    });

    test("clicking a face flies the camera onto it with the face's up vector", () => {
        const { gizmo, cc, update } = createGizmo();
        (gizmo as any)._mouse = new Vector3(100, 100, 0);
        gizmo.update();

        (gizmo as any)._onClick(pointerEvent({}));

        expect(cc.lookAt).toHaveBeenCalledTimes(1);
        const [eye, , up, options] = lookAtCall(cc);
        expect([eye.x, eye.y, eye.z]).toEqual([0, 0, 100]);
        expect([up.x, up.y, up.z]).toEqual([0, 1, 0]);
        // clicking the cube flies the camera over rather than teleporting it
        expect(options.duration).toBe(CAMERA_FLY_DURATION);
        expect(update).toHaveBeenCalledTimes(1);
    });

    test("clicking a corner flies to the isometric view from that corner", () => {
        const { gizmo, cc } = createGizmo();
        gizmo.update();
        (gizmo as any)._mouse = gizmo.project(new Vector3(1, 1, 1));
        gizmo.update();

        (gizmo as any)._onClick(pointerEvent({}));

        const [eye, , up] = lookAtCall(cc);
        const d = 100 / Math.sqrt(3);
        expect(eye.x).toBeCloseTo(d);
        expect(eye.y).toBeCloseTo(d);
        expect(eye.z).toBeCloseTo(d);
        expect([up.x, up.y, up.z]).toEqual([0, 0, 1]);
    });

    test("home flies front-right-top and frames the content", () => {
        const { gizmo, cc } = createGizmo();
        (gizmo.children[1] as HTMLElement).click();

        const [eye] = lookAtCall(cc);
        const d = 100 / Math.sqrt(3);
        expect(eye.x).toBeCloseTo(d);
        expect(eye.y).toBeCloseTo(-d);
        expect(eye.z).toBeCloseTo(d);
        expect(cc.fitContent).toHaveBeenCalledTimes(1);
    });
});
