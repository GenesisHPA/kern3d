// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    BoundingBox,
    type FeatureItem,
    type I18nKeys,
    type IApplication,
    type IDocument,
    type IFeatureListNode,
    type INode,
    PubSub,
    Signal,
    VisualNode,
} from "@chili3d/core";
import { createMockSelection, TestDocument } from "@chili3d/core/test-utils";
import { afterEach, describe, expect, test } from "@rstest/core";
import { featureBodies, stepBar, Timeline } from "../src/timeline/timeline";

/** A parametric body stand-in: a feature list it can edit and a rollback bar. */
class FakeBody extends VisualNode implements IFeatureListNode {
    items: FeatureItem[];
    renders = 0;

    constructor(document: IDocument, name: string, count: number) {
        super(document, name, `${name}-id`);
        this.items = Array.from({ length: count }, (_, i) => ({
            id: `f${i}`,
            display: "common.ok" as I18nKeys,
            name: `feature ${i}`,
            parameters: [],
        }));
    }

    display(): I18nKeys {
        return "common.ok" as I18nKeys;
    }
    boundingBox() {
        return new BoundingBox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    }

    get featuresJson(): string {
        return JSON.stringify(this.items.map((x) => [x.id, x.suppressed === true]));
    }
    get rollbackBarIndex(): number | undefined {
        return this.getPrivateValue("rollbackBarIndex" as never);
    }

    featureItems() {
        this.renders++;
        return this.items;
    }
    setFeatureParameter() {}
    setFeatureSuppressed(featureId: string, suppressed: boolean) {
        const before = this.featuresJson;
        this.items = this.items.map((x) => (x.id === featureId ? { ...x, suppressed } : x));
        this.emitPropertyChanged("featuresJson" as never, before as never);
    }
    moveFeature() {}
    removeFeature(featureId: string) {
        const before = this.featuresJson;
        this.items = this.items.filter((x) => x.id !== featureId);
        this.emitPropertyChanged("featuresJson" as never, before as never);
    }
    setRollbackBar(index: number | undefined) {
        this.setProperty("rollbackBarIndex" as never, index as never);
    }
}

function setup(count = 4) {
    const selection = { ...createMockSelection(), onNodeChanged: new Signal<(nodes: INode[]) => void>() };
    const doc = new TestDocument({ selection });
    const body = new FakeBody(doc, "body", count);
    doc.modelManager.rootNode.add(body);
    const app = { activeView: { document: doc } } as unknown as IApplication;
    const timeline = new Timeline(app);
    document.body.append(timeline);
    return { doc, body, timeline };
}

const icons = (timeline: Timeline) =>
    Array.from(timeline.querySelectorAll<HTMLElement>("[data-feature]")).map((x) => x.dataset["feature"]);

/** The strip's children in order: feature ids, and "|" where the marker stands. */
const strip = (timeline: Timeline) =>
    Array.from(timeline.querySelectorAll<HTMLElement>("[data-feature], [data-marker]")).map(
        (x) => x.dataset["feature"] ?? "|",
    );

afterEach(() => {
    document.body.replaceChildren();
});

describe("stepBar", () => {
    test.each([
        [undefined, 4, -1, 3],
        [3, 4, 1, undefined],
        [0, 4, -1, 0],
        [1, 4, 1, 2],
    ])("from %s of %s by %s gives %s", (bar, count, step, expected) => {
        expect(stepBar(bar, count, step as -1 | 1)).toBe(expected);
    });
});

describe("Timeline", () => {
    test("shows the document's body: one icon per feature and the marker at the end", () => {
        const { timeline, body } = setup(3);
        expect(timeline.currentBody).toBe(body);
        expect(icons(timeline)).toEqual(["f0", "f1", "f2"]);
        expect(strip(timeline).at(-1)).toBe("|");
    });

    test("the playback buttons move the rollback bar", () => {
        const { timeline, body } = setup(3);
        const press = (action: string) =>
            (timeline.querySelector(`[data-action="${action}"]`) as HTMLElement).click();

        press("stepBack");
        expect(body.rollbackBarIndex).toBe(2);
        press("toStart");
        expect(body.rollbackBarIndex).toBe(0);
        press("stepForward");
        expect(body.rollbackBarIndex).toBe(1);
        press("toEnd");
        expect(body.rollbackBarIndex).toBeUndefined();
    });

    test("the marker follows the bar and dims the rolled-back features", () => {
        const { timeline, body } = setup(3);
        timeline.moveBar(1);
        expect(body.rollbackBarIndex).toBe(1);
        const order = strip(timeline);
        expect(order.indexOf("|")).toBe(1);
        const [first, second] = Array.from(timeline.querySelectorAll<HTMLElement>("[data-feature]"));
        expect(second.className).not.toBe(first.className);
    });

    test("an unrelated property change does not rebuild the strip", () => {
        const { body } = setup(3);
        const before = body.renders;
        body.name = "renamed";
        body.visible = false;
        expect(body.renders).toBe(before);
    });

    test("an edit of the feature list rebuilds it", () => {
        const { timeline, body } = setup(3);
        body.removeFeature("f1");
        expect(icons(timeline)).toEqual(["f0", "f2"]);
    });

    test("double-click asks the panel to open the feature and selects the body", () => {
        const { timeline, body, doc } = setup(2);
        const focused: [INode, string][] = [];
        const record = (node: INode, id: string) => focused.push([node, id]);
        const selected: INode[][] = [];
        doc.selection.setSelectedNodes = (nodes: INode[]) => {
            selected.push(nodes);
            return nodes.length;
        };
        PubSub.default.sub("focusFeature", record);
        try {
            timeline.querySelector('[data-feature="f1"]')!.dispatchEvent(new MouseEvent("dblclick"));
            expect(focused).toEqual([[body, "f1"]]);
            expect(selected).toEqual([[body]]);
        } finally {
            PubSub.default.remove("focusFeature", record);
        }
    });

    test("selecting another body switches the strip to it", () => {
        const { timeline, doc } = setup(2);
        const other = new FakeBody(doc, "other", 1);
        doc.modelManager.rootNode.add(other);
        expect(featureBodies(doc).length).toBe(2);
        doc.selection.onNodeChanged.emit([other]);
        expect(timeline.currentBody).toBe(other);
        expect(icons(timeline)).toEqual(["f0"]);
    });

    test("the body going away picks the next one, or shows the hint", () => {
        const { timeline, doc, body } = setup(2);
        doc.modelManager.rootNode.remove(body);
        expect(timeline.currentBody).toBeUndefined();
        expect(icons(timeline)).toEqual([]);
    });
});
