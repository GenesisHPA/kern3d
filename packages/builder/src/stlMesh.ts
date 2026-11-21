// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Mesh } from "@chili3d/core";

/**
 * An STL's triangles as a display mesh, read in plain JavaScript — no kernel involved. This is
 * what an import falls back to when turning the triangles into a solid fails (or crashes the
 * kernel it ran in): the part still arrives, as a mesh body the user can see, measure and export,
 * instead of nothing. Undefined when the bytes are neither a binary nor an ASCII STL.
 */
export function stlToMesh(data: Uint8Array): Mesh | undefined {
    const positions = isBinaryStl(data) ? readBinary(data) : readAscii(data);
    if (positions === undefined || positions.length === 0) return undefined;
    const count = positions.length / 3;
    const mesh = new Mesh({
        meshType: "surface",
        position: positions,
        normal: facetNormals(positions),
        index: Uint32Array.from({ length: count }, (_, i) => i),
        color: 0x808080,
    });
    return mesh;
}

/** A binary STL is exactly 84 bytes of header and count plus 50 per triangle. */
function isBinaryStl(data: Uint8Array): boolean {
    if (data.byteLength < 84) return false;
    const count = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(80, true);
    return data.byteLength === 84 + count * 50;
}

function readBinary(data: Uint8Array): Float32Array {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = view.getUint32(80, true);
    const positions = new Float32Array(count * 9);
    for (let t = 0; t < count; t++) {
        const base = 84 + t * 50 + 12; // past the stored normal, recomputed from the corners
        for (let k = 0; k < 9; k++) positions[t * 9 + k] = view.getFloat32(base + k * 4, true);
    }
    return positions;
}

function readAscii(data: Uint8Array): Float32Array | undefined {
    const text = new TextDecoder().decode(data);
    if (!/^\s*solid/i.test(text)) return undefined;
    const values: number[] = [];
    for (const match of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi)) {
        values.push(Number(match[1]), Number(match[2]), Number(match[3]));
    }
    if (values.length % 9 !== 0 || values.some((v) => !Number.isFinite(v))) return undefined;
    return Float32Array.from(values);
}

/** One normal per triangle, repeated on its three corners: a faceted part shows its facets. */
function facetNormals(p: Float32Array): Float32Array {
    const normals = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 9) {
        const ux = p[i + 3] - p[i];
        const uy = p[i + 4] - p[i + 1];
        const uz = p[i + 5] - p[i + 2];
        const vx = p[i + 6] - p[i];
        const vy = p[i + 7] - p[i + 1];
        const vz = p[i + 8] - p[i + 2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz) || 1;
        nx /= length;
        ny /= length;
        nz /= length;
        for (let k = 0; k < 9; k += 3) {
            normals[i + k] = nx;
            normals[i + k + 1] = ny;
            normals[i + k + 2] = nz;
        }
    }
    return normals;
}
