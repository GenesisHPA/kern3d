// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AssemblyComponentNode, FolderNode, type INode, Signal } from "@chili3d/core";
import { createMockSelection, TestDocument, TestNode } from "@chili3d/core/test-utils";
import { afterEach, describe, expect, test } from "@rstest/core";
import { BrowserView, browserCategory, componentRows, listedNodes } from "../src/project/browser/browserView";

function makeDocument() {
    const selection = { ...createMockSelection(), onNodeChanged: new Signal<(nodes: INode[]) => void>() };
    return new TestDocument({ selection });
}

function sectionRows(view: BrowserView, section: string) {
    const element = view.querySelector(`[data-section="${section}"]`) as HTMLElement;
    return Array.from(element.querySelectorAll("tree-model")) as (HTMLElement & { node: INode })[];
}

afterEach(() => {
    document.body.replaceChildren();
});

describe("browser: assembly components", () => {
    test("a component is listed whole; its contents are not among the document's bodies", () => {
        const doc = makeDocument();
        const component = new AssemblyComponentNode({ document: doc, name: "C" });
        const inner = new TestNode("inner");
        const outer = new TestNode("outer");
        doc.modelManager.rootNode.add(component, outer);
        component.add(inner);
        expect(browserCategory(component)).toBe("component");
        expect(listedNodes(doc.modelManager.rootNode)).toEqual([component, outer]);
    });

    test("contents are indented under their component, nested components one level deeper", () => {
        const doc = makeDocument();
        const top = new AssemblyComponentNode({ document: doc, name: "Top" });
        const sub = new AssemblyComponentNode({ document: doc, name: "Sub" });
        const folder = new FolderNode({ document: doc, name: "F" });
        const a = new TestNode("a");
        const b = new TestNode("b");
        const c = new TestNode("c");
        doc.modelManager.rootNode.add(top);
        top.add(a, sub, folder);
        sub.add(b);
        folder.add(c);
        expect(componentRows(top)).toEqual([
            { node: a, depth: 1 },
            { node: sub, depth: 1 },
            { node: b, depth: 2 },
            { node: c, depth: 1 },
        ]);

        const view = new BrowserView(doc);
        window.document.body.append(view);
        const rows = sectionRows(view, "component");
        expect(rows.map((row) => row.node.name)).toEqual(["Top", "a", "Sub", "b", "c"]);
        expect(rows[0].style.paddingLeft).toBe("");
        expect(rows[3].style.paddingLeft).toBe("48px");
        expect(sectionRows(view, "body")).toHaveLength(0);
        // The count is of components, not of the rows under them.
        const header = view.querySelector('[data-section="component"]')!;
        expect(header.textContent).toContain("1");
    });

    test("grounding a component swaps its row icon", () => {
        const doc = makeDocument();
        const component = new AssemblyComponentNode({ document: doc, name: "C" });
        doc.modelManager.rootNode.add(component);
        const view = new BrowserView(doc);
        window.document.body.append(view);
        const icon = () => view.rowOf(component)!.querySelector("svg")!.innerHTML;
        const before = icon();
        expect(before).toContain("icon-group");
        component.grounded = true;
        expect(icon()).toContain("icon-lock");
    });
});
