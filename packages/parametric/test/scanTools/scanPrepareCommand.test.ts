// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { MeshNode, NodeUtils } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { describe, expect, test } from "@rstest/core";
import { worldTriangles } from "../../src/commands/scanCommon";
import { addPreparedMesh, displayMeshOf } from "../../src/commands/scanPrepareCommand";
import { prepareScan, weldSoup } from "../../src/scanTools/scanPrep";
import { meshVolume, weldTriangles } from "../../src/stlRebuild/mesh";
import { plateWithHole, soupOf } from "./meshes";

function scene() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as never;
    return doc;
}

describe("scan clean-up's result", () => {
    test("the cleaned mesh lands beside the source as a mesh node, the source hidden", () => {
        const doc = scene();
        const soup = plateWithHole(40, 10, 6, 64, 8, 8);
        const raw = weldTriangles(soup);
        const source = new MeshNode({ document: doc, name: "scan", mesh: displayMeshOf(raw) });
        doc.modelManager.addNode(source);
        // what the command reads back off the mesh node is the part
        const back = weldSoup(worldTriangles(source));
        expect(meshVolume(back)).toBeCloseTo(meshVolume(raw), 3);
        const { mesh } = prepareScan(back, { targetTriangles: 2000, smoothing: 1, maxHoleEdges: 50 });
        const node = addPreparedMesh(doc, source, mesh);
        const nodes = [...NodeUtils.children(doc.modelManager.rootNode)];
        expect(nodes.indexOf(node)).toBe(nodes.indexOf(source) + 1);
        expect(source.visible).toBe(false);
        expect(node.name).toContain("scan");
        expect(node.mesh.index!.length / 3).toBe(mesh.areas.length);
        const roundTrip = weldSoup(worldTriangles(node));
        expect(Math.abs(meshVolume(roundTrip) - meshVolume(mesh)) / meshVolume(mesh)).toBeLessThan(1e-6);
        // the welded soup has as many triangles as the node shows
        expect(soupOf(roundTrip).length / 9).toBe(mesh.areas.length);
    });
});
