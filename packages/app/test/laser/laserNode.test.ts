// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, Serializer, Transaction } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { defaultOperation, type LaserImageObject, type LaserVectorObject } from "../../src/laser/laserData";
import { LaserNode } from "../../src/laser/laserNode";
import {
    defaultMachineProfile,
    loadMachineProfile,
    saveMachineProfile,
} from "../../src/laser/machineProfile";

function vector(): LaserVectorObject {
    const op = defaultOperation("fill");
    op.fillAngle = 30;
    op.passes = 3;
    op.air = true;
    return {
        id: "v1",
        name: "logo",
        kind: "vector",
        x: 12.5,
        y: 7,
        width: 40,
        height: 20,
        angle: 15,
        lockAspect: false,
        sourceWidth: 4,
        sourceHeight: 2,
        paths: [
            {
                closed: true,
                points: [
                    { x: 0, y: 0 },
                    { x: 4, y: 0 },
                    { x: 4, y: 2 },
                ],
            },
        ],
        op,
    };
}

function image(): LaserImageObject {
    const op = defaultOperation("image");
    op.raster = { ...op.raster, mode: "dither", dither: "jarvis", resolution: 12, gamma: 1.4, invert: true };
    return {
        id: "i1",
        name: "photo",
        kind: "image",
        x: 100,
        y: 50,
        width: 30,
        height: 20,
        angle: 0,
        lockAspect: true,
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
        pixelWidth: 300,
        pixelHeight: 200,
        op,
    };
}

describe("LaserNode", () => {
    let document: IDocument;
    beforeEach(() => {
        document = new TestDocument() as unknown as IDocument;
    });

    test("a job is saved with the document and reopens with its objects and settings", () => {
        const node = new LaserNode({ document, name: "Задание1" });
        const data = node.data;
        data.objects.push(vector(), image());
        node.setData(data);
        const serialized = Serializer.serializeObject(node);
        expect(serialized["__cla$$__"]).toBe("LaserNode");
        const copy = Serializer.deserializeObject(document, serialized) as LaserNode;
        expect(copy).toBeInstanceOf(LaserNode);
        expect(copy.name).toBe("Задание1");
        expect(copy.id).toBe(node.id);
        expect(copy.data).toEqual(data);
        expect(copy.data.objects[1].op.raster.dither).toBe("jarvis");
    });

    test("an edit is one undo step", () => {
        const node = new LaserNode({ document, name: "j" });
        const before = node.content;
        Transaction.execute(document, "edit", () => {
            const data = node.data;
            data.objects.push(vector());
            node.setData(data);
        });
        expect(node.data.objects).toHaveLength(1);
        document.history.undo();
        expect(node.content).toBe(before);
        expect(node.data.objects).toHaveLength(0);
    });
});

describe("machine profile storage", () => {
    afterEach(() => localStorage.clear());

    test("the profile is kept in the browser between sessions", () => {
        saveMachineProfile({ ...defaultMachineProfile(), bedWidth: 300, maxS: 255, baud: 250000 });
        const loaded = loadMachineProfile();
        expect(loaded.bedWidth).toBe(300);
        expect(loaded.maxS).toBe(255);
        expect(loaded.baud).toBe(250000);
    });

    test("nothing stored, or something broken, gives the defaults", () => {
        expect(loadMachineProfile()).toEqual(defaultMachineProfile());
        localStorage.setItem("kern3d.laser.machine", "{broken");
        expect(loadMachineProfile()).toEqual(defaultMachineProfile());
    });
});
