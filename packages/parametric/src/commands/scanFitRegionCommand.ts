// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    Config,
    command,
    type DialogButton,
    type FaceMeshData,
    I18n,
    type I18nKeys,
    type IDocument,
    type IEventHandler,
    type IView,
    Plane,
    PubSub,
    Transaction,
    XYZ,
} from "@chili3d/core";
import { AxisNode } from "../datum/axisNode";
import { DatumPointNode } from "../datum/datumPointNode";
import { ParametricBodyNode } from "../parametricBodyNode";
import { ensurePlaneMaterial, PlaneNode } from "../plane/planeNode";
import { type FittedPrimitive, fitRegionAt, type RegionFit, rayHit } from "../scanTools/fitRegion";
import { scanTolerance } from "../scanTools/noise";
import { emptySketchData } from "../sketch/sketchModel";
import { SketchNode } from "../sketch/sketchNode";
import { sketchDataOf } from "../stlRebuild/build";
import { anyPerpendicular, normalOf, type TriMesh, type Vec3 } from "../stlRebuild/mesh";
import { pickMeshSources, worldMesh } from "./scanCommon";

const xyz = (v: Vec3) => new XYZ({ x: v[0], y: v[1], z: v[2] });
const fmt = (v: number, digits = 3) => (Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v).toFixed(digits);
const vec = (v: Vec3) => `(${v.map((x) => fmt(x, 4)).join("; ")})`;
const pt = (v: Vec3) => `(${v.map((x) => fmt(x, 3)).join("; ")})`;
const along = (p: Vec3, a: Vec3, t: number): Vec3 => [p[0] + a[0] * t, p[1] + a[1] * t, p[2] + a[2] * t];

/** A click on the viewport (not a drag: the camera turns on a drag), as a ray. */
class MeshClickHandler implements IEventHandler {
    isEnabled = true;
    ray: { origin: Vec3; direction: Vec3 } | undefined;
    #down: { x: number; y: number } | undefined;

    constructor(private readonly controller: AsyncController) {}

    pointerMove(): void {}
    pointerDown(_view: IView, event: PointerEvent): void {
        if (event.button === 0) this.#down = { x: event.offsetX, y: event.offsetY };
    }
    pointerUp(view: IView, event: PointerEvent): void {
        const down = this.#down;
        this.#down = undefined;
        if (event.button !== 0 || down === undefined) return;
        if (Math.hypot(event.offsetX - down.x, event.offsetY - down.y) > 4) return;
        const ray = view.rayAt(event.offsetX, event.offsetY);
        this.ray = {
            origin: [ray.point.x, ray.point.y, ray.point.z],
            direction: [ray.direction.x, ray.direction.y, ray.direction.z],
        };
        this.controller.success();
    }
    keyDown(_view: IView, event: KeyboardEvent): void {
        if (event.key === "Escape") this.controller.cancel();
    }
    dispose(): void {}
}

/** The fit in words, one line per fact (the dialog's text). */
export function describeFit(fit: RegionFit, tol: number): string[] {
    const p = fit.primitive;
    const lines: string[] = [];
    switch (p.kind) {
        case "plane":
            lines.push(I18n.translate("scan.fit.plane{0}{1}", vec(p.normal), fmt(p.d)));
            break;
        case "cylinder":
            lines.push(
                I18n.translate(
                    fit.concave ? "scan.fit.hole{0}{1}{2}{3}" : "scan.fit.cylinder{0}{1}{2}{3}",
                    fmt(p.radius * 2),
                    vec(p.axis),
                    pt(along(p.point, p.axis, fit.span?.min ?? 0)),
                    fmt((fit.span?.max ?? 0) - (fit.span?.min ?? 0)),
                ),
            );
            break;
        case "cone":
            lines.push(
                I18n.translate(
                    "scan.fit.cone{0}{1}{2}",
                    fmt((p.angle * 360) / Math.PI, 2),
                    vec(p.axis),
                    pt(p.apex),
                ),
            );
            break;
        case "sphere":
            lines.push(I18n.translate("scan.fit.sphere{0}{1}", fmt(p.radius * 2), pt(p.center)));
            break;
        case "torus":
            lines.push(I18n.translate("scan.fit.torus{0}{1}{2}", fmt(p.major), fmt(p.minor), pt(p.center)));
            break;
    }
    lines.push(
        I18n.translate(
            "scan.fit.quality{0}{1}{2}{3}{4}",
            fmt(fit.rms, 4),
            fmt(fit.max, 4),
            fmt(fit.area, 1),
            fit.triangles.length,
            fmt(tol, 4),
        ),
    );
    return lines;
}

/** The region's triangles as a translucent overlay, lifted a hair off the mesh along their normals. */
function regionOverlay(mesh: TriMesh, fit: RegionFit): FaceMeshData {
    const n = fit.triangles.length;
    const position = new Float32Array(n * 9);
    const normal = new Float32Array(n * 9);
    const lift = Math.max(mesh.size * 2e-4, 1e-4);
    fit.triangles.forEach((k, i) => {
        const nk = normalOf(mesh, k);
        for (let e = 0; e < 3; e++) {
            const v = mesh.triangles[3 * k + e];
            for (let c = 0; c < 3; c++) {
                position[9 * i + 3 * e + c] = mesh.positions[3 * v + c] + nk[c] * lift;
                normal[9 * i + 3 * e + c] = nk[c];
            }
        }
    });
    return {
        position,
        normal,
        index: Uint32Array.from({ length: n * 3 }, (_, i) => i),
        uv: new Float32Array(n * 6),
        groups: [],
        range: [],
        color: 0xff8c1a,
    };
}

/** A plane square to `normal` through `origin`, its x any perpendicular. */
function planeAt(origin: Vec3, normal: Vec3): Plane {
    return new Plane({ origin: xyz(origin), normal: xyz(normal), xvec: xyz(anyPerpendicular(normal)) });
}

type Action = { content: I18nKeys; run: (document: IDocument) => void };

/** The sketch plane of a fitted plane: through the region's centre, facing out of the material. */
function sketchPlaneOf(fit: RegionFit, p: Extract<FittedPrimitive, { kind: "plane" }>): Plane {
    const s =
        p.normal[0] * fit.outward[0] + p.normal[1] * fit.outward[1] + p.normal[2] * fit.outward[2] < 0
            ? -1
            : 1;
    const normal: Vec3 = [p.normal[0] * s, p.normal[1] * s, p.normal[2] * s];
    const off =
        p.normal[0] * fit.centroid[0] + p.normal[1] * fit.centroid[1] + p.normal[2] * fit.centroid[2] - p.d;
    return planeAt(along(fit.centroid, p.normal, -off), normal);
}

function addSketch(document: IDocument, plane: Plane, name: string, circle?: number): SketchNode {
    const data =
        circle === undefined
            ? emptySketchData()
            : sketchDataOf(plane, [{ kind: "circle", c: [0, 0], r: circle, ccw: true }], 1e-3);
    const sketch = new SketchNode({ document, plane, data });
    sketch.name = name;
    document.modelManager.addNode(sketch);
    return sketch;
}

function addAxis(document: IDocument, point: Vec3, direction: Vec3, span?: { min: number; max: number }) {
    const node = new AxisNode({
        document,
        definition: {
            kind: "fixed",
            point: { x: point[0], y: point[1], z: point[2] },
            direction: { x: direction[0], y: direction[1], z: direction[2] },
            span,
        },
    });
    document.modelManager.addNode(node);
    return node;
}

function addPoint(document: IDocument, point: Vec3) {
    const node = new DatumPointNode({
        document,
        definition: { kind: "fixed", point: { x: point[0], y: point[1], z: point[2] } },
    });
    document.modelManager.addNode(node);
    return node;
}

/** A body: the circle of the cylinder's Ø extruded over the region's length (a boss, a shaft). */
function addBoss(
    document: IDocument,
    p: Extract<FittedPrimitive, { kind: "cylinder" }>,
    span: { min: number; max: number },
) {
    const plane = planeAt(along(p.point, p.axis, span.min), p.axis);
    const sketch = addSketch(
        document,
        plane,
        I18n.translate("scan.fit.bossSketch{0}", fmt(p.radius * 2, 2)),
        p.radius,
    );
    sketch.visible = false;
    const body = new ParametricBodyNode({
        document,
        features: [
            {
                id: "scan-boss",
                type: "extrude",
                sketchId: sketch.id,
                depth: Number.parseFloat((span.max - span.min).toFixed(6)),
            } as never,
        ],
    });
    body.name = I18n.translate("scan.fit.bossBody{0}", fmt(p.radius * 2, 2));
    document.modelManager.addNode(body);
    return body;
}

/** What can be made of the fit, by kind. */
export function actionsFor(fit: RegionFit): Action[] {
    const p = fit.primitive;
    const actions: Action[] = [];
    if (p.kind === "plane") {
        const plane = sketchPlaneOf(fit, p);
        const origin: Vec3 = [plane.origin.x, plane.origin.y, plane.origin.z];
        const normal: Vec3 = [plane.normal.x, plane.normal.y, plane.normal.z];
        actions.push(
            {
                content: "scan.fit.action.sketch",
                run: (d) => addSketch(d, plane, I18n.translate("scan.fit.sketchName")),
            },
            {
                content: "scan.fit.action.plane",
                run: (d) => {
                    const node = new PlaneNode({
                        document: d,
                        definition: {
                            kind: "fixed",
                            origin: { x: origin[0], y: origin[1], z: origin[2] },
                            normal: { x: normal[0], y: normal[1], z: normal[2] },
                            anchor: { x: origin[0], y: origin[1], z: origin[2] },
                        },
                        plane,
                        materialId: ensurePlaneMaterial(d).id,
                    });
                    d.modelManager.addNode(node);
                },
            },
            { content: "scan.fit.action.point", run: (d) => addPoint(d, origin) },
        );
    } else if (p.kind === "cylinder" || p.kind === "cone") {
        const base = p.kind === "cylinder" ? p.point : p.apex;
        const span = fit.span ?? { min: 0, max: 0 };
        actions.push({ content: "scan.fit.action.axis", run: (d) => addAxis(d, base, p.axis, span) });
        const middle = along(base, p.axis, (span.min + span.max) / 2);
        actions.push({
            content: p.kind === "cone" ? "scan.fit.action.apex" : "scan.fit.action.point",
            run: (d) => addPoint(d, p.kind === "cone" ? p.apex : middle),
        });
        if (p.kind === "cylinder" && fit.concave) {
            actions.push({
                content: "scan.fit.action.holeSketch",
                run: (d) =>
                    addSketch(
                        d,
                        planeAt(along(p.point, p.axis, span.max), p.axis),
                        I18n.translate("scan.fit.holeSketch{0}", fmt(p.radius * 2, 2)),
                        p.radius,
                    ),
            });
        } else if (p.kind === "cylinder") {
            actions.push({ content: "scan.fit.action.boss", run: (d) => addBoss(d, p, span) });
        }
    } else if (p.kind === "sphere") {
        actions.push({ content: "scan.fit.action.center", run: (d) => addPoint(d, p.center) });
    } else if (p.kind === "torus") {
        actions.push(
            { content: "scan.fit.action.axis", run: (d) => addAxis(d, p.center, p.axis) },
            { content: "scan.fit.action.center", run: (d) => addPoint(d, p.center) },
        );
    }
    return actions;
}

/**
 * «Подогнать по области»: a click on a mesh (a scan, an STL) picks the smooth region there; it is
 * fitted to a plane, cylinder, cone, sphere or torus (`fitRegionAt`; the tolerance from the mesh's
 * noise, RANSAC for the plane), shown in orange, and its numbers listed — the plane's normal and
 * offset, the cylinder's axis and Ø, the cone's angle, the sphere's Ø — with what can be made of
 * it: a sketch on the plane, a datum plane, axis or point, a hole's sketch or a boss of that Ø.
 */
@command({
    key: "scan.fitRegion",
    icon: "icon-cylinder",
    isEnabled: () => Config.instance.scanFitRegion,
})
export class ScanFitRegionCommand extends CancelableCommand {
    protected async executeAsync(): Promise<void> {
        const document = this.document;
        const sources = await pickMeshSources(document);
        if (sources === undefined || this.checkCanceled()) return;
        const mesh = worldMesh(sources[0]);
        document.selection.clearSelection();
        this.controller = new AsyncController();
        const handler = new MeshClickHandler(this.controller);
        await document.picker.pickAsync(
            handler,
            "prompt.scan.fitRegion",
            this.controller,
            "none",
            "select.default",
        );
        const ray = handler.ray;
        if (ray === undefined || this.checkCanceled()) return;
        const hit = rayHit(mesh, ray.origin, ray.direction);
        if (hit === undefined) {
            PubSub.default.pub("showToast", "toast.scan.fit.miss");
            return;
        }
        const tol = scanTolerance(mesh);
        const fit = fitRegionAt(mesh, hit.triangle, tol);
        if (fit === undefined) {
            PubSub.default.pub("showToast", "toast.scan.fit.none");
            return;
        }
        showFitDialog(document, mesh, fit, tol);
    }
}

function showFitDialog(document: IDocument, mesh: TriMesh, fit: RegionFit, tol: number) {
    const overlay = document.visual.context.displayMesh([regionOverlay(mesh, fit)], { meshOpacity: 0.65 });
    document.visual.update();
    const close = () => {
        document.visual.context.removeMesh(overlay);
        document.visual.update();
    };
    const content = globalThis.document.createElement("div");
    content.style.whiteSpace = "pre-line";
    content.style.maxWidth = "520px";
    content.textContent = describeFit(fit, tol).join("\n");
    const buttons: DialogButton[] = actionsFor(fit).map((action) => ({
        content: action.content,
        onclick: () => {
            close();
            Transaction.execute(document, "scan.fitRegion", () => action.run(document));
            document.visual.update();
        },
    }));
    buttons.push({ content: "common.cancel", onclick: close });
    PubSub.default.pub("showDialog", "command.scan.fitRegion", content, buttons);
}
