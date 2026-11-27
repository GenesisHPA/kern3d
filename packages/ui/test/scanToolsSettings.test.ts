// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type CommandData, type CommandKeys, CommandStore, Config } from "@chili3d/core";
import { afterEach, describe, expect, test } from "@rstest/core";
import { SCAN_TOOL_SETTINGS, ScanToolsSettings } from "../src/home/scanToolsSettings";
import { createDropdownItem } from "../src/ribbon/dropdownController";
import { RibbonPushButton } from "../src/ribbon/ribbonButton";

const KEY = "test.scanGate" as CommandKeys;

class Noop {
    async execute() {}
}

afterEach(() => {
    for (const { key } of SCAN_TOOL_SETTINGS) Config.instance[key] = true;
    CommandStore.unregisterCommand(KEY);
});

describe("scan tool settings", () => {
    test("every tool is on by default", () => {
        for (const { key } of SCAN_TOOL_SETTINGS) expect(Config.instance[key]).toBe(true);
    });

    test("one checkbox per tool, each switching its own Config flag", () => {
        const panel = ScanToolsSettings({ group: "g", title: "t", row: "r" });
        const boxes = [...panel.querySelectorAll("input[type=checkbox]")] as HTMLInputElement[];
        expect(boxes.map((b) => b.dataset["setting"])).toEqual(SCAN_TOOL_SETTINGS.map((s) => s.key));
        expect(boxes.every((b) => b.checked)).toBe(true);
        boxes[2].checked = false;
        boxes[2].onchange?.(new Event("change"));
        expect(Config.instance.scanFitRegion).toBe(false);
        expect(Config.instance.scanSectionSketch).toBe(true);
    });

    test("the flags are saved with the other settings", () => {
        Config.instance.scanDeviationMap = false;
        Config.instance.saveToStorage();
        Config.instance.scanDeviationMap = true;
        Config.instance.readFromStorage();
        expect(Config.instance.scanDeviationMap).toBe(false);
    });
});

describe("a ribbon button of a gated command", () => {
    function register() {
        CommandStore.registerCommand(Noop, {
            key: KEY,
            icon: "icon-section",
            isEnabled: () => Config.instance.scanPrepare,
        } as CommandData);
    }

    test("hides while its setting is off and comes back when it is on", () => {
        register();
        Config.instance.scanPrepare = false;
        const button = RibbonPushButton.fromCommandName(KEY, "large")!;
        expect(button.style.display).toBe("none");
        Config.instance.scanPrepare = true;
        expect(button.style.display).toBe("");
        button.dispose();
        // disposed: no longer follows the setting
        Config.instance.scanPrepare = false;
        expect(button.style.display).toBe("");
    });

    test("is left out of a dropdown while off", () => {
        register();
        const classes = { item: "i", icon: "c", text: "t" };
        Config.instance.scanPrepare = false;
        expect(createDropdownItem(KEY, () => {}, classes).style.display).toBe("none");
        Config.instance.scanPrepare = true;
        expect(createDropdownItem(KEY, () => {}, classes).style.display).toBe("");
    });
});
