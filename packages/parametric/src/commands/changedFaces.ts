// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type FaceMeshData, type IFace, type IShape, ShapeTypes, XYZ } from "@chili3d/core";

/** The colour a preview's new or changed faces are drawn in: the brand's orange. */
export const CHANGED_FACE_COLOR = 0xff6a13;
/** The rest of a preview, in the light grey of a part. */
export const KEPT_FACE_COLOR = 0xb8c0c8;

/**
 * What tells one face from another closely enough for a preview: its area and the centre of
 * its bounding box, rounded to a hundredth of the part's size. A face an operation left alone
 * keeps both; a face it made, trimmed or moved changes one of them.
 */
function signature(face: IFace, unit: number): string {
    const box = face.boundingBox();
    const round = (x: number) => Math.round(x / unit);
    if (box === undefined) return `${round(face.area())}`;
    const c = [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2];
    return `${Math.round(face.area() / (unit * unit))}|${c.map(round).join(",")}`;
}

function sizeOf(shape: IShape): number {
    const box = shape.boundingBox();
    if (box === undefined) return 1;
    return Math.max(1e-6, Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z));
}

/**
 * Per-vertex colours for the faces of `after` (its mesh `faces`): the faces `before` does not
 * have in orange, the rest grey — so a 1 mm chamfer on a large part is seen at once. Both
 * shapes in the same frame.
 */
export function changedFaceColors(before: IShape, after: IShape, faces: FaceMeshData): number[] | undefined {
    const unit = sizeOf(after) * 1e-4;
    const known = new Set<string>();
    for (const face of before.findSubShapes(ShapeTypes.face) as IFace[]) known.add(signature(face, unit));
    const colors = new Array<number>(faces.position.length).fill(0);
    const paint = (vertex: number, color: number) => {
        colors[vertex * 3] = ((color >> 16) & 255) / 255;
        colors[vertex * 3 + 1] = ((color >> 8) & 255) / 255;
        colors[vertex * 3 + 2] = (color & 255) / 255;
    };
    for (let v = 0; v < faces.position.length / 3; v++) paint(v, KEPT_FACE_COLOR);
    let changed = 0;
    for (const range of faces.range) {
        const face = range.shape as unknown as IFace;
        if (face.shapeType !== ShapeTypes.face || known.has(signature(face, unit))) continue;
        changed++;
        for (let k = range.start; k < range.start + range.count; k++)
            paint(faces.index[k], CHANGED_FACE_COLOR);
    }
    return changed > 0 ? colors : undefined;
}

/**
 * Only the faces `after` gains — a chamfer's bevel, a fillet's round, a hole's wall — as one
 * orange mesh, drawn over the part so it shows even where it is cut into the solid. A face that
 * differs from every face of `before` but still lies on one of their surfaces was only trimmed
 * (the faces next to a chamfer) and stays out.
 */
export function changedFacesMesh(
    before: IShape,
    after: IShape,
    faces: FaceMeshData,
): FaceMeshData | undefined {
    const size = sizeOf(after);
    const unit = size * 1e-4;
    const tolerance = size * 1e-5 + 1e-6;
    const originals = before.findSubShapes(ShapeTypes.face) as IFace[];
    const known = new Set<string>();
    for (const face of originals) known.add(signature(face, unit));
    const index: number[] = [];
    const surfaces = new Map<IFace, ReturnType<IFace["surface"]>>();
    try {
        for (const range of faces.range) {
            const face = range.shape as unknown as IFace;
            if (face.shapeType !== ShapeTypes.face || range.count < 3 || known.has(signature(face, unit)))
                continue;
            // a point inside the face: its first triangle's centre
            const p = [0, 1, 2].map((j) => faces.index[range.start + j]);
            const at = new XYZ({
                x: (faces.position[p[0] * 3] + faces.position[p[1] * 3] + faces.position[p[2] * 3]) / 3,
                y:
                    (faces.position[p[0] * 3 + 1] +
                        faces.position[p[1] * 3 + 1] +
                        faces.position[p[2] * 3 + 1]) /
                    3,
                z:
                    (faces.position[p[0] * 3 + 2] +
                        faces.position[p[1] * 3 + 2] +
                        faces.position[p[2] * 3 + 2]) /
                    3,
            });
            const trimmed = originals.some((original) => {
                let surface = surfaces.get(original);
                if (surface === undefined) {
                    surface = original.surface();
                    surfaces.set(original, surface);
                }
                const nearest = surface.nearestPoint(at);
                return nearest !== undefined && nearest[1] <= tolerance * 10;
            });
            if (trimmed) continue;
            for (let k = range.start; k < range.start + range.count; k++) index.push(faces.index[k]);
        }
    } finally {
        for (const surface of surfaces.values()) surface.dispose();
    }
    if (index.length === 0) return undefined;
    return {
        position: faces.position,
        normal: faces.normal,
        uv: faces.uv,
        index: new Uint32Array(index),
        groups: [],
        range: [],
        color: CHANGED_FACE_COLOR,
    };
}
