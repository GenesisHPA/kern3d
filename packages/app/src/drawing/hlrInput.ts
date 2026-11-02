// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ICircle, ICurve, IEdge, IShape, ITrimmedCurve, Matrix4 } from "@chili3d/core";
import type { Vec3 } from "./drawingData";
import type { HlrEdge, HlrFace, HlrInput } from "./hlr";

/** Normals closer than this (cosine) make an edge tangent: a fillet's boundary, not a corner. */
const TANGENT_COS = Math.cos((2 * Math.PI) / 180);

function vertexKey(p: ArrayLike<number>, offset: number): string {
    return `${Math.round(p[offset] * 1e4)}_${Math.round(p[offset + 1] * 1e4)}_${Math.round(p[offset + 2] * 1e4)}`;
}

/** For every mesh position: the faces it occurs in, with the vertex index it has in each. */
function vertexFaces(position: ArrayLike<number>, index: Uint32Array, faces: HlrFace[]) {
    const map = new Map<string, Map<number, number[]>>();
    faces.forEach((face, f) => {
        for (let k = face.start; k < face.start + face.count; k++) {
            const v = index[k];
            const key = vertexKey(position, v * 3);
            let byFace = map.get(key);
            if (byFace === undefined) {
                byFace = new Map();
                map.set(key, byFace);
            }
            const list = byFace.get(f);
            if (list === undefined) byFace.set(f, [v]);
            else if (!list.includes(v)) list.push(v);
        }
    });
    return map;
}

interface EdgeTopology {
    seam: boolean;
    tangent: boolean;
}

/**
 * Which faces an edge bounds, read off the triangulation: the mesher shares an edge's
 * discretisation with the faces on both sides of it, so the faces containing all of its mesh
 * points are its faces. One face holding each point twice is a seam (a cylinder's closing
 * line), which a drawing never shows; two faces with the same normal along it make it tangent.
 */
function edgeTopology(
    edgePoints: ArrayLike<number>,
    start: number,
    count: number,
    faces: Map<string, Map<number, number[]>>,
    normal: ArrayLike<number>,
): EdgeTopology {
    let common: Map<number, number[]> | undefined;
    for (let k = start; k < start + count; k++) {
        const byFace = faces.get(vertexKey(edgePoints, k * 3));
        if (byFace === undefined) return { seam: false, tangent: false };
        if (common === undefined) {
            common = new Map(byFace);
        } else {
            for (const f of [...common.keys()]) {
                if (!byFace.has(f)) common.delete(f);
            }
        }
    }
    if (common === undefined) return { seam: false, tangent: false };
    if (common.size === 1) {
        const point = faces.get(vertexKey(edgePoints, start * 3))!;
        const [face] = [...common.keys()];
        return { seam: (point.get(face)?.length ?? 0) >= 2, tangent: false };
    }
    if (common.size !== 2) return { seam: false, tangent: false };
    const mid = start + Math.floor(count / 2);
    const byFace = faces.get(vertexKey(edgePoints, mid * 3))!;
    const [a, b] = [...common.keys()].map((f) => byFace.get(f)![0]);
    const cos =
        normal[a * 3] * normal[b * 3] +
        normal[a * 3 + 1] * normal[b * 3 + 1] +
        normal[a * 3 + 2] * normal[b * 3 + 2];
    return { seam: false, tangent: cos > TANGENT_COS };
}

function basisCurveOf(edge: IEdge): ICurve {
    let curve: ICurve = edge.curve;
    for (let k = 0; k < 4 && curve.curveType === "trimmedCurve"; k++) {
        curve = (curve as ITrimmedCurve).basisCurve;
    }
    return curve;
}

function toVec(p: { x: number; y: number; z: number }): Vec3 {
    return [p.x, p.y, p.z];
}

function sampleEdge(edge: IEdge, size: number): Omit<HlrEdge, "tangent"> | undefined {
    let curve: ICurve;
    try {
        curve = basisCurveOf(edge);
    } catch {
        return undefined; // degenerate edge (a sphere's pole): nothing to draw
    }
    const t0 = edge.firstParameter();
    const t1 = edge.lastParameter();
    if (curve.curveType === "line") {
        return { points: [toVec(edge.pointAt(t0)), toVec(edge.pointAt(t1))] };
    }
    let n: number;
    let circle: HlrEdge["circle"];
    if (curve.curveType === "circle") {
        const c = curve as ICircle;
        circle = { center: toVec(c.center), axis: toVec(c.axis), radius: c.radius };
        n = Math.max(8, Math.ceil((Math.abs(t1 - t0) / (2 * Math.PI)) * 96));
    } else {
        n = Math.max(12, Math.min(256, Math.ceil(edge.length() / (size / 200))));
    }
    const points: Vec3[] = [];
    for (let i = 0; i <= n; i++) points.push(toVec(edge.pointAt(t0 + ((t1 - t0) * i) / n)));
    return { points, circle };
}

/**
 * The kernel data hidden-line removal works from: the triangulation, and every edge sampled
 * from its exact curve. `transform` places the shape in the world (a node's world transform).
 */
export function extractHlrInput(source: IShape, transform?: Matrix4): HlrInput {
    const shape = transform === undefined ? source : source.transformed(transform);
    const mesh = shape.mesh;
    const faceMesh = mesh.faces;
    const position = faceMesh?.position ?? new Float32Array(0);
    const normal = faceMesh?.normal ?? new Float32Array(0);
    const index = faceMesh?.index ?? new Uint32Array(0);
    const faces: HlrFace[] = (faceMesh?.range ?? []).map((r) => ({ start: r.start, count: r.count }));
    const box = shape.boundingBox();
    const size = Math.max(
        1e-6,
        Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z),
    );

    const lookup = vertexFaces(position, index, faces);
    const edgeMesh = mesh.edges;
    const edges: HlrEdge[] = [];
    for (const range of edgeMesh?.range ?? []) {
        const topology = edgeTopology(edgeMesh!.position, range.start, range.count, lookup, normal);
        if (topology.seam) continue;
        const sampled = sampleEdge(range.shape as unknown as IEdge, size);
        if (sampled !== undefined) edges.push({ ...sampled, tangent: topology.tangent });
    }
    return { position, normal, index, faces, edges };
}
