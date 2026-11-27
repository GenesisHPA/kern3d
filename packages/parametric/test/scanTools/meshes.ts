// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { vertexRings } from "../../src/scanTools/noise";
import { type TriMesh, weldTriangles } from "../../src/stlRebuild/mesh";

/**
 * Synthetic parts for the scan tools' tests: a square plate with a round hole through it,
 * tessellated as densely as asked, and the ways a scan spoils one — Gaussian noise along the
 * normals, holes punched in the surface. Seeded, so a test sees the same mesh every run.
 */

/** A seeded uniform random in [0, 1) (mulberry32). */
export function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A standard normal draw (Box–Muller). */
export function gaussian(random: () => number): number {
    const u = Math.max(random(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/**
 * A `w` × `w` plate, `h` thick, centred on the origin with its bottom at z = 0, and a hole of
 * radius `r` through it along z. `n` segments round the hole (a multiple of 8, so the square's
 * corners are vertices), `rings` between the hole and the outside on each cap, `layers` up
 * each wall. Outward normals.
 */
export function plateWithHole(w: number, h: number, r: number, n = 64, rings = 4, layers = 4): number[] {
    const soup: number[] = [];
    const angle = (i: number) => (2 * Math.PI * i) / n;
    const inner = (i: number): [number, number] => [r * Math.cos(angle(i)), r * Math.sin(angle(i))];
    const outer = (i: number): [number, number] => {
        const c = Math.cos(angle(i));
        const s = Math.sin(angle(i));
        const k = w / 2 / Math.max(Math.abs(c), Math.abs(s));
        return [c * k, s * k];
    };
    const ring = (i: number, k: number): [number, number] => {
        const a = inner(i);
        const b = outer(i);
        const f = k / rings;
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    };
    const quad = (a: number[], b: number[], c: number[], d: number[]) =>
        soup.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < rings; k++) {
            const [p, q, s, t] = [ring(i, k), ring(i + 1, k), ring(i + 1, k + 1), ring(i, k + 1)];
            // top (z = h) counter-clockwise from above, bottom reversed
            quad([...p, h], [...t, h], [...s, h], [...q, h]);
            quad([...p, 0], [...q, 0], [...s, 0], [...t, 0]);
        }
        for (let l = 0; l < layers; l++) {
            const z0 = (h * l) / layers;
            const z1 = (h * (l + 1)) / layers;
            const [o0, o1] = [outer(i), outer(i + 1)];
            quad([...o0, z0], [...o1, z0], [...o1, z1], [...o0, z1]);
            const [i0, i1] = [inner(i), inner(i + 1)];
            quad([...i0, z0], [...i0, z1], [...i1, z1], [...i1, z0]);
        }
    }
    // the top cap's winding above runs p → t → s → q: counter-clockwise seen from +z means the
    // outward normal +z; checked by the volume in the tests
    return soup;
}

/**
 * A profile (ρ, z) revolved `n` times about z, from the axis back to the axis; counter-clockwise
 * in (ρ, z) (ρ right, z up) gives outward normals. Each profile segment cut in `steps`.
 */
export function revolved(profile: readonly (readonly [number, number])[], n: number, steps = 1): number[] {
    const fine: [number, number][] = [];
    for (let j = 0; j + 1 < profile.length; j++) {
        for (let s = 0; s < steps; s++) {
            const f = s / steps;
            const [p, q] = [profile[j], profile[j + 1]];
            fine.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]);
        }
    }
    fine.push([profile[profile.length - 1][0], profile[profile.length - 1][1]]);
    const soup: number[] = [];
    const at = (p: readonly [number, number], i: number) => {
        const a = (2 * Math.PI * i) / n;
        return [p[0] * Math.cos(a), p[0] * Math.sin(a), p[1]];
    };
    for (let j = 0; j + 1 < fine.length; j++) {
        for (let i = 0; i < n; i++) {
            const [a, b, c, d] = [
                at(fine[j], i),
                at(fine[j], i + 1),
                at(fine[j + 1], i + 1),
                at(fine[j + 1], i),
            ];
            // a quad touching the axis has a corner twice: welding drops the collapsed half
            soup.push(...a, ...c, ...d, ...a, ...b, ...c);
        }
    }
    return soup;
}

/** A sphere of radius `r` about the origin as a revolved semicircle (`rings` from pole to pole). */
export function sphere(r: number, n = 48, rings = 24): number[] {
    const profile: [number, number][] = [];
    for (let k = 0; k <= rings; k++) {
        const a = -Math.PI / 2 + (Math.PI * k) / rings;
        profile.push([Math.abs(r * Math.cos(a)) < 1e-12 ? 0 : r * Math.cos(a), r * Math.sin(a)]);
    }
    return revolved(profile, n);
}

/** The mesh's vertices moved along their normals by N(0, σ) — a scanner's noise. */
export function withNoise(mesh: TriMesh, sigma: number, seed = 1): TriMesh {
    const random = seeded(seed);
    const { normals } = vertexRings(mesh);
    const positions = Float64Array.from(mesh.positions);
    for (let v = 0; v < positions.length / 3; v++) {
        const g = gaussian(random) * sigma;
        positions[3 * v] += normals[3 * v] * g;
        positions[3 * v + 1] += normals[3 * v + 1] * g;
        positions[3 * v + 2] += normals[3 * v + 2] * g;
    }
    return rebuild(positions, mesh.triangles);
}

/** The triangles whose centres lie within `radius` of `centre` taken out — a scan's hole. */
export function withHole(mesh: TriMesh, centre: readonly [number, number, number], radius: number): TriMesh {
    const keep: number[] = [];
    const p = mesh.positions;
    const t = mesh.triangles;
    for (let k = 0; k < t.length / 3; k++) {
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (let e = 0; e < 3; e++) {
            cx += p[3 * t[3 * k + e]] / 3;
            cy += p[3 * t[3 * k + e] + 1] / 3;
            cz += p[3 * t[3 * k + e] + 2] / 3;
        }
        if (Math.hypot(cx - centre[0], cy - centre[1], cz - centre[2]) > radius)
            keep.push(t[3 * k], t[3 * k + 1], t[3 * k + 2]);
    }
    return rebuild(p, Uint32Array.from(keep));
}

/** A mesh from positions and triangles, its normals, areas and size computed anew. */
export function rebuild(positions: Float64Array, triangles: Uint32Array): TriMesh {
    const soup = new Float64Array(triangles.length * 3);
    for (let i = 0; i < triangles.length; i++) {
        soup[3 * i] = positions[3 * triangles[i]];
        soup[3 * i + 1] = positions[3 * triangles[i] + 1];
        soup[3 * i + 2] = positions[3 * triangles[i] + 2];
    }
    return weldTriangles(soup, 1e-9);
}

/** The mesh as a soup (9 numbers per triangle). */
export function soupOf(mesh: TriMesh): Float64Array {
    const t = mesh.triangles;
    const out = new Float64Array(t.length * 3);
    for (let i = 0; i < t.length; i++) {
        out[3 * i] = mesh.positions[3 * t[i]];
        out[3 * i + 1] = mesh.positions[3 * t[i] + 1];
        out[3 * i + 2] = mesh.positions[3 * t[i] + 2];
    }
    return out;
}
