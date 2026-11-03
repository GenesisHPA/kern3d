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
    XYZ,
} from "@chili3d/core";
import { type AxisDefinition, axisDefinitionNodeIds, resolveAxisDefinition } from "./axisDefinition";
import type { DatumAxisValue, IDatumAxisNode } from "./datumContract";
import { DatumNode, type DatumNodeOptions } from "./datumNode";

/** The construction-geometry orange a datum axis is drawn in (dashed). */
export const DATUM_AXIS_COLOR = 0xe8a33d;

export interface AxisNodeOptions extends DatumNodeOptions<AxisDefinition> {
    /** The last resolved axis as JSON (see `axisLine`). */
    axisLine?: string;
}

/**
 * A construction axis (Fusion's CONSTRUCT ▸ Axis): an infinite line, drawn as a finite dashed
 * segment fitted to the geometry it was made from. A revolve, a circular pattern and the
 * datum-plane/point definitions accept it wherever they take a straight edge.
 */
@serializable()
export class AxisNode extends DatumNode<AxisDefinition, DatumAxisValue> implements IDatumAxisNode {
    override display(): I18nKeys {
        return "body.datumAxis";
    }

    override get icon(): string {
        return "icon-datumAxis";
    }

    /**
     * The last resolved axis in WORLD coordinates, as JSON — a plain value the serializer
     * stores as-is. Emitted when the axis moves, which is what a body revolving about it
     * watches (never its drawing's `shape`).
     */
    @serialize()
    get axisLine(): string | undefined {
        return this.getPrivateValue("axisLine", undefined);
    }
    set axisLine(value: string | undefined) {
        this.setProperty("axisLine", value);
    }

    @property("option.command.flip")
    get flip(): boolean {
        return this.definition.flip === true;
    }
    set flip(value: boolean) {
        this.updateDefinition((definition) => ({ ...definition, flip: value }));
    }

    constructor(options: AxisNodeOptions) {
        super(options);
        this.setPrivateValue("axisLine", options.axisLine);
    }

    worldAxis(visited?: ReadonlySet<string>): DatumAxisValue | undefined {
        return this.worldValue(visited);
    }

    protected override defaultDefinition(): AxisDefinition {
        return {
            kind: "twoPlanes",
            first: { kind: "datum", name: "XY" },
            second: { kind: "datum", name: "ZX" },
        };
    }

    protected override resolveDefinition(definition: AxisDefinition, visited: ReadonlySet<string>) {
        return resolveAxisDefinition(definition, this.document, visited);
    }

    protected override definitionNodeIds(definition: AxisDefinition): Set<string> {
        return axisDefinitionNodeIds(definition);
    }

    protected override buildDisplay(value: DatumAxisValue, toLocal: Matrix4): Result<IShape> {
        return shapeFactory.line(toLocal.ofPoint(value.start), toLocal.ofPoint(value.end));
    }

    protected override get storedValue(): DatumAxisValue | undefined {
        return parseAxis(this.axisLine);
    }

    protected override storeValue(value: DatumAxisValue): void {
        this.axisLine = JSON.stringify({
            point: plain(value.point),
            direction: plain(value.direction),
            start: plain(value.start),
            end: plain(value.end),
        });
    }

    protected override sameValue(left: DatumAxisValue, right: DatumAxisValue): boolean {
        return (
            left.start.distanceTo(right.start) <= Precision.Distance &&
            left.end.distanceTo(right.end) <= Precision.Distance &&
            left.point.distanceTo(right.point) <= Precision.Distance
        );
    }

    /** Drawn dashed and in the construction colour, so it never reads as a model edge. */
    protected override createMesh(): IShapeMeshData {
        const mesh = super.createMesh();
        const edges = mesh.edges;
        if (edges === undefined) return mesh;
        return {
            get vertexs() {
                return mesh.vertexs;
            },
            faces: mesh.faces,
            edges: { ...edges, lineType: "dash", color: DATUM_AXIS_COLOR },
        };
    }
}

function plain(xyz: XYZ) {
    return { x: xyz.x, y: xyz.y, z: xyz.z };
}

function parseAxis(json: string | undefined): DatumAxisValue | undefined {
    if (json === undefined) return undefined;
    try {
        const raw = JSON.parse(json) as Record<"point" | "direction" | "start" | "end", XYZ>;
        return {
            point: new XYZ(raw.point),
            direction: new XYZ(raw.direction),
            start: new XYZ(raw.start),
            end: new XYZ(raw.end),
        };
    } catch {
        return undefined;
    }
}
