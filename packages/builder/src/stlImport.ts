// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    EditableShapeNode,
    GroupNode,
    I18n,
    type IDocument,
    type INode,
    Material,
    type Mesh,
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
 * Past this many triangles an STL is imported as a mesh straight away. Measured on a user's two
 * files of 124 300 and 134 302 triangles: the sewing alone took 3-6 minutes (the app frozen),
 * the merge of coplanar facets failed the checker, and meshing the ~124 000-face faceted solid
 * left for display trapped OCCT ("memory access out of bounds") every time — a solid that size
 * cannot even be shown, so the conversion is not attempted.
 */
export const STL_SOLID_TRIANGLE_LIMIT = 100_000;

/**
 * An STL file as a document node: a group (named after the file) holding the part.
 *
 * The triangles are made a solid (`meshToSolid`: sewing, planar faces merged, cylinders
 * recovered) in a SANDBOX kernel of their own (`runInSandboxKernel`), never in the shared one.
 * That conversion is the heaviest thing the app asks of OCCT, and a trap inside it ("memory
 * access out of bounds") used to leave the shared kernel's heap broken, so that every import
 * after it failed too, with a different error each time, until the app was restarted. In the
 * sandbox a crash is the sandbox's loss: it is thrown away, and the part comes in as a plain mesh
 * (`stlToMesh`, no kernel involved) with a message saying why, instead of not at all.
 */
export async function importStlNode(
    document: IDocument,
    fileName: string,
    data: Uint8Array,
): Promise<Result<INode>> {
    const name = fileName.replace(/\.stl$/i, "");
    const mesh = stlToMesh(data);
    const triangles = (mesh?.position?.length ?? 0) / 9;
    const materialId = grayMaterial(document);
    const asMesh = (m: Mesh) =>
        Result.ok<INode>(group(document, fileName, [new MeshNode({ document, name, mesh: m, materialId })]));
    if (mesh !== undefined && triangles > STL_SOLID_TRIANGLE_LIMIT) {
        PubSub.default.pub("showToast", "toast.import.stlTooLarge{0}", triangles);
        return asMesh(mesh);
    }
    const converted = await convertInSandbox(data);
    if (converted.ok) {
        const bodies = solidBodies(document, name, converted.value, materialId);
        if (bodies !== undefined) return Result.ok(group(document, fileName, bodies));
    }
    if (mesh === undefined) return Result.err(I18n.translate("error.kernel.canNotConvert"));
    PubSub.default.pub(
        "showToast",
        !converted.ok && converted.crashed ? "toast.import.stlKernelCrash" : "toast.import.stlAsMesh",
    );
    return asMesh(mesh);
}

/**
 * The converted part read into the shared kernel, as bodies: separate parts of one file
 * (`solidsOfShells` keeps them apart) become separate bodies — one body of several solids is one
 * nothing downstream can edit as a part. Undefined when the BREP does not read back.
 */
function solidBodies(
    document: IDocument,
    name: string,
    converted: ConvertedStl,
    materialId: string,
): INode[] | undefined {
    const shape = shapeConverter.convertFromBrep(converted.brep);
    if (!shape.isOk) return undefined;
    if (converted.faces > RECOVER_ON_IMPORT_FACES)
        PubSub.default.pub("showToast", "toast.import.facetedLarge");
    const parts =
        shape.value.shapeType === ShapeTypes.compound ? shape.value.findSubShapes(ShapeTypes.solid) : [];
    if (parts.length <= 1) return [new EditableShapeNode({ document, name, shape: shape.value, materialId })];
    PubSub.default.pub("showToast", "toast.import.stlSplit{0}", parts.length);
    return parts.map(
        (part, i) => new EditableShapeNode({ document, name: `${name} (${i + 1})`, shape: part, materialId }),
    );
}

export type Converted = { ok: true; value: ConvertedStl } | { ok: false; crashed: boolean; error: string };

/** The STL made a solid in a sandbox kernel and checked to read back and mesh there (exported for tests). */
export async function convertInSandbox(data: Uint8Array): Promise<Converted> {
    const kernel = await import("@chili3d/wasm");
    const run = await kernel.runInSandboxKernel(() => {
        const triangles = kernel.stlToShape(data);
        if (!triangles.isOk) throw new Error(triangles.error);
        const solid = meshToSolid(triangles.value);
        if (!solid.isOk) throw new Error(solid.error);
        const brep = shapeConverter.convertToBrep(solid.value);
        if (!brep.isOk) throw new Error(brep.error);
        // What the shared kernel will do with it next — read it back and mesh it for display —
        // done here first: meshing is where OCCT traps on huge faceted parts (measured: the
        // 124 300-triangle STL's solid, "memory access out of bounds"; its raw triangles, "null
        // function or function signature mismatch"), and a trap here costs the sandbox only.
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
