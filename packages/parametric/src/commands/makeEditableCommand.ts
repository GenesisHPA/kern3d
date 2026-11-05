// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    command,
    EditableShapeNode,
    type IApplication,
    type ICommand,
    type IDocument,
    Id,
    type INode,
    PubSub,
    type ShapeType,
    ShapeTypes,
    Transaction,
} from "@chili3d/core";
import type { ImportedFeatureData } from "../features/feature";
import { ParametricBodyNode } from "../parametricBodyNode";
import { meshToSolid } from "./meshToSolid";

/** The shapes a body can grow from: solids and the shells and faces an IGES file brings. */
const EDITABLE_TYPES = new Set<ShapeType>([
    ShapeTypes.solid,
    ShapeTypes.compoundSolid,
    ShapeTypes.compound,
    ShapeTypes.shell,
    ShapeTypes.face,
]);

function hasSolid(node: EditableShapeNode): boolean {
    return node.shape.isOk && node.shape.value.findSubShapes(ShapeTypes.solid).length > 0;
}

export function isImportedBody(node: INode): node is EditableShapeNode {
    return (
        node instanceof EditableShapeNode && node.shape.isOk && EDITABLE_TYPES.has(node.shape.value.shapeType)
    );
}

/**
 * A parametric body standing in for an imported one: its shape (with the node's placement
 * baked in — a body keeps identity and moves by features) as the first feature, the name and
 * material kept. Undefined when the shape cannot be written out.
 */
export function editableBodyOf(node: EditableShapeNode): ParametricBodyNode | undefined {
    if (!node.shape.isOk) return undefined;
    // composed with the shape's own placement — a STEP part carries its position in its
    // location, and `transformed` would replace it rather than add to it
    const placed = node.shape.value.transformedMul(node.transform);
    const brep = shapeConverter.convertToBrep(placed);
    placed.dispose();
    if (!brep.isOk) return undefined;
    const feature: ImportedFeatureData = { id: Id.generate(), type: "imported", brep: brep.value };
    const body = new ParametricBodyNode({ document: node.document, features: [feature] });
    body.name = node.name;
    body.materialId = node.materialId;
    return body;
}

/**
 * Replaces each imported body under `nodes` (searched through folders and groups) with an
 * editable one in the same place of the tree. Call inside a transaction; returns how many.
 */
export function makeEditable(nodes: readonly INode[]): number {
    let count = 0;
    const visit = (node: INode) => {
        if (isImportedBody(node)) {
            let body: ParametricBodyNode | undefined;
            try {
                body = editableBodyOf(node);
            } catch {
                body = undefined; // left as it was imported: still shown, just not editable
            }
            const parent = node.parent;
            if (body === undefined || parent === undefined) return;
            parent.insertAfter(node, body);
            parent.remove(node);
            count++;
            return;
        }
        let child = (node as { firstChild?: INode }).firstChild;
        while (child !== undefined) {
            const next = child.nextSibling;
            visit(child);
            child = next;
        }
    };
    nodes.forEach(visit);
    return count;
}

/**
 * "Сделать редактируемым": imported bodies (STEP, IGES, BREP) become parametric ones whose
 * history starts with the imported shape — holes, cuts, fillets and joins then apply to them
 * like to any modelled body. New imports are converted on the way in; this is for bodies
 * imported before, or kept as they were.
 */
@command({ key: "modify.makeEditable", icon: "icon-edit" })
export class MakeEditableCommand implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (document === undefined) return;
        let nodes = document.selection.getSelectedNodes().filter(isImportedBody) as INode[];
        if (nodes.length === 0) {
            const picked = await pickImported(document);
            nodes = picked;
        }
        if (nodes.length === 0) return;
        let count = 0;
        Transaction.execute(document, "modify.makeEditable", () => {
            // triangles only (an STL imported before): made a solid with real faces first
            solidifyMeshes(nodes.filter((n) => n instanceof EditableShapeNode && !hasSolid(n)));
            count = makeEditable(nodes);
        });
        document.visual.update();
        PubSub.default.pub("showToast", "toast.makeEditable{0}", count);
    }
}

async function pickImported(document: IDocument): Promise<INode[]> {
    const controller = new AsyncController();
    const picked = await document.picker.pickNode("prompt.select.models", controller, {
        multi: true,
        nodeFilter: { allow: isImportedBody },
    });
    return picked.filter(isImportedBody);
}

/**
 * The imported bodies under `nodes` that are an STL's triangles, rebuilt as solids with merged
 * planar faces (see `meshToSolid`); a body that will not sew stays as it was.
 */
export function solidifyMeshes(nodes: readonly INode[]): void {
    const visit = (node: INode) => {
        if (node instanceof EditableShapeNode && node.shape.isOk) {
            try {
                const solid = meshToSolid(node.shape.value);
                if (solid.isOk) node.shape = solid;
            } catch {
                // left as triangles
            }
            return;
        }
        let child = (node as { firstChild?: INode }).firstChild;
        while (child !== undefined) {
            const next = child.nextSibling;
            visit(child);
            child = next;
        }
    };
    nodes.forEach(visit);
}
