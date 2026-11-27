// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, Mesh, MeshNode } from "@chili3d/core";
import { createMockDocument } from "@chili3d/core/test-utils";
import { afterEach, describe, expect, rs, test } from "@rstest/core";
import { computeDeviationMap, DeviationMapState } from "../../src/commands/scanDeviationCommand";
import {
    type DisplayMesh,
    deviationColor,
    deviationRange,
    deviationStats,
    legendGradient,
    refineForDisplay,
} from "../../src/scanTools/deviation";
import { weldTriangles } from "../../src/stlRebuild/mesh";
import { plateWithHole, soupOf } from "./meshes";

const TOL = 0.05;

/** A soup as a display mesh (no shared vertices, flat normals). */
function display(soup: Float64Array, dz = 0): DisplayMesh {
    const n = soup.length / 3;
    const position = new Float32Array(soup.length);
    for (let i = 0; i < n; i++) {
        position[3 * i] = soup[3 * i];
        position[3 * i + 1] = soup[3 * i + 1];
        position[3 * i + 2] = soup[3 * i + 2] + dz;
    }
    return {
        position,
        normal: new Float32Array(soup.length),
        index: Uint32Array.from({ length: n }, (_, i) => i),
    };
}

describe("deviation colours", () => {
    test("green within the tolerance, red outside the mesh, blue inside", () => {
        expect(deviationColor(0.01, TOL, 0.5)).toEqual(deviationColor(-0.04, TOL, 0.5));
        const [r, g] = deviationColor(0.5, TOL, 0.5);
        expect(r).toBeGreaterThan(0.8);
        expect(g).toBeLessThan(0.2);
        const blue = deviationColor(-0.5, TOL, 0.5);
        expect(blue[2]).toBeGreaterThan(0.8);
        expect(blue[0]).toBeLessThan(0.2);
    });

    test("the range is at least five tolerances and shrugs off a lone spike", () => {
        expect(deviationRange([0, 0.01, -0.01], TOL)).toBeCloseTo(5 * TOL, 9);
        const d = Array.from({ length: 1000 }, (_, i) => (i === 0 ? 50 : (i % 10) * 0.1));
        expect(deviationRange(d, TOL)).toBeCloseTo(0.9, 9);
    });

    test("the legend runs red to blue with the green band in the middle", () => {
        const css = legendGradient(0.1, 0.5);
        expect(css.startsWith("rgb(230,31,26) 0%")).toBe(true);
        expect(css).toContain("40.00%");
        expect(css).toContain("60.00%");
        expect(css.endsWith("100%")).toBe(true);
    });

    test("stats", () => {
        const s = deviationStats([0.2, -0.3, 0.01, 0], TOL);
        expect(s.max).toBeCloseTo(0.2, 9);
        expect(s.min).toBeCloseTo(-0.3, 9);
        expect(s.meanAbs).toBeCloseTo(0.51 / 4, 9);
        expect(s.within).toBeCloseTo(0.5, 9);
    });
});

describe("refineForDisplay", () => {
    test("a long triangle is cut into k² of the same total area; short ones are left alone", () => {
        const mesh: DisplayMesh = {
            position: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 1, 0.5, 0, 1, 0, 0.5, 1]),
            normal: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
            index: Uint32Array.from([0, 1, 2, 3, 4, 5]),
        };
        const out = refineForDisplay(mesh, 2);
        // ceil(14.14 / 2) = 8 → 64 triangles, plus the small one
        expect(out.index.length / 3).toBe(65);
        let area = 0;
        const p = out.position;
        for (let t = 0; t < out.index.length; t += 3) {
            const [a, b, c] = [out.index[t] * 3, out.index[t + 1] * 3, out.index[t + 2] * 3];
            const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
            const v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
            area +=
                Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) /
                2;
        }
        expect(area).toBeCloseTo(50 + 0.125, 4);
    });
});

describe("computeDeviationMap", () => {
    const reference = soupOf(weldTriangles(plateWithHole(40, 10, 6, 32, 2, 2)));

    test("the part against itself: all within tolerance", () => {
        const result = computeDeviationMap(display(reference), reference, 57);
        expect(result.stats.within).toBe(1);
        expect(result.stats.max).toBeLessThan(1e-6);
        expect(result.colors.length).toBe(result.display.position.length);
    });

    test("the part raised 0.3 mm: its top stands out (+0.3), its bottom sinks in (−0.3)", () => {
        const result = computeDeviationMap(display(reference, 0.3), reference, 57);
        expect(result.stats.max).toBeCloseTo(0.3, 4);
        expect(result.stats.min).toBeCloseTo(-0.3, 4);
        // the side walls stay on the mesh: within tolerance
        expect(result.stats.within).toBeGreaterThan(0.1);
        expect(result.stats.within).toBeLessThan(0.9);
        expect(result.tol).toBe(TOL);
    });
});

describe("DeviationMapState", () => {
    afterEach(() => {
        DeviationMapState.instance.hide();
        Config.instance.scanDeviationMap = true;
    });

    function setup() {
        const document = createMockDocument();
        const calls: string[] = [];
        const context = document.visual.context;
        rs.spyOn(context, "displayMesh").mockImplementation(() => {
            calls.push("display");
            return 7;
        });
        rs.spyOn(context, "removeMesh").mockImplementation((id: number) => {
            calls.push(`remove ${id}`);
        });
        rs.spyOn(context, "setVisible").mockImplementation((_n, visible: boolean) => {
            calls.push(`visible ${visible}`);
        });
        const mesh = Mesh.createSurface(3, 3);
        const node = new MeshNode({ document, name: "scan", mesh });
        const legend = globalThis.document.createElement("div");
        globalThis.document.body.append(legend);
        const data = {
            position: new Float32Array(9),
            normal: new Float32Array(9),
            uv: new Float32Array(6),
            index: Uint32Array.from([0, 1, 2]),
            groups: [],
            range: [],
        };
        return { document, node, legend, data, calls };
    }

    test("show puts the coloured copy up and hides the body; hide undoes both", () => {
        const { document, node, legend, data, calls } = setup();
        DeviationMapState.instance.show(document, node, data, legend);
        expect(DeviationMapState.instance.active).toBe(true);
        expect(calls).toEqual(["display", "visible false"]);
        DeviationMapState.instance.hide();
        expect(DeviationMapState.instance.active).toBe(false);
        expect(calls.slice(2)).toEqual(["remove 7", "visible true"]);
        expect(legend.isConnected).toBe(false);
    });

    test("switching the tool off in the settings takes the map down", () => {
        const { document, node, data } = setup();
        DeviationMapState.instance.show(document, node, data, undefined);
        Config.instance.scanDeviationMap = false;
        expect(DeviationMapState.instance.active).toBe(false);
    });

    test("a change to the body takes the map down", () => {
        const { document, node, data } = setup();
        DeviationMapState.instance.show(document, node, data, undefined);
        node.mesh = Mesh.createSurface(3, 3);
        expect(DeviationMapState.instance.active).toBe(false);
    });
});
