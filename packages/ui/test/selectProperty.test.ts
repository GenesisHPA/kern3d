// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Combobox, type I18nKeys, type Property } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { describe, expect, test } from "@rstest/core";
import { basicPropertyControl } from "../src/property/basicPropertyControl";
import { SelectProperty } from "../src/property/selectProperty";

const ITEMS = ["common.ok", "common.cancel"] as I18nKeys[];

describe("SelectProperty", () => {
    const property: Property = { name: "kind", display: "common.type", combobox: Combobox.from(ITEMS) };

    test("a property with a combobox gets a dropdown on the current value", () => {
        const doc = new TestDocument();
        const control = basicPropertyControl(doc, [{ kind: "common.cancel" }], property);
        expect(control).toBeInstanceOf(SelectProperty);
        const select = (control as SelectProperty).querySelector("select")!;
        expect(select).not.toBeNull();
        expect(select.options).toHaveLength(2);
        expect(select.selectedIndex).toBe(1);
    });

    test("picking an item writes it to every object, as one undo step", () => {
        const doc = new TestDocument();
        const objects = [{ kind: "common.ok" }, { kind: "common.ok" }];
        const control = new SelectProperty(doc, objects, property);
        const select = control.querySelector("select")!;
        select.selectedIndex = 1;
        select.dispatchEvent(new Event("change"));
        expect(objects.map((o) => o.kind)).toEqual(["common.cancel", "common.cancel"]);
    });
});
