// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IShape, Result, ShapeTypes } from "@chili3d/core";
import { type FeatureHandler, type ImportedFeatureData, registerFeature } from "./feature";

/**
 * The imported geometry as the first step of a parametric body (Fusion's base feature): the
 * shape kept as BREP text, read back on every rebuild. What follows it — a hole, a cut, a
 * fillet, a join — is an ordinary feature on top, so an imported part edits like a modelled
 * one. Its faces and edges are named by their place in the BREP (fixed text, so the same
 * order every read), which is what later features anchor their picks to.
 */
const importedHandler: FeatureHandler<ImportedFeatureData> = {
    display: "feature.imported",
    icon: "icon-import",

    nodeIds: () => [],
    parameters: () => [],
    setParameter: (feature) => feature,

    evaluate(feature, context): Result<IShape> {
        const read = shapeConverter.convertFromBrep(feature.brep);
        if (!read.isOk) return Result.err(read.error);
        const shape = read.value;
        if (context.tracking !== undefined) {
            const faces = shape.findSubShapes(ShapeTypes.face);
            const edges = shape.findSubShapes(ShapeTypes.edge);
            context.tracking.outputFaceIds = faces.map((_, i) => `${feature.id}:f${i}`);
            context.tracking.outputEdgeIds = edges.map((_, i) => `${feature.id}:e${i}`);
        }
        return Result.ok(shape);
    },
};

registerFeature("imported", importedHandler);
