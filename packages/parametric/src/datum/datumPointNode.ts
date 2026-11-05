// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type I18nKeys,
    type IShape,
    type IShapeMeshData,
    type Matrix4,
    Precision,
    property,
    type Result,
    serializable,
    serialize,
    UNITLESS,
    type XYZ,
} from "@chili3d/core";
import type { IDatumPointNode } from "./datumContract";
import { DatumNode, type DatumNodeOptions } from "./datumNode";
import { type PointDefinition, pointDefinitionNodeIds, resolvePointDefinition } from "./pointDefinition";

/** The construction-geometry orange a datum point is drawn in. */
export const DATUM_POINT_COLOR = 0xe8a33d;
const DATUM_POINT_SIZE = 8;

export interface DatumPointNodeOptions extends DatumNodeOptions<PointDefinition> {
    /** The last resolved point, persisted as the fallback when a source is lost. */
    pointPosition?: XYZ;
}

/**
 * A construction point (CONSTRUCT ▸ Point). Named `DatumPointNode` because the
 * direct-modeling `PointNode` already owns that serialized class name. Datum planes and axes
 * accept it wherever they take a vertex.
 */
@serializable()
export class DatumPointNode extends DatumNode<PointDefinition, XYZ> implements IDatumPointNode {
    override display(): I18nKeys {
        return "body.datumPoint";
    }

    override get icon(): string {
        return "icon-datumPoint";
    }

    /** The last resolved point in WORLD coordinates; emitted when the point moves. */
    @serialize()
    get pointPosition(): XYZ | undefined {
        return this.getPrivateValue("pointPosition", undefined);
    }
    set pointPosition(value: XYZ | undefined) {
        this.setProperty("pointPosition", value);
    }

    /** The fraction along the edge, only for `onEdge` definitions; the row hides otherwise. */
    @property("feature.point.ratio", { unit: UNITLESS })
    get ratio(): number | undefined {
        const definition = this.definition;
        return definition.kind === "onEdge" ? definition.ratio : undefined;
    }
    set ratio(value: number) {
        this.updateDefinition((definition) =>
            definition.kind === "onEdge" ? { ...definition, ratio: value } : definition,
        );
    }

    constructor(options: DatumPointNodeOptions) {
        super(options);
        this.setPrivateValue("pointPosition", options.pointPosition);
    }

    worldPoint(visited?: ReadonlySet<string>): XYZ | undefined {
        return this.worldValue(visited);
    }

    protected override defaultDefinition(): PointDefinition {
        return {
            kind: "threePlanes",
            planes: [
                { kind: "datum", name: "XY" },
                { kind: "datum", name: "YZ" },
                { kind: "datum", name: "ZX" },
            ],
        };
    }

    protected override resolveDefinition(definition: PointDefinition, visited: ReadonlySet<string>) {
        return resolvePointDefinition(definition, this.document, visited);
    }

    protected override definitionNodeIds(definition: PointDefinition): Set<string> {
        return pointDefinitionNodeIds(definition);
    }

    protected override buildDisplay(value: XYZ, toLocal: Matrix4): Result<IShape> {
        return shapeFactory.point(toLocal.ofPoint(value));
    }

    protected override get storedValue(): XYZ | undefined {
        return this.pointPosition;
    }

    protected override storeValue(value: XYZ): void {
        this.pointPosition = value;
    }

    protected override sameValue(left: XYZ, right: XYZ): boolean {
        return left.distanceTo(right) <= Precision.Distance;
    }

    /** A larger dot in the construction colour, so it reads apart from a body's vertices. */
    protected override createMesh(): IShapeMeshData {
        const mesh = super.createMesh();
        const vertexs = mesh.vertexs;
        if (vertexs === undefined) return mesh;
        return {
            vertexs: { ...vertexs, color: DATUM_POINT_COLOR, size: DATUM_POINT_SIZE },
            faces: mesh.faces,
            edges: mesh.edges,
        };
    }
}
