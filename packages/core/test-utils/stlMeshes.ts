// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** One triangle as its nine corner coordinates. */
export type StlTriangle = readonly number[];

/**
 * Triangles as a binary STL (normals left zero: readers recompute them from the winding).
 *
 * The header is filled with 0xFF: OCCT tells a binary STL from an ASCII one by looking for bytes
 * above 127, and a small part on round coordinates (10.0f is 00 00 20 41) has none, so it would
 * be read as text and fail ("premature end of file").
 */
export function binaryStl(triangles: readonly StlTriangle[]): Uint8Array {
    const bytes = new Uint8Array(84 + triangles.length * 50);
    bytes.fill(0xff, 0, 80);
    const view = new DataView(bytes.buffer);
    view.setUint32(80, triangles.length, true);
    triangles.forEach((t, i) => {
        for (let k = 0; k < 9; k++) view.setFloat32(84 + i * 50 + 12 + k * 4, t[k], true);
    });
    return bytes;
}

/**
 * The 12 triangles of an axis-aligned box, wound counter-clockwise seen from outside — a part's
 * skin; `inward` reverses them, which is how an STL writes the skin of a void inside a part.
 */
export function boxTriangles(
    min: readonly [number, number, number],
    max: readonly [number, number, number],
    inward = false,
): StlTriangle[] {
    const p = (i: number, j: number, k: number) => [
        i ? max[0] : min[0],
        j ? max[1] : min[1],
        k ? max[2] : min[2],
    ];
    const quads: number[][][] = [
        [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)], // -z
        [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)], // +z
        [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)], // -y
        [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)], // +y
        [p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)], // -x
        [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)], // +x
    ];
    const triangles = quads.flatMap(([a, b, c, d]) => [
        [...a, ...b, ...c],
        [...a, ...c, ...d],
    ]);
    return inward ? triangles.map((t) => [...t.slice(0, 3), ...t.slice(6, 9), ...t.slice(3, 6)]) : triangles;
}

/**
 * A closed, nearly flat tetrahedron at `at`: 0.05 mm across and 1e-4 mm high — the kind of sliver
 * bubble a sewing cuts off where an STL's surface pinches (four triangles on one edge).
 */
export function sliverTriangles(at: readonly [number, number, number]): StlTriangle[] {
    const [x, y, z] = at;
    const a = [x, y, z];
    const b = [x + 0.05, y, z];
    const c = [x, y + 0.05, z];
    const d = [x + 0.02, y + 0.02, z + 1e-4];
    return [
        [...a, ...c, ...b],
        [...a, ...b, ...d],
        [...b, ...c, ...d],
        [...c, ...a, ...d],
    ];
}
