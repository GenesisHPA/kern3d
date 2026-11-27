// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    type IDocument,
    type INode,
    type Matrix4,
    MeshNode,
    ShapeNode,
    VisualNode,
} from "@chili3d/core";
import { weldSoup } from "../scanTools/scanPrep";
import type { TriMesh } from "../stlRebuild/mesh";
import { sourceTriangles } from "../stlRebuild/sourceMesh";
import { trianglesOf } from "../stlRebuild/verify";

/**
 * What the scan tools read a part from: an imported mesh (a `MeshNode` — what a large STL, and
 * so any real scan, imports as) or a body with a shape (an STL made a solid, a rebuilt body).
 */
export function isMeshSource(node: INode): node is MeshNode | ShapeNode {
    if (node instanceof MeshNode)
        return node.mesh.meshType === "surface" && (node.mesh.position?.length ?? 0) >= 9;
    return node instanceof ShapeNode && node.shape.isOk;
}

/**
 * The node's triangles in world coordinates (9 numbers each): a mesh node's own, a body's
 * imported STL when this session still has it (`sourceTriangles`: exact, where the display mesh
 * of the solid made from it can lose faces), else the body's display mesh.
 */
export function worldTriangles(node: MeshNode | ShapeNode): Float64Array {
    const local =
        node instanceof MeshNode
            ? meshNodeTriangles(node)
            : (sourceTriangles(node.id) ?? trianglesOf(node.shape.value));
    return transformed(local, node instanceof VisualNode ? node.worldTransform() : undefined);
}

function meshNodeTriangles(node: MeshNode): Float64Array {
    const position = node.mesh.position ?? new Float32Array(0);
    const index = node.mesh.index;
    if (index === undefined || index.length === 0) return Float64Array.from(position);
    const out = new Float64Array(index.length * 3);
    for (let i = 0; i < index.length; i++) {
        out[3 * i] = position[3 * index[i]];
        out[3 * i + 1] = position[3 * index[i] + 1];
        out[3 * i + 2] = position[3 * index[i] + 2];
    }
    return out;
}

function transformed(soup: Float64Array, matrix: Matrix4 | undefined): Float64Array {
    if (matrix === undefined || isIdentity(matrix)) return soup;
    return Float64Array.from(matrix.ofPoints(soup));
}

function isIdentity(m: Matrix4): boolean {
    const a = m.toArray();
    return a.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-12);
}

/** The node's welded mesh in world coordinates (see `worldTriangles`; a numeric weld: scans are big). */
export function worldMesh(node: MeshNode | ShapeNode): TriMesh {
    return weldSoup(worldTriangles(node));
}

/**
 * The mesh sources the user means: the selected ones, else one picked. Undefined when none was
 * picked (Escape).
 */
export async function pickMeshSources(
    document: IDocument,
    multi = false,
): Promise<(MeshNode | ShapeNode)[] | undefined> {
    const selected = document.selection.getSelectedNodes().filter(isMeshSource);
    if (selected.length > 0) return multi ? selected : selected.slice(0, 1);
    const picked = await document.picker.pickNode("prompt.select.scanMesh", new AsyncController(), {
        multi,
        nodeFilter: { allow: isMeshSource },
    });
    const nodes = picked.filter(isMeshSource);
    return nodes.length === 0 ? undefined : nodes;
}
