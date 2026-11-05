// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { type WorkspaceTab, WorkspaceTabRegistry } from "../src/ui/workspaceTabs";

function fakeTab(id: string, log: string[]): WorkspaceTab {
    return {
        id,
        title: () => id,
        show: () => log.push(`show ${id}`),
        hide: () => log.push(`hide ${id}`),
        close: () => log.push(`close ${id}`),
    };
}

describe("WorkspaceTabRegistry", () => {
    test("opening brings the tab to the front and hides the others", () => {
        const log: string[] = [];
        const tabs = new WorkspaceTabRegistry();
        tabs.open(fakeTab("a", log));
        tabs.open(fakeTab("b", log));
        expect(tabs.active).toBe("b");
        expect(tabs.list.map((x) => x.id)).toEqual(["a", "b"]);
        expect(log).toEqual(["show a", "hide a", "show b"]);
    });

    test("activating nothing shows the model: every tab steps back", () => {
        const log: string[] = [];
        const tabs = new WorkspaceTabRegistry();
        tabs.open(fakeTab("a", log));
        log.length = 0;
        tabs.activate(undefined);
        expect(tabs.active).toBeUndefined();
        expect(log).toEqual(["hide a"]);
    });

    test("opening an open tab again does not duplicate it; removing the front one shows the model", () => {
        const log: string[] = [];
        const tabs = new WorkspaceTabRegistry();
        const a = fakeTab("a", log);
        tabs.open(a);
        tabs.open(a);
        expect(tabs.list.length).toBe(1);
        let changes = 0;
        const off = tabs.onChange(() => changes++);
        tabs.remove("a");
        expect(tabs.active).toBeUndefined();
        expect(tabs.list).toEqual([]);
        expect(changes).toBe(1);
        off();
    });
});
