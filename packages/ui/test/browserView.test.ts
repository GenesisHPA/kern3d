// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    BoundingBox,
    FolderNode,
    type I18nKeys,
    type IDocument,
    type INode,
    NodeCategories,
    Signal,
    VisualNode,
} from "@chili3d/core";
import { createMockSelection, TestDocument, TestNode } from "@chili3d/core/test-utils";
import { afterEach, describe, expect, test } from "@rstest/core";
import { BrowserView, browserCategory, listedNodes } from "../src/project/browser/browserView";

/** A visual node that belongs to its document, so toggling its eye reaches the visual. */
class DocNode extends VisualNode {
    constructor(document: IDocument, name: string) {
        super(document, name, `${name}-id`);
    }
    display(): I18nKeys {
        return "common.ok" as I18nKeys;
    }
    boundingBox() {
        return new BoundingBox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    }
}

class SketchLike extends TestNode {}

class ReferencePlane extends TestNode {
    readonly isReferenceGeometry = true;
}

function makeDocument() {
    const selection = { ...createMockSelection(), onNodeChanged: new Signal<(nodes: INode[]) => void>() };
    const document = new TestDocument({ selection });
    return document;
}

function add(document: TestDocument, node: INode, parent?: FolderNode) {
    (parent ?? document.modelManager.rootNode).add(node);
    return node;
}

const unregister = NodeCategories.register((node) => (node instanceof SketchLike ? "sketch" : undefined));

afterEach(() => {
    document.body.replaceChildren();
});

describe("browser categories", () => {
    test("feature packages claim their nodes; the rest fall back by kind", () => {
        expect(browserCategory(new SketchLike("s"))).toBe("sketch");
        expect(browserCategory(new ReferencePlane("p"))).toBe("construction");
        expect(browserCategory(new TestNode("b"))).toBe("body");
    });

    test("a removed rule no longer answers", () => {
        class Temporary extends TestNode {}
        const remove = NodeCategories.register((node) => (node instanceof Temporary ? "drawing" : undefined));
        expect(browserCategory(new Temporary("t"))).toBe("drawing");
        remove();
        expect(browserCategory(new Temporary("t"))).toBe("body");
    });

    test("folders are opened up, not listed", () => {
        const document = makeDocument();
        const folder = add(document, new FolderNode({ document, name: "folder" })) as FolderNode;
        const a = add(document, new TestNode("a"), folder);
        const b = add(document, new TestNode("b"));
        expect(listedNodes(document.modelManager.rootNode)).toEqual([a, b]);
    });
});

describe("BrowserView", () => {
    function sectionNames(view: BrowserView, section: string) {
        const element = view.querySelector(`[data-section="${section}"]`) as HTMLElement;
        return Array.from(element.querySelectorAll("tree-model")).map((row) => (row as any).node.name);
    }

    test("lists each node under its kind, in document order", () => {
        const document = makeDocument();
        add(document, new TestNode("body 1"));
        add(document, new SketchLike("sketch 1"));
        add(document, new ReferencePlane("plane"));
        add(document, new TestNode("body 2"));
        const view = new BrowserView(document);
        window.document.body.append(view);

        expect(sectionNames(view, "body")).toEqual(["body 1", "body 2"]);
        expect(sectionNames(view, "sketch")).toEqual(["sketch 1"]);
        expect(sectionNames(view, "construction")).toEqual(["plane"]);
        expect(sectionNames(view, "drawing")).toEqual([]);
    });

    test("follows nodes added and removed, keeping the rows it already has", () => {
        const document = makeDocument();
        const first = add(document, new TestNode("first"));
        const view = new BrowserView(document);
        window.document.body.append(view);
        const row = view.rowOf(first);

        const second = add(document, new TestNode("second"));
        expect(sectionNames(view, "body")).toEqual(["first", "second"]);
        expect(view.rowOf(first)).toBe(row);

        document.modelManager.rootNode.remove(second);
        expect(sectionNames(view, "body")).toEqual(["first"]);
        expect(view.rowOf(second)).toBeUndefined();
    });

    test("the section eye hides every node of the kind, then shows them again", () => {
        const document = makeDocument();
        const a = add(document, new DocNode(document, "a"));
        const b = add(document, new DocNode(document, "b"));
        const view = new BrowserView(document);
        window.document.body.append(view);
        const eye = view.querySelector('[data-section="body"] [data-eye]') as SVGElement;
        expect(eye).not.toBeNull();

        eye.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect([a.visible, b.visible]).toEqual([false, false]);
        eye.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect([a.visible, b.visible]).toEqual([true, true]);
    });

    test("a selected node's row is marked", () => {
        const document = makeDocument();
        const a = add(document, new TestNode("a"));
        const view = new BrowserView(document);
        window.document.body.append(view);
        const before = view.rowOf(a)!.className;

        document.selection.onNodeChanged.emit([a]);
        expect(view.rowOf(a)!.className).not.toBe(before);
        document.selection.onNodeChanged.emit([]);
        expect(view.rowOf(a)!.className).toBe(before);
    });
});

afterAll(() => unregister());
