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
import { featureBodies, mergeTimeline, stepBar, Timeline } from "../src/timeline/timeline";

/** A parametric body stand-in: a feature list it can edit and a rollback bar. */
class FakeBody extends VisualNode implements IFeatureListNode {
    items: FeatureItem[];
    renders = 0;

    constructor(document: IDocument, name: string, count: number, createdAt?: number[], prefix = "f") {
        super(document, name, `${name}-id`);
        this.items = Array.from({ length: count }, (_, i) => ({
            id: `${prefix}${i}`,
            display: "common.ok" as I18nKeys,
            name: `feature ${i}`,
            createdAt: createdAt?.[i],
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
    test("shows the document's operations: one icon per feature and the marker at the end", () => {
        const { timeline } = setup(3);
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

    test("double-click opens the operation in the edit panel", () => {
        const { timeline, body } = setup(2);
        const opened: [INode, string][] = [];
        const record = (node: INode, id: string) => opened.push([node, id]);
        PubSub.default.sub("editFeature", record);
        try {
            timeline.querySelector('[data-feature="f1"]')!.dispatchEvent(new MouseEvent("dblclick"));
            expect(opened).toEqual([[body, "f1"]]);
        } finally {
            PubSub.default.remove("editFeature", record);
        }
    });

    test("every body's operations are on one strip, in the order they were made", () => {
        const { timeline, doc, body } = setup(0);
        body.items = new FakeBody(doc, "tmp", 2, [10, 30]).items;
        const other = new FakeBody(doc, "other", 2, [20, 40], "g");
        doc.modelManager.rootNode.add(other);
        expect(featureBodies(doc).length).toBe(2);
        timeline.render();
        expect(icons(timeline)).toEqual(["f0", "g0", "f1", "g1"]);
    });

    test("the marker rolls every body back to its operations left of it, in one step", () => {
        const { timeline, doc, body } = setup(0);
        body.items = new FakeBody(doc, "tmp", 2, [10, 30]).items;
        const other = new FakeBody(doc, "other", 2, [20, 40], "g");
        doc.modelManager.rootNode.add(other);
        timeline.render();
        timeline.moveBar(2); // after f0, g0
        expect(body.rollbackBarIndex).toBe(1);
        expect(other.rollbackBarIndex).toBe(1);
        expect(strip(timeline)).toEqual(["f0", "g0", "|", "f1", "g1"]);
        timeline.moveBar(undefined);
        expect(body.rollbackBarIndex).toBeUndefined();
        expect(other.rollbackBarIndex).toBeUndefined();
    });

    test("a body going away leaves the others on the strip, or the hint", () => {
        const { timeline, doc, body } = setup(2);
        const other = new FakeBody(doc, "other", 1, undefined, "g");
        doc.modelManager.rootNode.add(other);
        doc.modelManager.rootNode.remove(body);
        expect(icons(timeline)).toEqual(["g0"]);
        doc.modelManager.rootNode.remove(other);
        expect(icons(timeline)).toEqual([]);
    });
});

describe("mergeTimeline", () => {
    test("keeps each body's own order and puts unstamped (old) features first", () => {
        const doc = new TestDocument({});
        const a = new FakeBody(doc, "a", 2, [undefined as never, 50]);
        const b = new FakeBody(doc, "b", 1, [5], "g");
        expect(
            mergeTimeline([a, b] as unknown as Parameters<typeof mergeTimeline>[0]).map((e) => e.item.id),
        ).toEqual(["f0", "g0", "f1"]);
    });
});
