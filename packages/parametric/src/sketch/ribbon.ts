// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { RibbonTabKeys, RibbonTabProfile } from "@chili3d/core";

/** Extras may request insertion before an existing tab instead of appending. */
type RibbonProfileExtra = RibbonTabProfile & { before?: RibbonTabKeys };

/**
 * Ribbon contributions of the sketch module, applied by `AppBuilder.useParametric`.
 * Without it no sketch command is registered, so these stay out of the ribbon.
 *
 * The parametric tab gets the sketch entry commands at the head of its CREATE group; the
 * contextual sketch tab, open while a sketch is edited, groups its tools the way a sketch is
 * drawn — CREATE, MODIFY, CONSTRAINTS, INSPECT — and ends with the prominent finish button.
 */
export const SketchRibbonProfiles: RibbonProfileExtra[] = [
    {
        tabName: "ribbon.tab.parametric",
        before: "ribbon.tab.basic",
        groups: [
            {
                groupName: "ribbon.group.create",
                items: ["sketch.create", ["sketch.enter"]],
            },
        ],
    },
    {
        tabName: "ribbon.tab.sketch",
        contextual: true,
        groups: [
            {
                groupName: "ribbon.group.create",
                items: [
                    "sketch.line",
                    {
                        type: "split",
                        items: ["sketch.rectangle", "sketch.polygon"],
                    },
                    {
                        type: "split",
                        items: ["sketch.circle", "sketch.ellipse"],
                    },
                    {
                        type: "split",
                        items: ["sketch.arc", "sketch.ellipseArc"],
                    },
                    [
                        {
                            type: "split",
                            items: ["sketch.nurbs", "sketch.bezier", "sketch.conic"],
                        },
                        "sketch.point",
                        "sketch.text",
                    ],
                    ["sketch.projectEdges", "sketch.toggleExternal", "sketch.toggleConstruction"],
                ],
            },
            {
                groupName: "ribbon.group.modify",
                items: [
                    {
                        type: "split",
                        items: ["sketch.fillet", "sketch.chamfer"],
                    },
                    "sketch.trim",
                    "sketch.offset",
                    ["sketch.extend", "sketch.break"],
                    ["sketch.mirror", "sketch.transform", "sketch.array"],
                ],
            },
            {
                groupName: "ribbon.group.constraint",
                items: [
                    "dimension",
                    "constraint.coincident",
                    "constraint.horizontal",
                    "constraint.vertical",
                    ["constraint.fix", "constraint.parallel", "constraint.perpendicular"],
                    ["constraint.equal", "constraint.tangent", "constraint.symmetric"],
                    ["constraint.midpoint", "constraint.pointOn"],
                    ["constraint.horizontalAlign", "constraint.verticalAlign", "constraint.toggleDriven"],
                    ["dimension.distance", "dimension.radius", "dimension.angle"],
                    [
                        "dimension.pointLineDistance",
                        "dimension.horizontalDistance",
                        "dimension.verticalDistance",
                    ],
                ],
            },
            {
                groupName: "ribbon.group.inspect",
                items: ["sketch.constraints"],
            },
            {
                groupName: "ribbon.group.finishSketch",
                prominent: true,
                items: ["sketch.exit"],
            },
        ],
    },
];
