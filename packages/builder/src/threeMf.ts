// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** One printable object of a 3MF package: an indexed triangle mesh in millimetres. */
export interface ThreeMfObject {
    name: string;
    /** xyz triplets */
    position: ArrayLike<number>;
    /** Three vertex indices per triangle. */
    index: ArrayLike<number>;
}

/** A welded mesh: shared vertices, triangles referring to them, degenerate ones dropped. */
export interface WeldedMesh {
    vertices: number[];
    triangles: number[];
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

/** Vertices closer than this (mm) are one vertex — the kernel meshes every face separately. */
const WELD_TOLERANCE = 1e-4;

/**
 * Merges the coincident vertices a per-face triangulation leaves along every edge, so a
 * slicer receives a closed (manifold) mesh instead of a soup of separate face patches, and
 * drops the triangles welding collapses. When the mesh encloses negative volume the windings
 * are reversed: 3MF requires outward-facing counter-clockwise triangles.
 */
export function weldMesh(position: ArrayLike<number>, index: ArrayLike<number>): WeldedMesh {
    const vertices: number[] = [];
    const lookup = new Map<string, number>();
    const remap = new Uint32Array(position.length / 3);
    for (let i = 0; i < remap.length; i++) {
        const x = position[3 * i];
        const y = position[3 * i + 1];
        const z = position[3 * i + 2];
        const key = `${Math.round(x / WELD_TOLERANCE)},${Math.round(y / WELD_TOLERANCE)},${Math.round(z / WELD_TOLERANCE)}`;
        let id = lookup.get(key);
        if (id === undefined) {
            id = vertices.length / 3;
            lookup.set(key, id);
            vertices.push(x, y, z);
        }
        remap[i] = id;
    }
    const triangles: number[] = [];
    for (let t = 0; t + 2 < index.length; t += 3) {
        const a = remap[index[t]];
        const b = remap[index[t + 1]];
        const c = remap[index[t + 2]];
        if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
    }
    if (signedVolume(vertices, triangles) < 0) {
        for (let t = 0; t < triangles.length; t += 3) {
            [triangles[t + 1], triangles[t + 2]] = [triangles[t + 2], triangles[t + 1]];
        }
    }
    return { vertices, triangles };
}

function signedVolume(v: number[], tris: number[]) {
    let volume = 0;
    for (let t = 0; t < tris.length; t += 3) {
        const [a, b, c] = [3 * tris[t], 3 * tris[t + 1], 3 * tris[t + 2]];
        volume +=
            v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) -
            v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) +
            v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
    }
    return volume / 6;
}

function escapeXml(text: string) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function formatNumber(value: number) {
    // 6 decimals = 1 nm: far below any printer, and keeps the file free of float noise.
    const text = value.toFixed(6).replace(/\.?0+$/, "");
    return text === "-0" ? "0" : text;
}

function objectXml(id: number, name: string, mesh: WeldedMesh) {
    const parts: string[] = [`<object id="${id}" type="model" name="${escapeXml(name)}"><mesh><vertices>`];
    for (let i = 0; i < mesh.vertices.length; i += 3) {
        const [x, y, z] = [mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2]];
        parts.push(`<vertex x="${formatNumber(x)}" y="${formatNumber(y)}" z="${formatNumber(z)}"/>`);
    }
    parts.push("</vertices><triangles>");
    for (let t = 0; t < mesh.triangles.length; t += 3) {
        const [a, b, c] = [mesh.triangles[t], mesh.triangles[t + 1], mesh.triangles[t + 2]];
        parts.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    }
    parts.push("</triangles></mesh></object>");
    return parts.join("");
}

/** The 3D/3dmodel.model part: one object and one build item per input object. */
export function threeMfModelXml(objects: ThreeMfObject[]): string {
    const meshes = objects
        .map((object) => ({ name: object.name, mesh: weldMesh(object.position, object.index) }))
        .filter((x) => x.mesh.triangles.length > 0);
    const resources = meshes.map((x, i) => objectXml(i + 1, x.name, x.mesh)).join("\n");
    const items = meshes.map((_, i) => `<item objectid="${i + 1}"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Application">Chili3D</metadata>
<resources>
${resources}
</resources>
<build>${items}</build>
</model>`;
}

/** A 3MF core-spec package (OPC zip) holding the objects. */
export async function buildThreeMf(objects: ThreeMfObject[]): Promise<Uint8Array> {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("[Content_Types].xml", CONTENT_TYPES);
    zip.file("_rels/.rels", RELS);
    zip.file("3D/3dmodel.model", threeMfModelXml(objects));
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
