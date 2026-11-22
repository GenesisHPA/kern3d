// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The triangles a body was imported from, by node id, for this session: an STL's own mesh is
 * closed and exact, while the display mesh the kernel makes of the solid built from it can lose
 * faces — and a rebuild reads the part off its triangles. Not saved with the document; after a
 * reload the rebuild falls back to the display mesh. The last few imports only.
 */
const sources = new Map<string, Float64Array>();
const KEEP = 8;

export function rememberSourceTriangles(nodeId: string, triangles: Float64Array): void {
    sources.delete(nodeId);
    sources.set(nodeId, triangles);
    while (sources.size > KEEP) sources.delete(sources.keys().next().value!);
}

export function sourceTriangles(nodeId: string): Float64Array | undefined {
    return sources.get(nodeId);
}

/** Moves a remembered mesh to the node that replaced the one it was imported as. */
export function moveSourceTriangles(fromId: string, toId: string): void {
    const triangles = sources.get(fromId);
    if (triangles === undefined) return;
    sources.delete(fromId);
    rememberSourceTriangles(toId, triangles);
}
