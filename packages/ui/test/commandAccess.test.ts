// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandData,
    type CommandKeys,
    CommandStore,
    Config,
    type IApplication,
    type IView,
    PubSub,
} from "@chili3d/core";
import { createMockView } from "@chili3d/core/test-utils";
import { afterEach, describe, expect, test } from "@rstest/core";
import {
    CommandToolbox,
    commandTag,
    searchCommands,
    type ToolboxEntry,
} from "../src/commandAccess/commandToolbox";
import { MarkingMenu, wedgeAt } from "../src/commandAccess/markingMenu";
import { NavigationBar } from "../src/viewport/navigationBar";

const entry = (key: string, name: string): ToolboxEntry => ({
    data: { key: key as CommandKeys, icon: "icon-box" } as CommandData,
    name,
});

afterEach(() => {
    document.body.replaceChildren();
});

describe("searchCommands", () => {
    const entries = [
        entry("feature.fillet", "Скругление"),
        entry("sketch.fillet", "Скругление эскиза"),
        entry("feature.chamfer", "Фаска"),
        entry("feature.extrude", "Выдавливание"),
        entry("modify.moveCopy", "Переместить/Копировать"),
    ];

    test("an empty query lists everything by name", () => {
        expect(searchCommands(entries, " ").map((e) => e.name)).toEqual([
            "Выдавливание",
            "Переместить/Копировать",
            "Скругление",
            "Скругление эскиза",
            "Фаска",
        ]);
    });

    test("a name starting with the query ranks before a word inside a name", () => {
        expect(searchCommands(entries, "коп").map((e) => e.data.key)).toEqual(["modify.moveCopy"]);
        expect(searchCommands(entries, "СКР").map((e) => e.data.key)).toEqual([
            "feature.fillet",
            "sketch.fillet",
        ]);
    });

    test("the command key matches too", () => {
        expect(searchCommands(entries, "chamfer").map((e) => e.data.key)).toEqual(["feature.chamfer"]);
    });

    test("a tag tells same-named commands apart by where they live", () => {
        expect(commandTag("sketch.fillet")).toBe("ribbon.tab.sketch");
        expect(commandTag("feature.fillet")).toBe("ribbon.tab.parametric");
        expect(commandTag("modify.fillet")).toBe("ribbon.tab.basic");
        expect(commandTag("doc.save")).toBeUndefined();
    });
});

describe("CommandToolbox", () => {
    // one class per key: a command's data lives on its class's prototype
    class Alpha {
        async execute() {}
    }
    class Beta {
        async execute() {}
    }
    const KEYS = ["test.toolbox.alpha", "test.toolbox.beta"] as unknown as CommandKeys[];

    test("S opens it, typing filters, Enter runs the first match", () => {
        CommandStore.registerCommand(Alpha, { key: KEYS[0], icon: "icon-box" });
        CommandStore.registerCommand(Beta, { key: KEYS[1], icon: "icon-box" });
        const published: CommandKeys[] = [];
        const record = (command: CommandKeys) => published.push(command);
        PubSub.default.sub("executeCommand", record);
        const toolbox = new CommandToolbox();
        try {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" }));
            expect(toolbox.isOpen).toBe(true);
            const box = document.body.querySelector("input") as HTMLInputElement;
            box.value = "toolbox.beta";
            box.dispatchEvent(new Event("input"));
            const rows = Array.from(document.body.querySelectorAll<HTMLElement>("[data-command]"));
            expect(rows.map((r) => r.dataset["command"])).toEqual(["test.toolbox.beta"]);

            box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
            expect(published).toEqual(["test.toolbox.beta"]);
            expect(toolbox.isOpen).toBe(false);
        } finally {
            toolbox.dispose();
            PubSub.default.remove("executeCommand", record);
            for (const key of KEYS) CommandStore.unregisterCommand(key);
        }
    });

    test("S typed into a text box stays a letter", () => {
        const toolbox = new CommandToolbox();
        const field = document.createElement("input");
        document.body.append(field);
        try {
            field.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
            expect(toolbox.isOpen).toBe(false);
        } finally {
            toolbox.dispose();
        }
    });

    test("Escape closes it", () => {
        const toolbox = new CommandToolbox();
        try {
            toolbox.open(10, 10);
            const box = document.body.querySelector("input") as HTMLInputElement;
            box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
            expect(toolbox.isOpen).toBe(false);
        } finally {
            toolbox.dispose();
        }
    });
});

describe("marking menu", () => {
    test.each([
        [0, -50, 0],
        [50, -50, 1],
        [50, 0, 2],
        [0, 50, 4],
        [-50, 0, 6],
        [-50, -50, 7],
    ])("the pointer offset (%s, %s) points at wedge %s", (dx, dy, wedge) => {
        expect(wedgeAt(dx, dy)).toBe(wedge);
    });

    test("the centre points at no wedge", () => {
        expect(wedgeAt(5, -5)).toBeUndefined();
    });

    function makeMenu(executing = false) {
        const host = document.createElement("div");
        document.body.append(host);
        const view = createMockView();
        (view as { dom?: HTMLElement }).dom = host;
        view.detectVisual = () => [];
        const app = {
            activeView: view,
            executingCommand: executing ? {} : undefined,
            lastCommand: undefined,
        } as unknown as IApplication;
        return { host, menu: new MarkingMenu(app, host, () => false) };
    }

    const rightClick = (host: HTMLElement, dx = 0) => {
        host.dispatchEvent(new PointerEvent("pointerdown", { button: 2, clientX: 100, clientY: 100 }));
        host.dispatchEvent(new PointerEvent("pointerup", { button: 2, clientX: 100 + dx, clientY: 100 }));
    };

    test("a right click opens it with the repeat wedge; Escape closes it", () => {
        const { host, menu } = makeMenu();
        rightClick(host);
        expect(menu.isOpen).toBe(true);
        expect(document.body.querySelector('[data-command="special.last"]')).not.toBeNull();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(menu.isOpen).toBe(false);
        menu.dispose();
    });

    test("a right drag is a camera gesture, not a menu", () => {
        const { host, menu } = makeMenu();
        rightClick(host, 30);
        expect(menu.isOpen).toBe(false);
        menu.dispose();
    });

    test("a running command keeps the right button", () => {
        const { host, menu } = makeMenu(true);
        rightClick(host);
        expect(menu.isOpen).toBe(false);
        menu.dispose();
    });

    test("clicking a wedge runs its command", () => {
        const { host, menu } = makeMenu();
        const published: CommandKeys[] = [];
        const record = (command: CommandKeys) => published.push(command);
        PubSub.default.sub("executeCommand", record);
        try {
            rightClick(host);
            (document.body.querySelector('[data-command="special.last"]') as HTMLElement).click();
            expect(published).toEqual(["special.last"]);
            expect(menu.isOpen).toBe(false);
        } finally {
            PubSub.default.remove("executeCommand", record);
            menu.dispose();
        }
    });
});

describe("NavigationBar", () => {
    function makeBar(overrides: Partial<IView> = {}) {
        const host = document.createElement("div");
        document.body.append(host);
        const camera = {
            cameraType: "perspective",
            rotate: rs.fn((_dx: number, _dy: number) => {}),
            pan: rs.fn((_dx: number, _dy: number) => {}),
            zoom: rs.fn((_x: number, _y: number, _delta: number) => {}),
            fitContent: rs.fn(),
            onPropertyChanged: () => {},
            removePropertyChanged: () => {},
        };
        const view = createMockView({ ...overrides, cameraController: camera as never });
        (view as { dom?: HTMLElement }).dom = host;
        const bar = new NavigationBar(view);
        host.append(bar);
        return { bar, view, camera, host };
    }

    test("a drag mode turns a left drag on the canvas into camera moves", () => {
        const { bar, camera, host } = makeBar();
        bar.setMode("orbit");
        host.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 10, clientY: 10 }));
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: 13, clientY: 15 }));
        window.dispatchEvent(new PointerEvent("pointerup", { clientX: 13, clientY: 15 }));
        expect(camera.rotate.mock.calls).toEqual([[12, 20]]);

        bar.setMode("pan");
        bar.applyDrag(2, 3);
        expect(camera.pan.mock.calls).toEqual([[2, 3]]);
    });

    test("Escape leaves the drag mode, and the canvas is the view's again", () => {
        const { bar, camera, host } = makeBar();
        bar.setMode("orbit");
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(bar.activeMode).toBeUndefined();
        host.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 10, clientY: 10 }));
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: 20, clientY: 20 }));
        expect(camera.rotate).not.toHaveBeenCalled();
    });

    test("the orbit arrow picks turntable or free orbit", () => {
        const previous = Config.instance.orbitMode;
        try {
            const { bar } = makeBar();
            Config.instance.orbitMode = "turntable";
            (bar.querySelector('[data-nav="orbitMode"]') as HTMLElement).click();
            const rows = Array.from(bar.querySelectorAll<HTMLElement>("[data-orbit-mode]"));
            expect(rows.map((row) => row.dataset["orbitMode"])).toEqual(["turntable", "trackball"]);
            rows[1].click();
            expect(Config.instance.orbitMode).toBe("trackball");
        } finally {
            Config.instance.orbitMode = previous;
        }
    });

    test("the grid button toggles the view's grid", () => {
        const { bar, view } = makeBar({ showGrid: true });
        (bar.querySelector('[data-nav="grid"]') as HTMLElement).click();
        expect(view.showGrid).toBe(false);
    });

    test("the section button ends a running section, or starts the command", () => {
        const published: CommandKeys[] = [];
        const record = (command: CommandKeys) => published.push(command);
        PubSub.default.sub("executeCommand", record);
        try {
            const { bar } = makeBar();
            (bar.querySelector('[data-nav="section"]') as HTMLElement).click();
            expect(published).toEqual(["inspect.section"]);
        } finally {
            PubSub.default.remove("executeCommand", record);
        }
    });

    test("a view without a grid shows no grid button", () => {
        const { bar } = makeBar();
        expect((bar.querySelector('[data-nav="grid"]') as HTMLElement).style.display).toBe("none");
    });
});
