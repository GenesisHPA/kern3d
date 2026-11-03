// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { INode } from "./node";

/**
 * The section of the browser panel a node is listed under. Display-only: nothing about it is
 * stored, and a node's place in the document tree is unchanged by it.
 */
export type NodeCategory =
    | "body"
    | "sketch"
    | "construction"
    | "component"
    | "joint"
    | "drawing"
    | "annotation"
    | "other";

/** Answers the category of the nodes it knows, and undefined for every other node. */
export type NodeCategoryRule = (node: INode) => NodeCategory | undefined;

/**
 * The browser's classification of document nodes by kind. Feature packages register a rule for
 * their own node classes when they load (the sketch module for sketches, the drawing module for
 * drawings), so the panel can group nodes without importing them. The first rule that answers
 * wins; `fallback` answers the rest.
 */
export class NodeCategories {
    private static readonly rules: NodeCategoryRule[] = [];

    static register(rule: NodeCategoryRule): () => void {
        NodeCategories.rules.push(rule);
        return () => {
            const index = NodeCategories.rules.indexOf(rule);
            if (index >= 0) NodeCategories.rules.splice(index, 1);
        };
    }

    static of(node: INode, fallback: NodeCategoryRule): NodeCategory {
        for (const rule of NodeCategories.rules) {
            const category = rule(node);
            if (category !== undefined) return category;
        }
        return fallback(node) ?? "other";
    }
}
