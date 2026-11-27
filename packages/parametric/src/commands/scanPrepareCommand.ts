// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    command,
    I18n,
    type I18nKeys,
    type IApplication,
    type ICommand,
    type IDocument,
    type INodeLinkedList,
    Mesh,
    MeshNode,
    PubSub,
    type ShapeNode,
    Transaction,
} from "@chili3d/core";
import { vertexRings } from "../scanTools/noise";
import { prepareScan, type ScanPrepOptions, type ScanPrepReport, weldSoup } from "../scanTools/scanPrep";
import type { TriMesh } from "../stlRebuild/mesh";
import { pickMeshSources, worldTriangles } from "./scanCommon";

/** The dialog's last values, for the next run (this session). */
let last: ScanPrepOptions = { targetTriangles: 200_000, smoothing: 2, maxHoleEdges: 100 };

/** A cleaned mesh as a display `Mesh`: indexed, with smooth vertex normals (a scan reads as a surface). */
export function displayMeshOf(mesh: TriMesh): Mesh {
    const { normals } = vertexRings(mesh);
    return new Mesh({
        meshType: "surface",
        position: Float32Array.from(mesh.positions),
        normal: Float32Array.from(normals),
        index: Uint32Array.from(mesh.triangles),
        color: 0x808080,
    });
}

/**
 * The cleaned copy beside the source, the source hidden — one undo step. The copy is a mesh
 * node, as a large STL imports: every scan tool reads it.
 */
export function addPreparedMesh(document: IDocument, source: MeshNode | ShapeNode, mesh: TriMesh): MeshNode {
    const node = new MeshNode({
        document,
        name: I18n.translate("scan.prepare.name{0}", source.name),
        mesh: displayMeshOf(mesh),
        materialId: source instanceof MeshNode ? source.materialId : undefined,
    });
    Transaction.execute(document, "scan.prepare", () => {
        const parent = source.parent as INodeLinkedList | undefined;
        if (parent !== undefined) parent.insertAfter(source, node);
        else document.modelManager.addNode(node);
        source.visible = false;
    });
    document.visual.update();
    return node;
}

function numberField(label: I18nKeys, value: number): { row: HTMLElement; read: () => number | undefined } {
    const row = document.createElement("label");
    Object.assign(row.style, {
        display: "flex",
        justifyContent: "space-between",
        gap: "12px",
        margin: "4px 0",
    });
    const text = document.createElement("span");
    text.textContent = I18n.translate(label);
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.value = String(value);
    input.style.width = "110px";
    row.append(text, input);
    return {
        row,
        read: () => {
            const v = Number(input.value);
            return Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
        },
    };
}

/** Asks for the clean-up's numbers; undefined when cancelled. */
function askOptions(triangles: number): Promise<ScanPrepOptions | undefined> {
    return new Promise((resolve) => {
        const content = document.createElement("div");
        const info = document.createElement("div");
        info.textContent = I18n.translate("scan.prepare.info{0}", triangles.toLocaleString("ru-RU"));
        info.style.marginBottom = "8px";
        const target = numberField("scan.prepare.target", Math.min(last.targetTriangles, triangles));
        const smoothing = numberField("scan.prepare.smoothing", last.smoothing);
        const holes = numberField("scan.prepare.holes", last.maxHoleEdges);
        content.append(info, target.row, smoothing.row, holes.row);
        PubSub.default.pub("showDialog", "command.scan.prepare", content, [
            {
                content: "common.confirm",
                shouldClose: () => [target, smoothing, holes].every((f) => f.read() !== undefined),
                onclick: () => {
                    last = {
                        targetTriangles: target.read()!,
                        smoothing: Math.min(smoothing.read()!, 20),
                        maxHoleEdges: holes.read()!,
                    };
                    resolve(last);
                },
            },
            { content: "common.cancel", onclick: () => resolve(undefined) },
        ]);
    });
}

function reportToast(report: ScanPrepReport) {
    PubSub.default.pub(
        "showToast",
        "toast.scan.prepare{0}{1}{2}{3}{4}{5}",
        report.trianglesBefore.toLocaleString("ru-RU"),
        report.trianglesAfter.toLocaleString("ru-RU"),
        report.holesFilled,
        report.holesLeft,
        report.noiseBefore.toFixed(3),
        report.noiseAfter.toFixed(3),
    );
}

/**
 * «Подготовка скана»: a 3D scanner's or photogrammetry's mesh made fit to measure and fit —
 * welded, small holes filled, lightly smoothed (Taubin: no shrinking), decimated to a target
 * count (`prepareScan`). The result is a new mesh beside the source, which is hidden; the
 * toast says how many triangles, holes and how much noise before and after.
 */
@command({
    key: "scan.prepare",
    icon: "icon-simplify",
    isEnabled: () => Config.instance.scanPrepare,
})
export class ScanPrepareCommand implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (document === undefined) return;
        const sources = await pickMeshSources(document);
        if (sources === undefined) return;
        const source = sources[0];
        const soup = worldTriangles(source);
        const options = await askOptions(soup.length / 9);
        if (options === undefined) return;
        PubSub.default.pub(
            "showPermanent",
            async () => {
                // let the message paint before the clean-up holds the thread
                await new Promise((resolve) => setTimeout(resolve, 50));
                const { mesh, report } = prepareScan(weldSoup(soup), options);
                addPreparedMesh(document, source, mesh);
                reportToast(report);
            },
            "toast.scan.prepare.running",
        );
    }
}
