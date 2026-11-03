// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ObservableCollection } from "@chili3d/core";
import { SketchRibbonProfiles } from "@chili3d/parametric";
import {
    DefaultRibbon,
    DrawingRibbonProfiles,
    mergeRibbonProfiles,
    ParametricRibbonProfiles,
    type RibbonProfileExtra,
} from "../src/ribbon";

describe("DefaultRibbon", () => {
    test("should be a non-empty array of tab profiles", () => {
        expect(Array.isArray(DefaultRibbon)).toBe(true);
        expect(DefaultRibbon.length).toBeGreaterThan(0);
    });

    test("each tab should have a tabName and groups", () => {
        for (const tab of DefaultRibbon) {
            expect(tab.tabName).toBeDefined();
            expect(typeof tab.tabName).toBe("string");
            expect(Array.isArray(tab.groups)).toBe(true);
        }
    });

    test("each group should have a groupName and items array", () => {
        for (const tab of DefaultRibbon) {
            for (const group of tab.groups) {
                expect(group.groupName).toBeDefined();
                expect(typeof group.groupName).toBe("string");
                expect(Array.isArray(group.items)).toBe(true);
            }
        }
    });

    test("first tab should be model tab", () => {
        expect(DefaultRibbon[0].tabName).toBe("ribbon.tab.basic");
    });

    test("second tab should be manager tab", () => {
        expect(DefaultRibbon[1].tabName).toBe("ribbon.tab.manager");
    });

    test("should not contain any sketch commands without useParametric", () => {
        const allItems = flattenItems(DefaultRibbon.flatMap((t) => t.groups.flatMap((g) => g.items)));
        expect(allItems.some((x) => x.startsWith("sketch."))).toBe(false);
        expect(DefaultRibbon.some((t) => t.tabName === "ribbon.tab.sketch")).toBe(false);
    });

    test("model tab should contain draw, modify, converter, boolean groups", () => {
        const modelTab = DefaultRibbon[0];
        const groupNames = modelTab.groups.map((g) => g.groupName);
        expect(groupNames).toContain("ribbon.group.draw");
        expect(groupNames).toContain("ribbon.group.modify");
        expect(groupNames).toContain("ribbon.group.converter");
        expect(groupNames).toContain("ribbon.group.boolean");
        expect(groupNames).toContain("ribbon.group.workingPlane");
        expect(groupNames).toContain("ribbon.group.tools");
        expect(groupNames).toContain("ribbon.group.measure");
        expect(groupNames).toContain("ribbon.group.act");
        expect(groupNames).toContain("ribbon.group.importExport");
    });

    test("draw group should contain create commands", () => {
        const drawGroup = DefaultRibbon[0].groups.find((g) => g.groupName === "ribbon.group.draw");
        expect(drawGroup).toBeDefined();
        const allItems = flattenItems(drawGroup!.items);
        expect(allItems).toContain("create.extrude");
        expect(allItems).toContain("create.box");
    });

    test("modify group should contain modify commands", () => {
        const modifyGroup = DefaultRibbon[0].groups.find((g) => g.groupName === "ribbon.group.modify");
        expect(modifyGroup).toBeDefined();
        const allItems = flattenItems(modifyGroup!.items);
        expect(allItems).toContain("modify.move");
        expect(allItems).toContain("modify.rotate");
        expect(allItems).toContain("modify.fillet");
    });

    test("boolean group should contain boolean commands", () => {
        const booleanGroup = DefaultRibbon[0].groups.find((g) => g.groupName === "ribbon.group.boolean");
        expect(booleanGroup).toBeDefined();
        const allItems = flattenItems(booleanGroup!.items);
        expect(allItems).toContain("boolean.common");
        expect(allItems).toContain("boolean.cut");
        expect(allItems).toContain("boolean.join");
    });

    test("split-type items should have type and items properties", () => {
        const drawGroup = DefaultRibbon[0].groups.find((g) => g.groupName === "ribbon.group.draw");
        const splitItems = drawGroup!.items.filter(
            (item) => typeof item === "object" && "type" in item && item.type === "split",
        );
        expect(splitItems.length).toBeGreaterThan(0);
        // The filter above guarantees every entry is a split item.
        for (const split of splitItems as { type: string; items: unknown[] }[]) {
            expect(split.type).toBe("split");
            expect(Array.isArray(split.items)).toBe(true);
        }
    });

    test("groups should support collapsedItems", () => {
        const drawGroup = DefaultRibbon[0].groups.find((g) => g.groupName === "ribbon.group.draw");
        expect(drawGroup!.collapsedItems).toBeDefined();
        expect(Array.isArray(drawGroup!.collapsedItems)).toBe(true);
    });

    test("all tab names should start with ribbon.tab.", () => {
        for (const tab of DefaultRibbon) {
            expect(tab.tabName.startsWith("ribbon.tab.")).toBe(true);
        }
    });

    test("all group names should start with ribbon.group.", () => {
        for (const tab of DefaultRibbon) {
            for (const group of tab.groups) {
                expect(group.groupName.startsWith("ribbon.group.")).toBe(true);
            }
        }
    });
});

describe("SketchRibbonProfiles", () => {
    test("parametric tab should lead its create group with the sketch entry commands", () => {
        const tab = SketchRibbonProfiles.find((t) => t.tabName === "ribbon.tab.parametric");
        expect(tab).toBeDefined();
        expect(tab!.contextual).toBeUndefined();
        expect(tab!.groups.map((g) => g.groupName)).toEqual(["ribbon.group.create"]);
        const allItems = flattenItems(tab!.groups.flatMap((g) => g.items));
        expect(allItems).toEqual(["sketch.create", "sketch.enter"]);
    });

    test("sketch tab should be contextual: create, modify, constraints, inspect, then finish", () => {
        const sketchTab = SketchRibbonProfiles.find((t) => t.tabName === "ribbon.tab.sketch");
        expect(sketchTab).toBeDefined();
        expect(sketchTab!.contextual).toBe(true);
        expect(sketchTab!.groups.map((g) => g.groupName)).toEqual([
            "ribbon.group.create",
            "ribbon.group.modify",
            "ribbon.group.constraint",
            "ribbon.group.inspect",
            "ribbon.group.finishSketch",
        ]);
        const finish = sketchTab!.groups.at(-1)!;
        expect(finish.prominent).toBe(true);
        expect(finish.items).toEqual(["sketch.exit"]);
        const allItems = flattenItems(sketchTab!.groups.flatMap((g) => g.items));
        expect(allItems).toContain("sketch.array");
        expect(allItems).toContain("sketch.bezier");
        expect(allItems).toContain("sketch.line");
        expect(allItems).toContain("sketch.nurbs");
        // the free curves' one tool until garlic's families were split into bezier and nurbs
        expect(allItems).not.toContain("sketch.spline");
        expect(allItems).toContain("sketch.mirror");
        expect(allItems).toContain("sketch.offset");
        expect(allItems).toContain("sketch.polygon");
        expect(allItems).toContain("constraint.coincident");
        expect(allItems).toContain("dimension.distance");
        expect(allItems).not.toContain("sketch.create");
    });

    test("the sketch tab's single top-level commands are the most used tools", () => {
        // The toolbar shows a group's top-level commands as its icons, the rest in its dropdown.
        const sketchTab = SketchRibbonProfiles.find((t) => t.tabName === "ribbon.tab.sketch")!;
        const create = sketchTab.groups.find((g) => g.groupName === "ribbon.group.create")!;
        const topLevel = create.items.filter((item) => !Array.isArray(item));
        expect(flattenItems(topLevel).filter((_, i, all) => all.indexOf(_) === i)).toEqual([
            "sketch.line",
            "sketch.rectangle",
            "sketch.polygon",
            "sketch.circle",
            "sketch.ellipse",
            "sketch.arc",
            "sketch.ellipseArc",
        ]);
    });
});

describe("ParametricRibbonProfiles", () => {
    test("should open the design workspace: the parametric tab goes before the direct-modeling tab", () => {
        const tab = ParametricRibbonProfiles.find((t) => t.tabName === "ribbon.tab.parametric");
        expect(tab).toBeDefined();
        expect(tab!.before).toBe("ribbon.tab.basic");
        expect(tab!.workspace).toBeUndefined();
    });

    test("groups follow the order a part is built in", () => {
        const tab = ParametricRibbonProfiles.find((t) => t.tabName === "ribbon.tab.parametric")!;
        expect(tab.groups.map((g) => g.groupName)).toEqual([
            "ribbon.group.create",
            "ribbon.group.modify",
            "ribbon.group.assemble",
            "ribbon.group.construct",
            "ribbon.group.inspect",
            "ribbon.group.insert",
        ]);
    });

    test("should split building a shape from modifying one into two groups", () => {
        // What builds geometry out of a profile, then what rewrites geometry already there — the
        // reason a draft (which rewrites the body it is applied to) does not sit next to an extrude.
        const tab = ParametricRibbonProfiles.find((t) => t.tabName === "ribbon.tab.parametric");
        const itemsOf = (groupName: string) =>
            flattenItems(tab!.groups.find((g) => g.groupName === groupName)!.items);

        expect(itemsOf("ribbon.group.create")).toEqual([
            "feature.extrude",
            "feature.revolve",
            "feature.sweep",
            "feature.loft",
            "feature.hole",
            "feature.rib",
            "feature.thread",
            "feature.helix",
            "feature.patternLinear",
            "feature.patternCircular",
            "feature.patternCurve",
            "feature.mirror",
            "feature.thicken",
            "feature.primitiveBox",
            "feature.primitiveCylinder",
            "feature.primitiveSphere",
            "feature.primitiveCone",
        ]);
        expect(itemsOf("ribbon.group.modify")).toEqual([
            "feature.pressPull",
            "feature.fillet",
            "feature.modifyFillet",
            "feature.chamfer",
            "feature.modifyChamfer",
            "feature.shell",
            "feature.draft",
            "feature.split",
            "feature.offsetFace",
            "feature.removeFeature",
            "feature.fuse",
            "feature.cut",
            "feature.common",
            "modify.deleteNode",
            "modify.paintBucket",
            "feature.variable",
        ]);
    });

    test("should keep the node placement operations in the assemble group", () => {
        const tab = ParametricRibbonProfiles.find((t) => t.tabName === "ribbon.tab.parametric");
        const group = tab!.groups.find((g) => g.groupName === "ribbon.group.assemble");
        expect(group).toBeDefined();
        expect(flattenItems(group!.items)).toEqual([
            "modify.moveCopy",
            "modify.align",
            "modify.move",
            "modify.rotate",
            "modify.mirror",
            "modify.array",
            "modify.detach",
        ]);
    });

    test("should merge into the sketch module's parametric tab without duplicating it", () => {
        const merged = mergeRibbonProfiles(DefaultRibbon, [
            ...ParametricRibbonProfiles,
            ...SketchRibbonProfiles,
        ]);
        const parametricTabs = merged.filter((t) => t.tabName === "ribbon.tab.parametric");

        expect(parametricTabs.length).toBe(1);
        const create = parametricTabs[0].groups.find((g) => g.groupName === "ribbon.group.create")!;
        // the sketch module's contribution is prepended: a part starts with a sketch
        expect(flattenItems(create.items).slice(0, 4)).toEqual([
            "sketch.create",
            "sketch.enter",
            "feature.extrude",
            "feature.revolve",
        ]);
        const allItems = flattenItems(parametricTabs[0].groups.flatMap((g) => g.items));
        for (const key of [
            "feature.plane",
            "feature.variable",
            "inspect.section",
            "inspect.interference",
            "inspect.massProperties",
            "annotate.text",
            "file.import",
            "file.export",
            "ai.toggleChat",
        ]) {
            expect(allItems).toContain(key);
        }
        expect(new Set(allItems).size).toBe(allItems.length);
    });
});

describe("DrawingRibbonProfiles", () => {
    test("the drawing tab lives in its own workspace", () => {
        const tab = DrawingRibbonProfiles.find((t) => t.tabName === "ribbon.tab.drawing");
        expect(tab?.workspace).toBe("ribbon.workspace.drawing");
    });
});

describe("mergeRibbonProfiles", () => {
    test("should insert the parametric tab before the model tab and append the sketch tab", () => {
        const merged = mergeRibbonProfiles(DefaultRibbon, SketchRibbonProfiles);
        const tabNames = merged.map((t) => t.tabName);

        expect(tabNames).toEqual([
            "ribbon.tab.parametric",
            "ribbon.tab.basic",
            "ribbon.tab.manager",
            "ribbon.tab.sketch",
        ]);
    });

    test("should not add sketch commands to the model tab", () => {
        const merged = mergeRibbonProfiles(DefaultRibbon, SketchRibbonProfiles);
        const drawGroup = merged
            .find((t) => t.tabName === "ribbon.tab.basic")!
            .groups.find((g) => g.groupName === "ribbon.group.draw")!;

        expect(flattenItems(drawGroup.items).some((x) => x.startsWith("sketch."))).toBe(false);
    });

    test("should not mutate the base profiles", () => {
        mergeRibbonProfiles(DefaultRibbon, SketchRibbonProfiles);

        const allItems = flattenItems(DefaultRibbon.flatMap((t) => t.groups.flatMap((g) => g.items)));
        expect(allItems.some((x) => x.startsWith("sketch."))).toBe(false);
        expect(DefaultRibbon.some((t) => t.tabName === "ribbon.tab.sketch")).toBe(false);
    });

    test("merging the same extras twice leaves them unchanged and repeats the result", () => {
        const extras = [...SketchRibbonProfiles, ...ParametricRibbonProfiles];
        const before = JSON.stringify(extras);

        const first = mergeRibbonProfiles(DefaultRibbon, extras);
        const second = mergeRibbonProfiles(DefaultRibbon, extras);

        expect(JSON.stringify(extras)).toBe(before);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    test("an extra group merged into an existing group is not grown by the merge", () => {
        const extras: RibbonProfileExtra[] = [
            {
                tabName: "ribbon.tab.basic",
                groups: [
                    {
                        groupName: "ribbon.group.draw",
                        items: ["create.point", { type: "split", items: ["create.line", "create.rect"] }],
                    },
                ],
            },
        ];

        const first = mergeRibbonProfiles(DefaultRibbon, extras);
        mergeRibbonProfiles(DefaultRibbon, extras);
        mergeRibbonProfiles(DefaultRibbon, extras);

        expect(flattenItems(extras[0].groups[0].items)).toEqual([
            "create.point",
            "create.line",
            "create.rect",
        ]);
        const second = mergeRibbonProfiles(DefaultRibbon, extras);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    test("the merged result shares no array or object with base or extras", () => {
        const extras = [...SketchRibbonProfiles, ...ParametricRibbonProfiles];
        const merged = mergeRibbonProfiles(DefaultRibbon, extras);

        const mergedRefs = collectRefs(merged);
        const sourceRefs = collectRefs(DefaultRibbon);
        collectRefs(extras, sourceRefs);

        for (const ref of mergedRefs) {
            expect(sourceRefs.has(ref)).toBe(false);
        }
    });
});

/** Every array and plain object reachable from `root`; runtime collections are shared by design. */
function collectRefs(root: unknown, into: Set<object> = new Set()): Set<object> {
    if (typeof root !== "object" || root === null || root instanceof ObservableCollection) return into;
    into.add(root);
    for (const value of Object.values(root)) {
        collectRefs(value, into);
    }
    return into;
}

/** Recursively flatten item entries that may be strings, string arrays, or {type, items} objects. */
function flattenItems(items: any[]): string[] {
    const result: string[] = [];
    for (const item of items) {
        if (typeof item === "string") {
            result.push(item);
        } else if (Array.isArray(item)) {
            result.push(...flattenItems(item));
        } else if (typeof item === "object" && "items" in item && Array.isArray(item.items)) {
            result.push(...flattenItems(item.items));
        }
    }
    return result;
}
