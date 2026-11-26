// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IEdge, type IShape, Plane, ShapeTypes, XYZ } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import * as wasmKernel from "@chili3d/wasm";
import { initWasm, OccShapeConverter, ShapeFactory } from "@chili3d/wasm";
import { SandboxTriangulator } from "../../builder/src/stlSafeMesh";
import { OccShape } from "../../wasm/src/shape";
import { meshToSolid } from "../src/commands/meshToSolid";
import { appendTreatment, buildModel, treatmentEdges } from "../src/stlRebuild/build";
import { fitProfile, profileArea } from "../src/stlRebuild/fit2d";
import { meshVolume, weldTriangles } from "../src/stlRebuild/mesh";
import { type EdgeTreatment, planExtrusions, setPlanDebug } from "../src/stlRebuild/plan";
import { meshDifference } from "../src/stlRebuild/raycast";
import { rebuildPart, setRebuildDebug } from "../src/stlRebuild/rebuild";
import { setSafeTriangulator } from "../src/stlRebuild/safeMesh";
import { describeSegment, segmentMesh } from "../src/stlRebuild/segment";
import { loopArea, slabsOf, sliceFrames } from "../src/stlRebuild/slices";
import { deviation, solidVolume, surfaceFit, trianglesOf } from "../src/stlRebuild/verify";
import "../src/features";
import "./sketch/setup";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/chili-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    for (const [name, value] of [
        ["shapeFactory", new ShapeFactory()],
        ["shapeConverter", new OccShapeConverter()],
    ] as const) {
        Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
    }
    // as in the app: bodies meshed in a kernel of their own (KERN3D_STL_INPLACE=1: in place)
    if (process.env["KERN3D_STL_INPLACE"] !== "1") setSafeTriangulator(new SandboxTriangulator(wasmKernel));
});

const at = (x: number, y: number, z: number) => new XYZ({ x, y, z });
const box = (x: number, y: number, z: number, dx: number, dy: number, dz: number) =>
    shapeFactory.box(new Plane({ origin: at(x, y, z), normal: XYZ.unitZ, xvec: XYZ.unitX }), dx, dy, dz)
        .value;
const cyl = (axis: XYZ, base: XYZ, r: number, h: number) => shapeFactory.cylinder(axis, base, r, h).value;
const cut = (a: IShape, ...b: IShape[]) => shapeFactory.booleanCut([a], b).value;
const fuse = (a: IShape, ...b: IShape[]) => shapeFactory.booleanFuse([a], b, true).value;

function stlBytes(shape: IShape): Uint8Array {
    return shapeConverter.convertToSTL([shape], { binary: true } as never).value as unknown as Uint8Array;
}

function fromStl(bytes: Uint8Array): IShape {
    const node = (globalThis as any).wasm.Converter.convertFromStl(bytes);
    return OccShape.wrap(node.shape);
}

function document() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

/** The part through STL and back, rebuilt; the report (KERN3D_STL_TRACE=1: the steps printed). */
function rebuild(part: IShape) {
    if (process.env["KERN3D_STL_TRACE"]) setRebuildDebug((line) => console.log(line));
    const stl = fromStl(stlBytes(part));
    const reference = meshToSolid(stl).value;
    const off = process.env["KERN3D_STL_OFF"] === "holes" ? (["holes"] as const) : [];
    return rebuildPart(document(), trianglesOf(stl), reference, "part", { off });
}

describe("STL rebuilt as features (real kernel)", () => {
    test("a plate with two through holes: one extrude and two hole cuts", async () => {
        const plate = cut(
            box(0, 0, 0, 60, 40, 8),
            cyl(XYZ.unitZ, at(15, 20, -1), 3, 10),
            cyl(XYZ.unitZ, at(45, 20, -1), 4, 10),
        );
        const report = await rebuild(plate);
        expect(report.error).toBeUndefined();
        expect(report.ratio).toBeLessThan(0.005);
        const roles = report.model!.sketches.map((s) => s.name);
        expect(roles.filter((n) => n.startsWith("Отверстие"))).toHaveLength(2);
    });

    test("a stepped part with a counterbore", async () => {
        const part = cut(
            fuse(box(0, 0, 0, 50, 50, 10), box(10, 10, 10, 30, 30, 15)),
            cyl(XYZ.unitZ, at(25, 25, -1), 4, 30),
            cyl(XYZ.unitZ, at(25, 25, 20), 7, 10),
        );
        const report = await rebuild(part);
        expect(report.error).toBeUndefined();
        expect(report.ratio).toBeLessThan(0.005);
    });

    test("rounded top edges come back round, not as slabs", async () => {
        const block = box(0, 0, 0, 40, 30, 12);
        const edges = block.findSubShapes(ShapeTypes.edge) as IEdge[];
        const top = edges.flatMap((e, i) => {
            const [a, b] = e.ends();
            return Math.abs(a.z - 12) < 1e-6 && Math.abs(b.z - 12) < 1e-6 ? [i] : [];
        });
        const rounded = shapeFactory.fillet(block, top, 3).value;
        if (process.env["KERN3D_STL_DUMP_ROUNDED"])
            writeFileSync(process.env["KERN3D_STL_DUMP_ROUNDED"], stlBytes(rounded));
        const report = await rebuild(rounded);
        expect(report.error).toBeUndefined();
        // as a fillet on the slabs, or as the common part of the block's views (which are rounded)
        expect(report.ratio).toBeLessThan(0.01);
        expect(report.surfaceOff ?? 1).toBeLessThan(0.05);
    });

    test("a block with chamfered top edges: one chamfer of their distance", async () => {
        const block = box(0, 0, 0, 40, 30, 12);
        const edges = block.findSubShapes(ShapeTypes.edge) as IEdge[];
        const top = edges.flatMap((e, i) => {
            const [a, b] = e.ends();
            return Math.abs(a.z - 12) < 1e-6 && Math.abs(b.z - 12) < 1e-6 ? [i] : [];
        });
        const chamfered = shapeFactory.chamfer(block, top, 2).value;
        const report = await rebuild(chamfered);
        expect(report.error).toBeUndefined();
        expect(report.ratio).toBeLessThan(0.005);
        expect(report.surfaceOff ?? 1).toBeLessThan(0.05);
    });

    test("a leaning arm on a plate is one oblique extrude along a direction line", async () => {
        const plate = box(0, 0, 0, 60, 40, 5);
        const foot = shapeFactory.face([
            shapeFactory.wire([
                shapeFactory.line(at(10, 10, 5), at(25, 10, 5)).value,
                shapeFactory.line(at(25, 10, 5), at(25, 20, 5)).value,
                shapeFactory.line(at(25, 20, 5), at(10, 20, 5)).value,
                shapeFactory.line(at(10, 20, 5), at(10, 10, 5)).value,
            ]).value,
        ]).value;
        const arm = shapeFactory.prism(foot, new XYZ({ x: 8, y: 6, z: 20 })).value;
        const part = fuse(plate, arm);
        if (process.env["KERN3D_STL_DUMP"]) writeFileSync(process.env["KERN3D_STL_DUMP"], stlBytes(part));
        const report = await rebuild(part);
        expect(report.error).toBeUndefined();
        expect(report.model!.sketches.some((x) => x.name.startsWith("Направление"))).toBe(true);
        expect(report.ratio).toBeLessThan(0.005);
    });

    test("a hole square to the main axis is cut along its own axis", async () => {
        // the vertical holes make z the main axis; the side hole runs along x
        const part = cut(
            box(0, 0, 0, 40, 30, 20),
            cyl(XYZ.unitX, at(-1, 15, 10), 4, 42),
            cyl(XYZ.unitZ, at(8, 8, -1), 2.5, 22),
            cyl(XYZ.unitZ, at(32, 8, -1), 2.5, 22),
            cyl(XYZ.unitZ, at(8, 22, -1), 2.5, 22),
            cyl(XYZ.unitZ, at(32, 22, -1), 2.5, 22),
        );
        const report = await rebuild(part);
        expect(report.error).toBeUndefined();
        // (by the holes read off the faces, the view cuts or the corrections — whichever comes first)
        expect(report.ratio).toBeLessThan(0.01);
        expect(report.surfaceOff ?? 1).toBeLessThan(0.05);
    });
});

/**
 * Real STLs: KERN3D_STL_CORPUS=<dir> runs every .stl under it (one folder per file) and prints
 * the difference and the feature count per part. Exploratory — it reports, it does not fail.
 */
const corpus = process.env["KERN3D_STL_CORPUS"];
describe.skipIf(corpus === undefined)("STL corpus", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            const full = path.join(dir, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (entry.toLowerCase().endsWith(".stl")) files.push(full);
        }
    };
    if (corpus !== undefined) walk(corpus);
    // small parts first, so a slow big one does not hide the rest
    files.sort((a, b) => statSync(a).size - statSync(b).size);
    const logFile = process.env["KERN3D_STL_LOG"];
    const log = (line: string) => {
        console.log(line);
        if (logFile)
            appendFileSync(
                logFile,
                `${line}
`,
            );
    };
    test.each(files)("%s", async (file) => {
        const started = Date.now();
        const stl = fromStl(new Uint8Array(readFileSync(file)));
        const tRef = Date.now();
        const reference = meshToSolid(stl);
        log(`  ${path.basename(file)}: reference ${Date.now() - tRef} ms`);
        if (!reference.isOk) {
            log(`REBUILD ${path.basename(file)}: reference failed ${reference.error}`);
            return;
        }
        if (process.env["KERN3D_STL_FACES"]) {
            // only the reference's size, for tuning the rebuild's budgets
            const faces = reference.value.findSubShapes(ShapeTypes.face).length;
            log(
                `FACES ${path.basename(file)}: ${faces} faces, ${trianglesOf(stl).length / 9} triangles, reference ${Date.now() - tRef} ms`,
            );
            return;
        }
        setRebuildDebug((line) => log(`  ${path.basename(file)}: ${line}`));
        // KERN3D_STL_OFF=holes (or =stage24): the holes off the faces off, for a comparison;
        // KERN3D_STL_SHARP=1: the sharp plan tried too
        const offEnv = process.env["KERN3D_STL_OFF"] ?? "";
        const off = offEnv.split(",").includes("holes") || offEnv === "stage24" ? (["holes"] as const) : [];
        const sharpRounds = process.env["KERN3D_STL_SHARP"] === "1";
        const report = await rebuildPart(document(), trianglesOf(stl), reference.value, path.basename(file), {
            off,
            sharpRounds,
        });
        setRebuildDebug(undefined);
        if (process.env["KERN3D_STL_SEGMENTS"] && report.model?.body.shape.isOk) {
            // where the rebuilt surface misses, by the STL's faces (primitive segmentation)
            const mesh = weldTriangles(trianglesOf(stl));
            const ts = Date.now();
            const segments = segmentMesh(mesh, Math.max(0.005, mesh.size * 5e-5));
            const segOf = new Int32Array(mesh.areas.length);
            for (const s of segments) for (const k of s.triangles) segOf[k] = s.id;
            const kinds = new Map<string, number>();
            const total = mesh.areas.reduce((a, b) => a + b, 0);
            for (const s of segments)
                kinds.set(s.primitive.kind, (kinds.get(s.primitive.kind) ?? 0) + s.area);
            log(
                `  ${path.basename(file)}: segments ${segments.length} in ${Date.now() - ts} ms: ${[...kinds].map(([k, a]) => `${k} ${((a / total) * 100).toFixed(1)}%`).join(", ")}`,
            );
            const hit = new Map<number, { off: number; all: number }>();
            surfaceFit(
                mesh,
                report.model.body.shape.value,
                Math.max(0.005 * 4, 0.05),
                3000,
                undefined,
                (k, off) => {
                    const e = hit.get(segOf[k]) ?? { off: 0, all: 0 };
                    e.all++;
                    if (off) e.off++;
                    hit.set(segOf[k], e);
                },
            );
            const worst = [...hit].filter(([, e]) => e.off > 0).sort((a, b) => b[1].off - a[1].off);
            const sampled = [...hit.values()].reduce((a, e) => a + e.all, 0);
            const byKind = new Map<string, number>();
            for (const [id, e] of worst) {
                const kind = segments[id].primitive.kind;
                byKind.set(kind, (byKind.get(kind) ?? 0) + e.off);
            }
            log(
                `  ${path.basename(file)}: misses by kind: ${[...byKind].map(([k, n]) => `${k} ${((n / sampled) * 100).toFixed(1)}%`).join(", ")}`,
            );
            for (const [id, e] of worst.slice(0, 12))
                log(`  ${path.basename(file)}:   miss ${e.off}/${e.all} ${describeSegment(segments[id])}`);
        }
        const names = report.model?.sketches.map((x) => x.name.split(" ")[0]) ?? [];
        const counts = [...new Set(names)]
            .map((n) => `${n}×${names.filter((x) => x === n).length}`)
            .join(" ");
        const t = report.timings;
        log(
            `REBUILD ${path.basename(file)}: first ${(report.firstRatio * 100).toFixed(2)}% → ${(report.ratio * 100).toFixed(2)}%, ` +
                `surface off ${((report.surfaceOff ?? 1) * 100).toFixed(1)}%, features ${report.features} (corrections ${report.corrections}, edges ${report.rounded ?? 0}, mesh pieces ${report.model?.body.features.filter((f) => f.type === "imported").length ?? 0}), ${((Date.now() - started) / 1000).toFixed(1)} s` +
                ` [${counts}]` +
                (t
                    ? ` (plan ${t.plan} ms, build ${t.build} ms, compare ${t.compare} ms, correct ${t.correct} ms)`
                    : "") +
                (report.error ? `, error: ${report.error}` : ""),
        );
    }, 600_000);
});

function measureRatio(mesh: ReturnType<typeof weldTriangles>, shape: IShape): number {
    const d = meshDifference(mesh, weldTriangles(trianglesOf(shape)));
    return (d.aOnly + d.bOnly) / d.aVolume;
}

/** KERN3D_STL_DEBUG=<file.stl>: prints the frame and every slab's fitted profiles. */
const debugFile = process.env["KERN3D_STL_DEBUG"];
describe.skipIf(debugFile === undefined)("STL debug", () => {
    test("slabs", async () => {
        const out = process.env["KERN3D_STL_DEBUG_OUT"] ?? `${debugFile}.debug.txt`;
        const dbg = (...parts: unknown[]) =>
            appendFileSync(
                out,
                `${parts.join(" ")}
`,
            );
        const stl = fromStl(new Uint8Array(readFileSync(debugFile!)));
        const mesh = weldTriangles(trianglesOf(stl));
        const frames = sliceFrames(mesh);
        dbg(
            `DEBUG frames ${frames
                .slice(0, 5)
                .map((f) => f.axis.map((x) => x.toFixed(2)).join(","))
                .join(" | ")}`,
        );
        const want = process.env["KERN3D_STL_AXIS"];
        const frame = want
            ? (frames.find((f) => f.axis.map((x) => Math.round(x)).join(",") === want) ?? frames[0])
            : frames[0];
        dbg(
            "DEBUG frame",
            JSON.stringify(frame),
            "size",
            mesh.size.toFixed(2),
            "volume",
            meshVolume(mesh).toFixed(2),
        );
        const tol = Math.max(0.005, mesh.size * 5e-5);
        {
            const mid = slabsOf(mesh, frame).sort((a, b) => b.top - b.bottom - (a.top - a.bottom))[0];
            const loop = mid.loops[0];
            dbg(
                `DEBUG mid loop ${loop.length} points: ${loop.map((p) => `(${p[0].toFixed(3)},${p[1].toFixed(3)})`).join(" ")}`,
            );
            const fit = fitProfile(loop, tol);
            if (fit?.kind === "chain")
                dbg(
                    `DEBUG mid fit: ${fit.curves.map((c) => (c.kind === "line" ? `L(${c.a[0].toFixed(2)},${c.a[1].toFixed(2)})` : `A r${c.r.toFixed(3)}`)).join(" ")}`,
                );
        }
        for (const slab of slabsOf(mesh, frame)) {
            const profiles = slab.loops.map((l) => ({ area: loopArea(l), fit: fitProfile(l, tol) }));
            dbg(
                `DEBUG slab ${slab.bottom.toFixed(3)}..${slab.top.toFixed(3)} slanted ${(slab.slanted * 100).toFixed(0)}% ` +
                    profiles
                        .map(
                            (p) =>
                                `[loop ${p.area.toFixed(2)} → ${p.fit === undefined ? "none" : p.fit.kind === "circle" ? `circle r${p.fit.r.toFixed(3)} ${p.fit.ccw ? "ccw" : "cw"}` : `${p.fit.curves.length} curves area ${profileArea(p.fit).toFixed(2)}`}]`,
                        )
                        .join(" "),
            );
        }
        const treatments: EdgeTreatment[] = [];
        setPlanDebug((line) => dbg(`DEBUG ${line}`));
        const plans = planExtrusions(mesh, frame, tol, { treatments });
        setPlanDebug(undefined);
        for (const t of treatments)
            dbg(`DEBUG treatment ${t.kind} size ${t.size} at ${t.height.toFixed(3)} loops ${t.loops.length}`);
        const reference = meshToSolid(stl).value;
        const model = await buildModel(document(), plans, "debug", tol);
        model.body.features.forEach((_, i) => {
            const items = model.body.featureItems();
            dbg(`DEBUG feature ${i} error ${items[i]?.error ?? "-"}`);
        });
        for (const plan of plans) {
            dbg(
                `DEBUG plan ${plan.role} ${plan.operation ?? "-"} base ${plan.base.toFixed(3)} depth ${plan.depth.toFixed(3)} draft ${plan.draft ?? 0} profiles ${plan.profiles.map((p) => (p.kind === "circle" ? `circle r${p.r.toFixed(2)}` : `${p.curves.length}c a${profileArea(p).toFixed(1)}`)).join(",")}`,
            );
        }
        model.body.features.forEach((f, i) => {
            const e = f as { depth?: number; draftAngle?: number; operation?: string };
            dbg(
                `DEBUG built feature ${i}: ${model.sketches[i]?.name} depth ${e.depth} draft ${e.draftAngle ?? 0} op ${e.operation ?? "-"} error ${model.body.featureItems()[i]?.error ?? "-"}`,
            );
        });
        for (const t of treatments) {
            const idx = treatmentEdges(model, t, tol);
            const before = measureRatio(mesh, model.body.shape.value);
            const ok = appendTreatment(model, t, tol);
            const after = ok ? measureRatio(mesh, model.body.shape.value) : before;
            dbg(
                `DEBUG apply ${t.kind} ${t.size} at ${t.height.toFixed(2)}: edges ${idx.length}, ok ${ok}, error ${model.body.featureItems().at(-1)?.error ?? "-"}, ${(before * 100).toFixed(3)}% → ${(after * 100).toFixed(3)}%`,
            );
        }
        if (!model.body.shape.isOk) {
            dbg(`DEBUG body shape error: ${model.body.shape.error}`);
            return;
        }
        const built = model.body.shape.value;
        const box = (x: IShape) => {
            const b = x.boundingBox();
            return `[${b.min.x.toFixed(1)},${b.min.y.toFixed(1)},${b.min.z.toFixed(1)}]..[${b.max.x.toFixed(1)},${b.max.y.toFixed(1)},${b.max.z.toFixed(1)}]`;
        };
        dbg(
            `DEBUG built volume ${solidVolume(built).toFixed(1)} box ${box(built)} solids ${built.findSubShapes(ShapeTypes.solid).length}`,
        );
        dbg(`DEBUG reference volume ${solidVolume(reference).toFixed(1)} box ${box(reference)}`);
        dbg(
            `DEBUG signed volumes reference ${reference.findSubShapes(ShapeTypes.solid).map((x) => x.volume().toFixed(1))} built ${built.findSubShapes(ShapeTypes.solid).map((x) => x.volume().toFixed(1))} mesh ${meshVolume(mesh).toFixed(1)}`,
        );
        {
            const refMesh = weldTriangles(trianglesOf(reference));
            const builtMesh = weldTriangles(trianglesOf(built));
            const self = meshDifference(refMesh, refMesh);
            const vsStl = meshDifference(mesh, refMesh);
            const vsBuilt = meshDifference(refMesh, builtMesh);
            const stlBuilt = meshDifference(mesh, builtMesh);
            for (const k of [1e-5, 1e-4, 1e-3]) {
                const m = weldTriangles(trianglesOf(reference), mesh.size * k);
                const d = meshDifference(mesh, m);
                dbg(
                    `DEBUG weld ${k}: meshVol ${meshVolume(m).toFixed(1)} vs stl ${d.aOnly.toFixed(1)}/${d.bOnly.toFixed(1)}`,
                );
            }
            {
                const faces = reference.findSubShapes(ShapeTypes.face);
                let reversed = 0;
                for (const f of faces)
                    if ((f as any).orientation?.() === "reversed" || (f as any).orientation === "reversed")
                        reversed++;
                dbg(
                    `DEBUG faces ${faces.length}, reversed ${reversed}, mesh normals ${reference.mesh.faces?.normal?.length ?? "none"}`,
                );
            }
            dbg(
                `DEBUG ray self ${self.aOnly.toFixed(1)}/${self.bOnly.toFixed(1)} vol ${self.aVolume.toFixed(1)} (solid ${solidVolume(reference).toFixed(1)}, meshVol ${meshVolume(refMesh).toFixed(1)}, tris ${refMesh.areas.length})`,
            );
            dbg(
                `DEBUG ray stl-vs-ref ${vsStl.aOnly.toFixed(1)}/${vsStl.bOnly.toFixed(1)} stlvol ${vsStl.aVolume.toFixed(1)}`,
            );
            dbg(
                `DEBUG ray ref-vs-built ${vsBuilt.aOnly.toFixed(1)}/${vsBuilt.bOnly.toFixed(1)}; stl-vs-built ${stlBuilt.aOnly.toFixed(1)}/${stlBuilt.bOnly.toFixed(1)}; built meshVol ${meshVolume(builtMesh).toFixed(1)}`,
            );
        }
        for (const eps of [0.01, 0.05, 0.2]) {
            const r = surfaceFit(mesh, reference, eps);
            const b = surfaceFit(mesh, built, eps);
            dbg(
                `DEBUG surfaceFit eps ${eps}: reference ${(r.off * 100).toFixed(1)}% built ${(b.off * 100).toFixed(1)}% of ${b.sampled}; misses ${b.misses
                    .slice(0, 6)
                    .map((p) => p.map((x) => x.toFixed(2)).join(","))
                    .join(" | ")}`,
            );
        }
        const dev = deviation(reference, built);
        dbg(
            `DEBUG deviation missing ${dev.missing.toFixed(1)} extra ${dev.extra.toFixed(1)} ratio ${(dev.ratio * 100).toFixed(3)}%`,
        );
        for (const sketch of model.sketches) {
            const data = sketch.data;
            dbg(
                `DEBUG sketch ${sketch.name}: ${data.entities.length} entities, ${data.constraints.length} constraints, plane origin ${sketch.plane.origin.toString?.()} x ${sketch.plane.xvec.toString?.()} y ${sketch.plane.yvec.toString?.()}`,
            );
        }
        for (const plan of plans) {
            dbg(
                `DEBUG plan ${plan.role} ${plan.operation ?? "-"} base ${plan.base.toFixed(3)} depth ${plan.depth.toFixed(3)} profiles ${plan.profiles.length}`,
            );
        }
    });
});
