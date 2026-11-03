// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandKeys,
    ObservableCollection,
    type PushButton,
    type RibbonButton,
    type RibbonCommand,
    type RibbonGroupProfile,
    type RibbonTabKeys,
    type RibbonTabProfile,
} from "@chili3d/core";

export const DefaultRibbon: RibbonTabProfile[] = [
    {
        tabName: "ribbon.tab.basic",
        groups: [
            {
                groupName: "ribbon.group.draw",
                items: [
                    "create.line",
                    {
                        type: "split",
                        items: ["create.rect", "create.circle", "create.ellipse", "create.regularPolygon"],
                    },
                    {
                        type: "split",
                        items: ["create.arc", "create.arc2point", "create.arc3point", "create.arcTTR"],
                    },
                    {
                        type: "split",
                        items: [
                            "create.box",
                            "create.sphere",
                            "create.cylinder",
                            "create.cone",
                            "create.pyramid",
                        ],
                    },
                    "create.extrude",
                    [
                        { type: "split", items: ["create.loft", "create.gordon"] },
                        "create.sweep",
                        "create.revol",
                    ],
                ],
                collapsedItems: [
                    "create.point",
                    "create.polygon",
                    "create.bezier",
                    "create.helix",
                    "create.pipe",
                    "create.text",
                ],
            },
            {
                groupName: "ribbon.group.modify",
                items: [
                    "modify.move",
                    ["modify.rotate", "modify.mirror", "modify.array"],
                    ["modify.moveCopy", "modify.align"],
                    ["modify.trim", "modify.extend", "modify.shell"],
                    ["modify.split", "modify.sew", "modify.simplifyShape"],
                    ["modify.fillet", "modify.chamfer", "modify.explode"],
                    ["modify.deleteNode", "modify.removeShapes", "modify.removeFeature"],
                ],
                collapsedItems: [
                    "modify.break",
                    "modify.paintBucket",
                    "modify.brushAdd",
                    "modify.brushRemove",
                    "modify.brushClear",
                ],
            },
            {
                groupName: "ribbon.group.converter",
                items: [
                    "convert.toWire",
                    "convert.toCompound",
                    ["convert.toFace", "convert.toShell", "convert.toSolid"],
                ],
            },
            {
                groupName: "ribbon.group.boolean",
                items: [["boolean.common", "boolean.cut", "boolean.join"]],
            },
            {
                groupName: "ribbon.group.workingPlane",
                items: [
                    "workingPlane.toggleDynamic",
                    ["workingPlane.set", "workingPlane.alignToPlane", "workingPlane.fromSection"],
                ],
            },
            {
                groupName: "ribbon.group.tools",
                items: [
                    "convert.curveProjection",
                    "create.group",
                    ["create.section", "create.offset", "create.copyShape"],
                ],
                collapsedItems: ["modify.repairShape", "modify.checkShape"],
            },
            {
                groupName: "ribbon.group.measure",
                items: [["measure.length", "measure.angle", "measure.select"]],
            },
            {
                groupName: "ribbon.group.inspect",
                items: ["inspect.section", ["inspect.interference", "inspect.massProperties"]],
            },
            {
                groupName: "ribbon.group.annotation",
                items: [
                    "annotate.dimension",
                    ["annotate.radius", "annotate.diameter", "annotate.angle"],
                    "annotate.text",
                ],
            },
            {
                groupName: "ribbon.group.act",
                items: ["act.alignCamera"],
            },
            {
                groupName: "ribbon.group.importExport",
                items: ["file.import", "file.export"],
            },
            {
                groupName: "ribbon.group.other",
                items: ["wechat.group", "ai.toggleChat"],
            },
        ],
    },
    {
        tabName: "ribbon.tab.manager",
        groups: [
            {
                groupName: "ribbon.group.other",
                items: ["test.performance"],
            },
        ],
    },
];

/** Extras may request insertion before an existing tab instead of appending. */
export type RibbonProfileExtra = RibbonTabProfile & { before?: RibbonTabKeys };

/**
 * Ribbon contributions of the parametric module, applied by `AppBuilder.useParametric`.
 * The parametric tab is the design workspace's first ("Solid") tab and its groups follow the
 * order a part is built in: CREATE what builds geometry out of a profile (the sketch module
 * prepends its sketch commands here), MODIFY what rewrites geometry that is already there,
 * ASSEMBLE what places bodies, CONSTRUCT the reference geometry, INSPECT what measures and
 * annotates, INSERT what brings data in or out. In every group the top-level single commands
 * are the toolbar's icons; stacks and the rest are reached through the group's dropdown.
 */
export const ParametricRibbonProfiles: RibbonProfileExtra[] = [
    {
        tabName: "ribbon.tab.parametric",
        before: "ribbon.tab.basic",
        groups: [
            {
                groupName: "ribbon.group.create",
                items: [
                    "feature.extrude",
                    "feature.revolve",
                    "feature.sweep",
                    "feature.loft",
                    "feature.hole",
                    ["feature.rib", "feature.thread", "feature.helix"],
                    [
                        {
                            type: "split",
                            items: [
                                "feature.patternLinear",
                                "feature.patternCircular",
                                "feature.patternCurve",
                            ],
                        },
                        "feature.mirror",
                        "feature.thicken",
                    ],
                    [
                        {
                            type: "split",
                            items: [
                                "feature.primitiveBox",
                                "feature.primitiveCylinder",
                                "feature.primitiveSphere",
                                "feature.primitiveCone",
                            ],
                        },
                    ],
                ],
            },
            {
                groupName: "ribbon.group.modify",
                items: [
                    "feature.pressPull",
                    {
                        type: "split",
                        items: ["feature.fillet", "feature.modifyFillet"],
                    },
                    {
                        type: "split",
                        items: ["feature.chamfer", "feature.modifyChamfer"],
                    },
                    "feature.shell",
                    "feature.draft",
                    "feature.split",
                    ["feature.offsetFace", "feature.removeFeature"],
                    ["feature.fuse", "feature.cut", "feature.common"],
                    ["modify.deleteNode", "modify.paintBucket", "feature.variable"],
                ],
            },
            {
                groupName: "ribbon.group.assemble",
                items: [
                    "modify.moveCopy",
                    "modify.align",
                    ["modify.move", "modify.rotate", "modify.mirror"],
                    ["modify.detach", "modify.array"],
                ],
            },
            {
                groupName: "ribbon.group.construct",
                items: [
                    "feature.plane",
                    [
                        "workingPlane.set",
                        "workingPlane.alignToPlane",
                        "workingPlane.fromSection",
                        "workingPlane.toggleDynamic",
                    ],
                ],
            },
            {
                groupName: "ribbon.group.inspect",
                items: [
                    "measure.length",
                    "inspect.section",
                    ["measure.angle", "measure.select"],
                    ["inspect.interference", "inspect.massProperties"],
                    ["annotate.dimension", "annotate.radius", "annotate.diameter"],
                    ["annotate.angle", "annotate.text"],
                ],
            },
            {
                groupName: "ribbon.group.insert",
                items: ["file.import", ["file.export", "ai.toggleChat", "wechat.group"]],
            },
        ],
    },
];

/**
 * The drawing workspace: its own tab, in a workspace of its own so the toolbar's switcher
 * shows it alone. A drawing opens in a full-screen sheet editor, where views, dimensions and
 * exports live; the tab only starts one, or reopens the drawing selected in the tree.
 */
export const DrawingRibbonProfiles: RibbonProfileExtra[] = [
    {
        tabName: "ribbon.tab.drawing",
        before: "ribbon.tab.manager",
        workspace: "ribbon.workspace.drawing",
        groups: [
            {
                groupName: "ribbon.group.drawing",
                items: ["drawing.create", "drawing.open"],
            },
        ],
    },
];

/**
 * Returns a new profile list with `extras` merged into a copy of `base`: extra
 * items are prepended to the matching group (contributions land first), unknown
 * groups are appended, and new tabs are inserted before their `before` tab or
 * appended. The copy is deep — neither `base` nor `extras` is referenced by the
 * result, so merging twice or editing the result cannot grow the module-level
 * profiles.
 */
export function mergeRibbonProfiles(
    base: RibbonTabProfile[],
    extras: RibbonProfileExtra[],
): RibbonTabProfile[] {
    const result = base.map(copyTabProfile);
    for (const extra of extras) {
        mergeTab(result, extra);
    }
    return result;
}

function copyTabProfile(tab: RibbonTabProfile): RibbonTabProfile {
    return { ...tab, groups: tab.groups.map(copyGroupProfile) };
}

function copyGroupProfile(group: RibbonGroupProfile): RibbonGroupProfile {
    return {
        ...group,
        items: group.items.map(copyItem),
        collapsedItems: group.collapsedItems === undefined ? undefined : [...group.collapsedItems],
    };
}

function copyItem(item: RibbonCommand | RibbonButton[]): RibbonCommand | RibbonButton[] {
    if (Array.isArray(item)) return item.map(copyButton);
    // An ObservableCollection is a runtime value, not static layout — share it.
    if (item instanceof ObservableCollection) return item;
    return copyButton(item);
}

function copyButton(button: RibbonButton): RibbonButton {
    if (typeof button === "string") return button;
    if (button.type === "push") return { ...button };
    return { ...button, items: button.items.map(copyButtonItem) };
}

function copyButtonItem(item: PushButton | CommandKeys): PushButton | CommandKeys {
    return typeof item === "string" ? item : { ...item };
}

function mergeTab(result: RibbonTabProfile[], extra: RibbonProfileExtra): void {
    const tab = result.find((t) => t.tabName === extra.tabName);
    if (tab === undefined) {
        const beforeIndex = result.findIndex((t) => t.tabName === extra.before);
        if (beforeIndex < 0) {
            result.push(copyTabProfile(extra));
        } else {
            result.splice(beforeIndex, 0, copyTabProfile(extra));
        }
        return;
    }
    tab.contextual = tab.contextual || extra.contextual;
    for (const group of extra.groups) {
        const existing = tab.groups.find((g) => g.groupName === group.groupName);
        if (existing === undefined) {
            tab.groups.push(copyGroupProfile(group));
        } else {
            existing.items.unshift(...group.items.map(copyItem));
            if (group.collapsedItems !== undefined) {
                existing.collapsedItems = [...group.collapsedItems, ...(existing.collapsedItems ?? [])];
            }
        }
    }
}
