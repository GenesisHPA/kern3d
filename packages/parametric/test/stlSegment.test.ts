// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { meshVolume, weldTriangles } from "../src/stlRebuild/mesh";
import { primitiveDistance, refine, type Segment, segmentMesh } from "../src/stlRebuild/segment";
import { bandOfEdge, sharpenMesh } from "../src/stlRebuild/sharpen";

type P2 = [number, number];

/** A convex polygon (counter-clockwise, in x, y) extruded `h` along z, caps fanned from the first point. */
function extrude(poly: readonly P2[], h: number): number[] {
    const soup: number[] = [];
    const n = poly.length;
    for (let i = 0; i < n; i++) {
        const [x1, y1] = poly[i];
        const [x2, y2] = poly[(i + 1) % n];
        soup.push(x1, y1, 0, x2, y2, 0, x2, y2, h);
        soup.push(x1, y1, 0, x2, y2, h, x1, y1, h);
    }
    for (let i = 1; i + 1 < n; i++) {
        const [a, b, c] = [poly[0], poly[i], poly[i + 1]];
        soup.push(a[0], a[1], h, b[0], b[1], h, c[0], c[1], h);
        soup.push(a[0], a[1], 0, c[0], c[1], 0, b[0], b[1], 0);
    }
    return soup;
}

/** A w × d rectangle whose corners are rounded with radii `r` (0 = sharp), each round in `k` facets. */
function roundedRect(w: number, d: number, r: readonly number[], k: number): P2[] {
    const corners: [number, number, number][] = [
        [w, 0, -Math.PI / 2],
        [w, d, 0],
        [0, d, Math.PI / 2],
        [0, 0, Math.PI],
    ];
    const out: P2[] = [];
    corners.forEach(([x, y, start], i) => {
        const ri = r[i];
        if (ri <= 0) {
            out.push([x, y]);
            return;
        }
        const cx = x + (x > 0 ? -ri : ri);
        const cy = y + (y > 0 ? -ri : ri);
        for (let s = 0; s <= k; s++) {
            const a = start + ((Math.PI / 2) * s) / k;
            out.push([cx + ri * Math.cos(a), cy + ri * Math.sin(a)]);
        }
    });
    return out;
}

/**
 * A profile (ρ, z) revolved `n` times about z. Open profiles run from the axis to the axis; a
 * closed one (torus) wraps. Counter-clockwise in (ρ, z) seen with ρ right, z up = outward normals.
 */
function revolve(profile: readonly P2[], n: number, closed = false): number[] {
    const soup: number[] = [];
    const at = (p: P2, i: number) => {
        const a = (2 * Math.PI * i) / n;
        return [p[0] * Math.cos(a), p[0] * Math.sin(a), p[1]];
    };
    const m = closed ? profile.length : profile.length - 1;
    for (let j = 0; j < m; j++) {
        const p = profile[j];
        const q = profile[(j + 1) % profile.length];
        for (let i = 0; i < n; i++) {
            const a = at(p, i);
            const b = at(p, i + 1);
            const c = at(q, i + 1);
            const d = at(q, i);
            // the profile runs downward-outward then up: material to its left
            soup.push(...a, ...d, ...c);
            soup.push(...a, ...c, ...b);
        }
    }
    return soup;
}

const arc = (cx: number, cy: number, r: number, from: number, to: number, k: number): P2[] =>
    Array.from({ length: k + 1 }, (_, s) => {
        const a = from + ((to - from) * s) / k;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as P2;
    });

const ofKind = (segments: Segment[], kind: string) => segments.filter((s) => s.primitive.kind === kind);

describe("STL primitive segmentation", () => {
    test("a box with one rounded vertical edge: one cylinder of the round's radius, planes", () => {
        const mesh = weldTriangles(extrude(roundedRect(30, 20, [0, 3, 0, 0], 8), 10));
        const segments = segmentMesh(mesh, 0.005);
        const cylinders = ofKind(segments, "cylinder");
        expect(cylinders).toHaveLength(1);
        const c = cylinders[0].primitive;
        if (c.kind !== "cylinder") throw new Error();
        expect(c.radius).toBeCloseTo(3, 6);
        expect(Math.abs(c.axis[2])).toBeCloseTo(1, 6);
        // the centre of the round: (27, 17)
        expect(Math.abs(primitiveDistance(c, [27 + 3, 17, 5]))).toBeLessThan(1e-6);
        expect(ofKind(segments, "plane")).toHaveLength(6);
        expect(ofKind(segments, "free")).toHaveLength(0);
    });

    test("a faceted cylinder: its side is one cylinder, its caps two planes", () => {
        const profile: P2[] = [
            [0, 0],
            [5, 0],
            [5, 12],
            [0, 12],
        ];
        const mesh = weldTriangles(revolve(profile, 48));
        const segments = segmentMesh(mesh, 0.005);
        const cylinders = ofKind(segments, "cylinder");
        expect(cylinders).toHaveLength(1);
        const c = cylinders[0].primitive;
        if (c.kind !== "cylinder") throw new Error();
        expect(c.radius).toBeCloseTo(5, 6);
        expect(ofKind(segments, "plane")).toHaveLength(2);
    });

    test("a frustum: a cone of its half-angle", () => {
        const profile: P2[] = [
            [0, 0],
            [8, 0],
            [4, 10],
            [0, 10],
        ];
        const mesh = weldTriangles(revolve(profile, 40));
        const segments = segmentMesh(mesh, 0.005);
        const cones = ofKind(segments, "cone");
        expect(cones).toHaveLength(1);
        const c = cones[0].primitive;
        if (c.kind !== "cone") throw new Error();
        expect(c.angle).toBeCloseTo(Math.atan(4 / 10), 5);
        // the apex where the side meets the axis: z = 20
        expect(c.apex[2]).toBeCloseTo(20, 4);
    });

    test("a UV sphere: one sphere", () => {
        const profile = arc(0, 0, 4, -Math.PI / 2, Math.PI / 2, 16);
        profile[0] = [0, -4];
        profile[profile.length - 1] = [0, 4];
        const mesh = weldTriangles(revolve(profile, 32));
        const segments = segmentMesh(mesh, 0.005);
        const spheres = ofKind(segments, "sphere");
        expect(spheres.length).toBeGreaterThanOrEqual(1);
        const s = spheres.sort((a, b) => b.area - a.area)[0];
        if (s.primitive.kind !== "sphere") throw new Error();
        expect(s.primitive.radius).toBeCloseTo(4, 5);
        expect(s.area / segments.reduce((a, x) => a + x.area, 0)).toBeGreaterThan(0.9);
    });

    test("a torus: one torus of both radii", () => {
        const profile = arc(10, 0, 2, 0, 2 * Math.PI, 24).slice(0, 24);
        const mesh = weldTriangles(revolve(profile, 48, true));
        const segments = segmentMesh(mesh, 0.005);
        const tori = ofKind(segments, "torus").sort((a, b) => b.area - a.area);
        expect(tori.length).toBeGreaterThanOrEqual(1);
        const t = tori[0].primitive;
        if (t.kind !== "torus") throw new Error();
        expect(t.major).toBeCloseTo(10, 4);
        expect(t.minor).toBeCloseTo(2, 4);
        expect(tori[0].area / segments.reduce((a, x) => a + x.area, 0)).toBeGreaterThan(0.9);
    });

    test("a chamfered edge stays a plane; a hexagonal prism has no cylinder", () => {
        const chamfered: P2[] = [
            [0, 0],
            [30, 0],
            [30, 18],
            [28, 20],
            [0, 20],
        ];
        const a = segmentMesh(weldTriangles(extrude(chamfered, 10)), 0.005);
        expect(ofKind(a, "cylinder")).toHaveLength(0);
        expect(ofKind(a, "plane")).toHaveLength(7);
        const hex: P2[] = Array.from({ length: 6 }, (_, i) => [
            5 * Math.cos((i * Math.PI) / 3),
            5 * Math.sin((i * Math.PI) / 3),
        ]);
        const b = segmentMesh(weldTriangles(extrude(hex, 10)), 0.005);
        expect(ofKind(b, "cylinder")).toHaveLength(0);
        expect(ofKind(b, "plane")).toHaveLength(8);
    });

    test("the round's borders: tangent to the two faces it joins", () => {
        const mesh = weldTriangles(extrude(roundedRect(30, 20, [0, 3, 0, 0], 8), 10));
        const segments = segmentMesh(mesh, 0.005);
        const round = ofKind(segments, "cylinder")[0];
        const big = round.borders.filter((b) => b.length > 9).map((b) => b.angle);
        // two walls along its length (bent by half a facet's step), the caps across its ends
        expect(big).toHaveLength(2);
        for (const a of big) expect(a).toBeLessThan((6 * Math.PI) / 180);
    });

    test("refine pulls a nudged cylinder back onto its points", () => {
        const points = Array.from({ length: 60 }, (_, i) => {
            const a = i * 0.3;
            return [2 + 7 * Math.cos(a), -1 + 7 * Math.sin(a), (i % 7) * 1.5] as [number, number, number];
        });
        const fitted = refine(
            { kind: "cylinder", axis: [0.02, 0, 1], point: [2.3, -0.8, 0], radius: 6.7 },
            points,
            30,
        );
        if (fitted.kind !== "cylinder") throw new Error();
        expect(fitted.radius).toBeCloseTo(7, 5);
        for (const p of points) expect(Math.abs(primitiveDistance(fitted, p))).toBeLessThan(1e-5);
    });

    test("sharpened: a round collapses onto its sharp edge, a fillet of its radius", () => {
        const mesh = weldTriangles(extrude(roundedRect(30, 20, [0, 3, 0, 0], 8), 10));
        const sharp = sharpenMesh(mesh, segmentMesh(mesh, 0.005), 0.005);
        expect(sharp).toBeDefined();
        expect(sharp!.bands).toHaveLength(1);
        expect(sharp!.bands[0].kind).toBe("fillet");
        expect(sharp!.bands[0].size).toBeCloseTo(3, 4);
        expect(Math.abs(meshVolume(sharp!.mesh))).toBeCloseTo(6000, 3);
        const along = [0, 2.5, 5, 10].map((z) => [30, 20, z] as [number, number, number]);
        expect(bandOfEdge(sharp!.bands, along, 0.005)).toBe(0);
        expect(
            bandOfEdge(
                sharp!.bands,
                [
                    [0, 0, 0],
                    [0, 0, 10],
                ],
                0.005,
            ),
        ).toBe(-1);
        expect(
            bandOfEdge(
                sharp!.bands,
                [
                    [30, 0, 10],
                    [30, 20, 10],
                ],
                0.005,
            ),
        ).toBe(-1);
    });

    test("sharpened: a chamfer collapses, its equal distance read off", () => {
        const chamfered: P2[] = [
            [0, 0],
            [30, 0],
            [30, 18],
            [28, 20],
            [0, 20],
        ];
        const mesh = weldTriangles(extrude(chamfered, 10));
        const sharp = sharpenMesh(mesh, segmentMesh(mesh, 0.005), 0.005);
        expect(sharp?.bands.map((b) => b.kind)).toEqual(["chamfer"]);
        expect(sharp!.bands[0].size).toBeCloseTo(2, 4);
        expect(Math.abs(meshVolume(sharp!.mesh))).toBeCloseTo(6000, 3);
    });

    test("sharpened: a plain box, a hexagonal prism and a cylinder have no band", () => {
        const box = weldTriangles(extrude(roundedRect(30, 20, [0, 0, 0, 0], 1), 10));
        expect(sharpenMesh(box, segmentMesh(box, 0.005), 0.005)).toBeUndefined();
        const hex: P2[] = Array.from({ length: 6 }, (_, i) => [
            5 * Math.cos((i * Math.PI) / 3),
            5 * Math.sin((i * Math.PI) / 3),
        ]);
        const prism = weldTriangles(extrude(hex, 10));
        expect(sharpenMesh(prism, segmentMesh(prism, 0.005), 0.005)).toBeUndefined();
        const disc = weldTriangles(extrude(arc(0, 0, 5, 0, 2 * Math.PI, 48).slice(0, 48), 10));
        expect(sharpenMesh(disc, segmentMesh(disc, 0.005), 0.005)).toBeUndefined();
    });
});
