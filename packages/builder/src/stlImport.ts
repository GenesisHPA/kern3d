// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    EditableShapeNode,
    GroupNode,
    type IDocument,
    type INode,
    Material,
    MeshNode,
    PubSub,
    Result,
    ShapeTypes,
} from "@chili3d/core";
import { meshToSolid, RECOVER_ON_IMPORT_FACES } from "@chili3d/parametric";
import { stlToMesh } from "./stlMesh";

/** What the sandbox hands back: the converted part as BREP text, and how many faces it has. */
interface ConvertedStl {
    brep: string;
    faces: number;
}

/**
 * An STL file as a document node: a group (named after the file) holding the part.
 *
 * The triangles are made a solid (`meshToSolid`: sewing, planar faces merged, cylinders
 * recovered) in a SANDBOX kernel of their own (`runInSandboxKernel`), never in the shared one.
 * That conversion is the heaviest thing the app asks of OCCT — a hundred thousand triangles sewn
 * and merged — and a trap inside it ("memory access out of bounds") used to leave the shared
 * kernel's heap broken, so that every import after it failed too, with a different error each
 * time, until the app was restarted. In the sandbox a crash is the sandbox's loss: it is thrown
 * away, and the part comes in as a plain mesh (`stlToMesh`, no kernel involved) with a message
 * saying why, instead of not at all.
 */
export async function importStlNode(
    document: IDocument,
    fileName: string,
    data: Uint8Array,
): Promise<Result<INode>> {
    const name = fileName.replace(/\.stl$/i, "");
    const materialId = grayMaterial(document);
    const converted = await convertInSandbox(data);
    if (converted.ok) {
        const shape = shapeConverter.convertFromBrep(converted.value.brep);
        if (shape.isOk) {
            if (converted.value.faces > RECOVER_ON_IMPORT_FACES)
                PubSub.default.pub("showToast", "toast.import.facetedLarge");
            // separate parts of one file (`solidsOfShells` keeps them apart) become separate
            // bodies: one body of several solids is one nothing downstream can edit as a part
            const parts =
                shape.value.shapeType === ShapeTypes.compound
                    ? shape.value.findSubShapes(ShapeTypes.solid)
                    : [];
            if (parts.length > 1) {
                PubSub.default.pub("showToast", "toast.import.stlSplit{0}", parts.length);
                const bodies = parts.map(
                    (part, i) =>
                        new EditableShapeNode({
                            document,
                            name: `${name} (${i + 1})`,
                            shape: part,
                            materialId,
                        }),
                );
                return Result.ok(group(document, fileName, bodies));
            }
            const body = new EditableShapeNode({ document, name, shape: shape.value, materialId });
            return Result.ok(group(document, fileName, [body]));
        }
    }
    const mesh = stlToMesh(data);
    if (mesh === undefined) return Result.err("can not convert");
    PubSub.default.pub(
        "showToast",
        !converted.ok && converted.crashed ? "toast.import.stlKernelCrash" : "toast.import.stlAsMesh",
    );
    return Result.ok(group(document, fileName, [new MeshNode({ document, name, mesh, materialId })]));
}

type Converted = { ok: true; value: ConvertedStl } | { ok: false; crashed: boolean; error: string };

async function convertInSandbox(data: Uint8Array): Promise<Converted> {
    const kernel = await import("@chili3d/wasm");
    const run = await kernel.runInSandboxKernel(() => {
        const triangles = kernel.stlToShape(data);
        if (!triangles.isOk) throw new Error(triangles.error);
        const solid = meshToSolid(triangles.value);
        if (!solid.isOk) throw new Error(solid.error);
        const brep = shapeConverter.convertToBrep(solid.value);
        if (!brep.isOk) throw new Error(brep.error);
        // What the shared kernel will do with it next — read it back and mesh it for display —
        // done here first: meshing is where OCCT traps on some huge faceted parts (measured: a
        // 124 300-triangle STL, "null function or function signature mismatch"), and a trap
        // here costs the sandbox, not the open documents.
        const back = shapeConverter.convertFromBrep(brep.value);
        if (!back.isOk) throw new Error(back.error);
        void back.value.mesh;
        return { brep: brep.value, faces: solid.value.findSubShapes(ShapeTypes.face).length };
    });
    return run.ok ? { ok: true, value: run.value } : run;
}

function group(document: IDocument, name: string, children: INode[]): GroupNode {
    const folder = new GroupNode({ document, name });
    for (const child of children) folder.add(child);
    return folder;
}

/** The plain grey an STL arrives in (it has no colours), shared by every STL import. */
function grayMaterial(document: IDocument): string {
    const color = "#808080";
    const existing = document.modelManager.materials.find((m) => m.name === color);
    if (existing !== undefined) return existing.id;
    const material = new Material({ document, name: color, color });
    document.modelManager.materials.push(material);
    return material.id;
}
