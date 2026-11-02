// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandKeys,
    CommandStore,
    type IApplication,
    ObservableCollection,
    PubSub,
    Ribbon,
    RibbonGroup,
    RibbonTab,
} from "@chili3d/core";
import { afterEach, beforeEach, describe, expect, test } from "@rstest/core";
import { groupEntries, primaryEntries } from "../src/toolbar/commandItems";
import { MainToolbar } from "../src/toolbar/toolbar";
import { ToolbarGroup } from "../src/toolbar/toolbarGroup";

const A = "test.toolbar.a" as CommandKeys;
const B = "test.toolbar.b" as CommandKeys;
const C = "test.toolbar.c" as CommandKeys;
const D = "test.toolbar.d" as CommandKeys;
const E = "test.toolbar.e" as CommandKeys;

class TestCommand {
    async execute() {}
}

beforeEach(() => {
    // a class per key: a command's data lives on its class's prototype
    for (const key of [A, B, C, D, E])
        CommandStore.registerCommand(class extends TestCommand {}, { key, icon: "icon-box" });
});

afterEach(() => {
    for (const key of [A, B, C, D, E]) CommandStore.unregisterCommand(key);
    document.body.replaceChildren();
});

/** A, split(B, C), stack(D), collapsed E. */
function makeGroup() {
    return RibbonGroup.fromProfile({
        groupName: "ribbon.group.create",
        items: [A, { type: "split", items: [B, C] }, [D, A]],
        collapsedItems: [E],
    });
}

describe("toolbar command items", () => {
    test("a group's dropdown lists every command once, stacks and splits opened up", () => {
        expect(groupEntries(makeGroup())).toEqual([A, B, C, D, E]);
    });

    test("the icons are the top-level buttons, a split by its first command", () => {
        expect(primaryEntries(makeGroup(), 4)).toEqual([A, B]);
        expect(primaryEntries(makeGroup(), 1)).toEqual([A]);
    });

    test("a command that is not registered gets no icon", () => {
        const group = RibbonGroup.fromProfile({
            groupName: "ribbon.group.create",
            items: ["test.toolbar.missing" as CommandKeys, A],
        });
        expect(primaryEntries(group, 4)).toEqual([A]);
    });

    test("a runtime collection item is a stack: dropdown only", () => {
        const group = new RibbonGroup("ribbon.group.create", [A, new ObservableCollection(B, C)]);
        expect(primaryEntries(group, 4)).toEqual([A]);
        expect(groupEntries(group)).toEqual([A, B, C]);
    });
});

describe("ToolbarGroup", () => {
    test("shows the primary icons and opens a dropdown with every command", () => {
        const group = new ToolbarGroup(makeGroup());
        document.body.append(group);
        expect(group.querySelectorAll("ribbon-button").length).toBe(2);

        group.toggleMenu();
        expect(group.isMenuOpen).toBe(true);
        const rows = Array.from(document.body.querySelectorAll<HTMLElement>("[data-command]"));
        expect(rows.map((row) => row.dataset["command"])).toEqual([A, B, C, D, E]);
    });

    test("a dropdown row runs its command and closes the menu", () => {
        const published: CommandKeys[] = [];
        const record = (command: CommandKeys) => published.push(command);
        PubSub.default.sub("executeCommand", record);
        try {
            const group = new ToolbarGroup(makeGroup());
            document.body.append(group);
            group.toggleMenu();
            (document.body.querySelector(`[data-command="${D}"]`) as HTMLElement).click();
            expect(published).toEqual([D]);
            expect(group.isMenuOpen).toBe(false);
        } finally {
            PubSub.default.remove("executeCommand", record);
        }
    });

    test("a prominent group is one button that runs its command", () => {
        const published: CommandKeys[] = [];
        const record = (command: CommandKeys) => published.push(command);
        PubSub.default.sub("executeCommand", record);
        try {
            const profile = { groupName: "ribbon.group.finishSketch" as const, items: [A], prominent: true };
            const group = new ToolbarGroup(RibbonGroup.fromProfile(profile));
            document.body.append(group);
            const button = group.querySelector<HTMLElement>(`[data-command="${A}"]`);
            expect(button).not.toBeNull();
            button!.click();
            expect(published).toEqual([A]);
        } finally {
            PubSub.default.remove("executeCommand", record);
        }
    });

    test("a command added to the group at runtime shows up", () => {
        const model = new RibbonGroup("ribbon.group.create", [A]);
        const group = new ToolbarGroup(model);
        document.body.append(group);
        model.items.push(B);
        expect(group.querySelectorAll("ribbon-button").length).toBe(2);
    });
});

describe("MainToolbar", () => {
    function makeRibbon() {
        const solid = RibbonTab.fromProfile({
            tabName: "ribbon.tab.parametric",
            groups: [{ groupName: "ribbon.group.create", items: [A] }],
        });
        const direct = RibbonTab.fromProfile({
            tabName: "ribbon.tab.basic",
            groups: [{ groupName: "ribbon.group.modify", items: [B] }],
        });
        const sketch = RibbonTab.fromProfile({
            tabName: "ribbon.tab.sketch",
            contextual: true,
            groups: [{ groupName: "ribbon.group.create", items: [C] }],
        });
        const drawing = RibbonTab.fromProfile({
            tabName: "ribbon.tab.drawing",
            workspace: "ribbon.workspace.drawing",
            groups: [{ groupName: "ribbon.group.drawing", items: [D] }],
        });
        return new Ribbon([], [solid, direct, sketch, drawing]);
    }

    function makeToolbar() {
        const ribbon = makeRibbon();
        const app = { views: new ObservableCollection(), activeView: undefined } as unknown as IApplication;
        const toolbar = new MainToolbar(app, ribbon);
        document.body.append(toolbar);
        return { toolbar, ribbon };
    }

    const panelOf = (toolbar: HTMLElement, tab: string) =>
        toolbar.querySelector<HTMLElement>(`[data-tab="${tab}"]:has(chili-toolbar-group)`);

    test("lists the workspaces in tab order", () => {
        const { toolbar } = makeToolbar();
        expect(toolbar.workspaces()).toEqual(["ribbon.workspace.design", "ribbon.workspace.drawing"]);
        expect(toolbar.workspace).toBe("ribbon.workspace.design");
    });

    test("shows only the visible tabs of the current workspace", () => {
        const { toolbar } = makeToolbar();
        const strip = toolbar.querySelector("[data-tab]")?.parentElement as HTMLElement;
        const names = Array.from(strip.children).map((x) => (x as HTMLElement).dataset["tab"]);
        expect(names).toEqual(["ribbon.tab.parametric", "ribbon.tab.basic"]);
    });

    test("switching the workspace activates its first tab and shows its groups", () => {
        const { toolbar, ribbon } = makeToolbar();
        toolbar.switchWorkspace("ribbon.workspace.drawing");
        expect(ribbon.activeTab.tabName).toBe("ribbon.tab.drawing");
        expect(toolbar.workspace).toBe("ribbon.workspace.drawing");
        const drawing = panelOf(toolbar, "ribbon.tab.drawing");
        expect(drawing).not.toBeNull();
        expect(drawing!.style.display).toBe("");
        expect(drawing!.querySelectorAll("chili-toolbar-group").length).toBe(1);
        expect(panelOf(toolbar, "ribbon.tab.parametric")!.style.display).toBe("none");
    });

    test("a contextual tab opened by the sketch shows up and keeps the design workspace", () => {
        const { toolbar, ribbon } = makeToolbar();
        ribbon.openTab("ribbon.tab.sketch");
        const strip = toolbar.querySelector("[data-tab]")?.parentElement as HTMLElement;
        const names = Array.from(strip.children).map((x) => (x as HTMLElement).dataset["tab"]);
        expect(names).toEqual(["ribbon.tab.parametric", "ribbon.tab.basic", "ribbon.tab.sketch"]);
        expect(toolbar.workspace).toBe("ribbon.workspace.design");

        ribbon.closeTab("ribbon.tab.sketch");
        const after = Array.from(strip.children).map((x) => (x as HTMLElement).dataset["tab"]);
        expect(after).toEqual(["ribbon.tab.parametric", "ribbon.tab.basic"]);
        expect(ribbon.activeTab.tabName).toBe("ribbon.tab.parametric");
    });

    test("a tab's group panel is built once and reused", () => {
        const { toolbar, ribbon } = makeToolbar();
        const first = toolbar.querySelector("chili-toolbar-group");
        ribbon.setActiveTab("ribbon.tab.basic");
        ribbon.setActiveTab("ribbon.tab.parametric");
        expect(toolbar.querySelector("chili-toolbar-group")).toBe(first);
    });
});
