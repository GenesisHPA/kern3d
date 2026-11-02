// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IView, Plane, XYZ } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { Scene, Vector3 } from "three";
import { SECTION_CAP_SLACK, threeClipPlane } from "../src/threeView";
import { createThreeMockVisualContext } from "./mocks";
import { TestView } from "./testView";

function createView() {
    const doc = new TestDocument();
    const views: IView[] = [];
    (views as any).remove = (item: IView) => views.splice(views.indexOf(item), 1);
    (doc.application as any).views = views;
    const context = createThreeMockVisualContext();
    (context as any).scene ??= new Scene();
    return new TestView(doc, context, { setDom: false });
}

describe("section clip plane", () => {
    const plane = new Plane({ origin: new XYZ({ x: 0, y: 0, z: 5 }), normal: XYZ.unitZ, xvec: XYZ.unitX });

    test("keeps the side opposite the normal and removes the side it points to", () => {
        const clip = threeClipPlane(plane);
        expect(clip.distanceToPoint(new Vector3(3, 4, 0))).toBeGreaterThan(0);
        expect(clip.distanceToPoint(new Vector3(3, 4, 6))).toBeLessThan(0);
    });

    test("a cap drawn on the cut itself survives the clip by the slack", () => {
        const clip = threeClipPlane(plane);
        expect(clip.distanceToPoint(new Vector3(10, -2, 5))).toBeCloseTo(SECTION_CAP_SLACK, 9);
    });

    test("a tilted plane clips by signed distance along its own normal", () => {
        const normal = new XYZ({ x: 1, y: 1, z: 0 }).normalize()!;
        const tilted = new Plane({ origin: new XYZ({ x: 10, y: 0, z: 0 }), normal, xvec: XYZ.unitZ });
        const clip = threeClipPlane(tilted);
        expect(clip.distanceToPoint(new Vector3(0, 0, 0))).toBeCloseTo(
            10 / Math.SQRT2 + SECTION_CAP_SLACK,
            9,
        );
        expect(clip.distanceToPoint(new Vector3(20, 0, 0))).toBeCloseTo(
            -10 / Math.SQRT2 + SECTION_CAP_SLACK,
            9,
        );
    });

    test("the view installs the clip on its renderer and clears it again", () => {
        const view = createView();
        expect(view.sectionPlane).toBeUndefined();
        view.setSectionPlane(plane);
        expect(view.sectionPlane).toBe(plane);
        expect(view.renderer.clippingPlanes.length).toBe(1);
        expect(view.renderer.clippingPlanes[0].normal.z).toBe(-1);
        view.setSectionPlane(undefined);
        expect(view.sectionPlane).toBeUndefined();
        expect(view.renderer.clippingPlanes).toEqual([]);
    });
});
