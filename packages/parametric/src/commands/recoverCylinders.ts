// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type IShape, type IVertex, ShapeTypes, XYZ } from "@chili3d/core";

/**
 * Exact cylinders back from an STL's facets — holes, bosses, shafts and the rounds on edges.
 *
 * After its planar triangles are merged (`meshToSolid`), a cylinder of an STL is a run of narrow
 * planar strips meeting at small angles. Each such run is found, a cylinder fitted to it (the
 * axis: the direction every strip's normal is square to; the radius: a circle through the
 * vertices round that axis), and accepted only when every vertex lies on it within 1 % of the
 * radius. The vertices of the facets lie ON the true surface, the facets inside it (a convex
 * surface) or outside it (a concave one) — so fusing an exact cylinder, or the sector of one the
 * run spans, onto a convex run, or cutting it out of a concave one, removes exactly the slivers
 * between the facets and the true surface, and the run becomes one exact cylindrical face.
 */

interface FaceInfo {
    face: IFace;
    normal: XYZ;
    area: number;
    points: XYZ[];
    longest: number;
    keys: string[];
}

export interface RecoveredCylinder {
    /**
     * The facets' innermost distance from the axis (their chords' midpoints): the slivers between
     * facets and the true surface lie between this and `radius`, so the tool is a ring that thin.
     */
    inner: number;
    axis: XYZ;
    /** A point on the axis, level with the run's lowest vertex. */
    base: XYZ;
    radius: number;
    height: number;
    convex: boolean;
    /** Degrees the run spans round the axis, 360 for a whole cylinder; from `start` (a point on it). */
    sweep: number;
    start: XYZ;
}

const SMOOTH_MIN = (0.3 * Math.PI) / 180;
const SMOOTH_MAX = (35 * Math.PI) / 180;

function key(p: XYZ, unit: number): string {
    return `${Math.round(p.x / unit)},${Math.round(p.y / unit)},${Math.round(p.z / unit)}`;
}

function faceInfo(face: IFace, unit: number): FaceInfo | undefined {
    const points = (face.findSubShapes(ShapeTypes.vertex) as IVertex[]).map((v) => v.point());
    if (points.length < 3) return undefined;
    const surface = face.surface();
    let normal: XYZ | undefined;
    try {
        if (!surface.isPlanar()) return undefined;
        // a plane is unbounded: the normal is read at one of the face's own vertices
        const uv = surface.parameter(points[0], unit * 1e3);
        if (uv === undefined) return undefined;
        normal = face.normal(uv.u, uv.v)[1].normalize();
    } finally {
        surface.dispose();
    }
    if (normal === undefined) return undefined;
    const edges = face.findSubShapes(ShapeTypes.edge) as IEdge[];
    let longest = 0;
    const keys: string[] = [];
    for (const e of edges) {
        const [a, b] = e.ends();
        longest = Math.max(longest, a.distanceTo(b));
        const [ka, kb] = [key(a, unit), key(b, unit)].sort();
        keys.push(`${ka}|${kb}`);
    }
    return { face, normal, area: face.area(), points, longest, keys };
}

/** Eigenvector of the smallest eigenvalue of a symmetric 3 × 3 matrix (Jacobi), with its share. */
function smallestEigen(m: number[][]): { vector: XYZ; share: number } {
    const a = m.map((row) => [...row]);
    const v = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
    ];
    for (let sweep = 0; sweep < 50; sweep++) {
        let off = 0;
        for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
        if (off < 1e-20) break;
        for (let p = 0; p < 3; p++) {
            for (let q = p + 1; q < 3; q++) {
                if (Math.abs(a[p][q]) < 1e-30) continue;
                const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;
                for (let k = 0; k < 3; k++) {
                    const akp = a[k][p];
                    const akq = a[k][q];
                    a[k][p] = c * akp - s * akq;
                    a[k][q] = s * akp + c * akq;
                }
                for (let k = 0; k < 3; k++) {
                    const apk = a[p][k];
                    const aqk = a[q][k];
                    a[p][k] = c * apk - s * aqk;
                    a[q][k] = s * apk + c * aqk;
                }
                for (let k = 0; k < 3; k++) {
                    const vkp = v[k][p];
                    const vkq = v[k][q];
                    v[k][p] = c * vkp - s * vkq;
                    v[k][q] = s * vkp + c * vkq;
                }
            }
        }
    }
    const values = [a[0][0], a[1][1], a[2][2]];
    const i = values.indexOf(Math.min(...values));
    const total = values.reduce((x, y) => x + Math.abs(y), 0) || 1;
    return {
        vector: new XYZ({ x: v[0][i], y: v[1][i], z: v[2][i] }).normalize()!,
        share: Math.abs(values[i]) / total,
    };
}

/** Least-squares circle through 2D points (Kåsa): centre and radius, or undefined. */
function fitCircle(points: [number, number][]): { cx: number; cy: number; r: number } | undefined {
    let sx = 0,
        sy = 0,
        sxx = 0,
        syy = 0,
        sxy = 0,
        sz = 0,
        sxz = 0,
        syz = 0;
    for (const [x, y] of points) {
        const z = x * x + y * y;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
        sz += z;
        sxz += x * z;
        syz += y * z;
    }
    const n = points.length;
    // [sxx sxy sx; sxy syy sy; sx sy n] [D E F]ᵀ = -[sxz syz sz]ᵀ
    const m = [
        [sxx, sxy, sx],
        [sxy, syy, sy],
        [sx, sy, n],
    ];
    const rhs = [-sxz, -syz, -sz];
    const det = (q: number[][]) =>
        q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) -
        q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) +
        q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
    const d = det(m);
    if (Math.abs(d) < 1e-18) return undefined;
    const solve = (col: number) => det(m.map((row, i) => row.map((x, j) => (j === col ? rhs[i] : x)))) / d;
    const [D, E, F] = [solve(0), solve(1), solve(2)];
    const cx = -D / 2;
    const cy = -E / 2;
    const r2 = cx * cx + cy * cy - F;
    return r2 > 0 ? { cx, cy, r: Math.sqrt(r2) } : undefined;
}

/** The cylinders an STL-made solid's facet runs fit, convex or concave, whole or a sector. */
export function findCylinders(solid: IShape): RecoveredCylinder[] {
    const box = solid.boundingBox();
    if (box === undefined) return [];
    const size = Math.max(
        1e-6,
        Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z),
    );
    const unit = size * 1e-6;
    const infos: FaceInfo[] = [];
    for (const face of solid.findSubShapes(ShapeTypes.face) as IFace[]) {
        const info = faceInfo(face, unit);
        if (info !== undefined) infos.push(info);
    }
    // a facet of a curved surface: a narrow strip — narrow against the part, not only against
    // itself (a thin plate's long side is a strip of its own and is not a facet)
    const strip = (f: FaceInfo) =>
        f.longest > 0 && f.area / f.longest < f.longest * 0.5 && f.area / f.longest < size * 0.05;
    const byEdge = new Map<string, number[]>();
    infos.forEach((f, i) => {
        for (const k of f.keys) byEdge.set(k, [...(byEdge.get(k) ?? []), i]);
    });
    const smooth = (f: number, g: number) => {
        const angle = Math.acos(Math.max(-1, Math.min(1, infos[f].normal.dot(infos[g].normal))));
        return angle >= SMOOTH_MIN && angle <= SMOOTH_MAX;
    };
    /** Connected runs of strips among `members`, joined across smooth edges. */
    const components = (members: Set<number>): number[][] => {
        const seen = new Set<number>();
        const runs: number[][] = [];
        for (const start of members) {
            if (seen.has(start)) continue;
            const run: number[] = [];
            const queue = [start];
            seen.add(start);
            while (queue.length > 0) {
                const f = queue.pop()!;
                run.push(f);
                for (const k of infos[f].keys) {
                    for (const g of byEdge.get(k) ?? []) {
                        if (seen.has(g) || !members.has(g) || !smooth(f, g)) continue;
                        seen.add(g);
                        queue.push(g);
                    }
                }
            }
            runs.push(run);
        }
        return runs;
    };
    // directions an axis may snap to: the world's, and the normals of the part's real faces
    const snaps: XYZ[] = [XYZ.unitX, XYZ.unitY, XYZ.unitZ];
    for (const f of infos) {
        if (strip(f) || f.area < size * size * 1e-4) continue;
        if (!snaps.some((d) => Math.abs(d.dot(f.normal)) > 1 - 1e-9)) snaps.push(f.normal);
    }
    const result: RecoveredCylinder[] = [];
    const fits: { fit: RecoveredCylinder; faces: number[] }[] = [];
    // runs are fitted one cylinder at a time: what fits comes off, the rest is split into its
    // own runs again and tried — a plate with four rounded corners is one ring of strips
    const pending = components(new Set(infos.map((_, i) => i).filter((i) => strip(infos[i]))));
    let guard = 0;
    while (pending.length > 0 && guard++ < 10_000) {
        const run = pending.pop()!;
        if (run.length < 3) continue;
        // the face furthest off the fitted cylinder goes, until it fits or too few are left
        let faces = run;
        let fit: RecoveredCylinder | undefined;
        while (faces.length >= 3) {
            const attempt = fitGroup(
                faces.map((i) => infos[i]),
                snaps,
            );
            if (attempt.fit !== undefined) {
                fit = attempt.fit;
                break;
            }
            if (attempt.worstFace === undefined) break;
            faces = faces.filter((_, index) => index !== attempt.worstFace);
        }
        if (fit === undefined) continue;
        fits.push({ fit, faces });
        const taken = new Set(faces);
        const rest = new Set(run.filter((i) => !taken.has(i)));
        if (rest.size >= 3) pending.push(...components(rest));
    }
    // pieces of one surface (a cylinder whose facets the file cut into several runs) share an
    // axis line and a radius: their faces are fitted again together, as the one cylinder
    const merged: { fit: RecoveredCylinder; faces: number[] }[] = [];
    for (const piece of fits) {
        const same = merged.find((m) => sameCylinder(m.fit, piece.fit));
        if (same === undefined) {
            merged.push({ fit: piece.fit, faces: [...piece.faces] });
            continue;
        }
        const faces = [...same.faces, ...piece.faces];
        const refit = fitGroup(
            faces.map((i) => infos[i]),
            snaps,
        ).fit;
        if (refit !== undefined && refit.convex === same.fit.convex) {
            same.fit = refit;
            same.faces = faces;
        } else {
            merged.push({ fit: piece.fit, faces: [...piece.faces] });
        }
    }
    result.push(...merged.map((m) => m.fit));
    return result;
}

/** The same cylinder (axis line and radius), within what a fit from an STL can tell. */
function sameCylinder(a: RecoveredCylinder, b: RecoveredCylinder): boolean {
    const tolerance = Math.max(1e-3, Math.max(a.radius, b.radius) * 2e-4) * 5;
    if (Math.abs(a.radius - b.radius) > tolerance || a.convex !== b.convex) return false;
    if (Math.abs(Math.abs(a.axis.dot(b.axis)) - 1) > 1e-6) return false;
    const d = b.base.sub(a.base);
    const off = d.sub(a.axis.multiply(d.dot(a.axis)));
    if (off.length() > tolerance) return false;
    // and the same stretch of it: two bores of one size at two depths are two cylinders, and
    // one ring spanning both would cut through the material between them
    const sign = a.axis.dot(b.axis) < 0 ? -1 : 1;
    const a0 = a.base.dot(a.axis);
    const b0 = b.base.dot(a.axis);
    const b1 = b0 + sign * b.height;
    const [lo, hi] = [Math.min(b0, b1), Math.max(b0, b1)];
    return lo <= a0 + a.height + tolerance && hi >= a0 - tolerance;
}

function fitGroup(
    faces: FaceInfo[],
    snaps: readonly XYZ[] = [],
): { fit?: RecoveredCylinder; worstFace?: number } {
    const m = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ];
    for (const f of faces) {
        const n = [f.normal.x, f.normal.y, f.normal.z];
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r][c] += f.area * n[r] * n[c];
    }
    const eigen = smallestEigen(m);
    const share = eigen.share;
    // a hole is drilled square to a face, a shaft runs along an axis: the fitted direction,
    // a hair off, snaps to such a direction within half a degree (else its rims are ellipses)
    let axis = eigen.vector;
    let closest = Math.cos((0.5 * Math.PI) / 180);
    for (const d of snaps) {
        const c = Math.abs(d.dot(axis));
        if (c > closest) {
            closest = c;
            axis = d.dot(axis) < 0 ? d.multiply(-1) : d;
        }
    }
    if (share > 0.02) {
        // the normals do not all lie square to one direction: the face least square to the
        // best guess goes first
        let worstFace = 0;
        let worst = -1;
        faces.forEach((f, index) => {
            const off = Math.abs(f.normal.dot(axis)) * f.area;
            if (off > worst) {
                worst = off;
                worstFace = index;
            }
        });
        return { worstFace };
    }
    const ref = Math.abs(axis.x) < 0.9 ? XYZ.unitX : XYZ.unitY;
    const e1 = axis.cross(ref).normalize()!;
    const e2 = axis.cross(e1);
    const points = new Map<string, XYZ>();
    for (const f of faces)
        for (const p of f.points) points.set(`${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`, p);
    const all = [...points.values()];
    const flat = all.map((p): [number, number] => [p.dot(e1), p.dot(e2)]);
    const circle = fitCircle(flat);
    if (circle === undefined) return {};
    const { cx, cy, r } = circle;
    const off = (p: XYZ) => Math.abs(Math.hypot(p.dot(e1) - cx, p.dot(e2) - cy) - r);
    const worst = Math.max(...all.map(off));
    // an STL from CAD has its vertices ON the surface (to float precision): a run that strays
    // further is some other curved surface that only looks round
    if (worst > Math.max(1e-3, r * 2e-4)) {
        let worstFace = 0;
        let most = -1;
        faces.forEach((f, index) => {
            const d = Math.max(...f.points.map(off));
            if (d > most) {
                most = d;
                worstFace = index;
            }
        });
        return { worstFace };
    }
    // convex when the facets face away from the axis
    let outward = 0;
    for (const f of faces) {
        const c = f.points.reduce((s, p) => s.add(p), XYZ.zero).multiply(1 / f.points.length);
        const radial = new XYZ({ x: 0, y: 0, z: 0 })
            .add(e1.multiply(c.dot(e1) - cx))
            .add(e2.multiply(c.dot(e2) - cy));
        outward += Math.sign(radial.dot(f.normal)) * f.area;
    }
    const ts = all.map((p) => p.dot(axis));
    const t0 = Math.min(...ts);
    const t1 = Math.max(...ts);
    if (t1 - t0 < 1e-6) return {};
    // the span round the axis: everything but its largest empty gap
    const angles = flat.map(([x, y]) => Math.atan2(y - cy, x - cx)).sort((a, b) => a - b);
    let gap = 0;
    let after = angles[0];
    for (let k = 0; k < angles.length; k++) {
        const next = k + 1 < angles.length ? angles[k + 1] : angles[0] + 2 * Math.PI;
        if (next - angles[k] > gap) {
            gap = next - angles[k];
            after = next;
        }
    }
    const step = (2 * Math.PI) / Math.max(8, angles.length / 2);
    const full = gap < step * 2.5;
    // the widest angle one facet spans (gaps inside the run, not the one outside it)
    let widest = 0;
    for (let k = 0; k + 1 < angles.length; k++) {
        const d = angles[k + 1] - angles[k];
        if (d < gap - 1e-9) widest = Math.max(widest, d);
    }
    if (full) widest = Math.max(widest, angles[0] + 2 * Math.PI - angles[angles.length - 1]);
    const inner = r * Math.cos(Math.min(widest, Math.PI / 3) / 2) * 0.995;
    const centre = (t: number) => axis.multiply(t).add(e1.multiply(cx)).add(e2.multiply(cy));
    const startAngle = full ? 0 : after;
    const start = centre(t0)
        .add(e1.multiply(Math.cos(startAngle) * r))
        .add(e2.multiply(Math.sin(startAngle) * r));
    return {
        fit: {
            axis,
            base: centre(t0),
            radius: r,
            inner,
            height: t1 - t0,
            convex: outward > 0,
            sweep: full ? 360 : ((2 * Math.PI - gap) * 180) / Math.PI,
            start,
        },
    };
}

/** The exact solid a recovered cylinder adds or takes away: the cylinder, or its sector. */
function toolOf(c: RecoveredCylinder, grow: number, below = 0, above = 0): IShape | undefined {
    const outer = solidOf(c, c.radius * (1 + grow), below, above);
    if (outer === undefined) return undefined;
    // hollowed to a ring no thicker than the slivers: a fused ring cannot fill a tube's bore, a
    // cut one cannot reach material behind a hole's wall
    const core = shapeFactory.cylinder(
        c.axis,
        c.base.sub(c.axis.multiply(below + 1)),
        c.inner,
        c.height + below + above + 2,
    );
    if (!core.isOk) return outer;
    const ring = shapeFactory.booleanCut([outer], [core.value]);
    core.value.dispose();
    if (!ring.isOk || ring.value.isNull()) return outer;
    outer.dispose();
    return ring.value;
}

function solidOf(c: RecoveredCylinder, radius: number, below: number, above: number): IShape | undefined {
    const base = c.base.sub(c.axis.multiply(below));
    const height = c.height + below + above;
    if (c.sweep >= 360) {
        const cylinder = shapeFactory.cylinder(c.axis, base, radius, height);
        return cylinder.isOk ? cylinder.value : undefined;
    }
    const dir = c.start.sub(c.base).normalize()!;
    const p0 = base.add(dir.multiply(radius));
    const arc = shapeFactory.arc(c.axis, base, p0, c.sweep);
    if (!arc.isOk) return undefined;
    const p1 = arc.value.endPoint();
    const l0 = shapeFactory.line(base, p0);
    const l1 = shapeFactory.line(p1, base);
    if (!l0.isOk || !l1.isOk) return undefined;
    const wire = shapeFactory.wire([l0.value, arc.value, l1.value]);
    if (!wire.isOk) return undefined;
    const face = shapeFactory.face([wire.value]);
    if (!face.isOk) return undefined;
    const prism = shapeFactory.prism(face.value, c.axis.multiply(height));
    return prism.isOk ? prism.value : undefined;
}

/** The solid's triangles, for point-in-solid tests by ray parity. */
function trianglesOf(shape: IShape): Float64Array {
    const faces = shape.mesh.faces;
    if (faces === undefined) return new Float64Array(0);
    const out = new Float64Array(faces.index.length * 3);
    for (let k = 0; k < faces.index.length; k++) {
        const v = faces.index[k] * 3;
        out[k * 3] = faces.position[v];
        out[k * 3 + 1] = faces.position[v + 1];
        out[k * 3 + 2] = faces.position[v + 2];
    }
    return out;
}

/** Whether `p` is inside the closed triangle mesh: crossings of a skewed ray, counted. */
function inside(triangles: Float64Array, p: XYZ): boolean {
    const d = [0.5773, 0.5774, 0.5775];
    let crossings = 0;
    for (let k = 0; k + 8 < triangles.length; k += 9) {
        const a = [triangles[k], triangles[k + 1], triangles[k + 2]];
        const e1 = [triangles[k + 3] - a[0], triangles[k + 4] - a[1], triangles[k + 5] - a[2]];
        const e2 = [triangles[k + 6] - a[0], triangles[k + 7] - a[1], triangles[k + 8] - a[2]];
        const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
        const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
        if (Math.abs(det) < 1e-12) continue;
        const f = 1 / det;
        const s = [p.x - a[0], p.y - a[1], p.z - a[2]];
        const u = f * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
        if (u < 0 || u > 1) continue;
        const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
        const v = f * (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]);
        if (v < 0 || u + v > 1) continue;
        const t = f * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]);
        if (t > 1e-9) crossings++;
    }
    return crossings % 2 === 1;
}

/**
 * How far the tool may run past each end of the cylinder: a tool ending exactly on a face of
 * the part is a coplanar case the boolean can get wrong, so it runs on through the end where
 * that changes nothing — into air beyond a hole's opening, into material below a boss's base.
 * A probe just inside the tool's section, beyond the end, tells which it is.
 */
function extensions(c: RecoveredCylinder, triangles: Float64Array, length: number): [number, number] {
    const ref = Math.abs(c.axis.x) < 0.9 ? XYZ.unitX : XYZ.unitY;
    const radial0 = c.start.sub(c.base).normalize() ?? c.axis.cross(ref).normalize()!;
    // probes over the tool's whole section beyond the end: an oblique end (an angled hole
    // leaving a face) has material on one side of it, and then the tool stays as it is
    const side = c.axis.cross(radial0);
    const span = (Math.min(c.sweep, 360) * Math.PI) / 180;
    const probes: XYZ[] = [];
    for (let i = 0; i < 8; i++) {
        const angle = c.sweep >= 360 ? (i * Math.PI) / 4 : (span * (i + 0.5)) / 8;
        const radial = radial0.multiply(Math.cos(angle)).add(side.multiply(Math.sin(angle)));
        // in the ring the tool is: between the facets' chords and the true surface
        probes.push(c.base.add(radial.multiply((c.inner + c.radius) / 2)));
    }
    const wanted = c.convex; // convex: beyond must be material; concave: air
    const clear = (t: number) => probes.every((p) => inside(triangles, p.add(c.axis.multiply(t))) === wanted);
    const below = clear(-length * 0.5) && clear(-length) ? length : 0;
    const above = clear(c.height + length * 0.5) && clear(c.height + length) ? length : 0;
    return [below, above];
}

function volumeOf(shape: IShape): number {
    return shape.findSubShapes(ShapeTypes.solid).reduce((v, s) => v + s.volume(), 0);
}

function valid(shape: IShape | undefined): shape is IShape {
    return shape !== undefined && !shape.isNull() && shape.findSubShapes(ShapeTypes.solid).length > 0;
}

function apply(shape: IShape, tools: IShape[], convex: boolean): IShape | undefined {
    if (tools.length === 0) return shape;
    const next = convex
        ? shapeFactory.booleanFuse([shape], tools, true)
        : shapeFactory.booleanCut([shape], tools);
    return next.isOk && valid(next.value) ? next.value : undefined;
}

/** A fit worth replacing: a whole cylinder, or an arc of 60° or more (a round), not huge. */
function worthIt(c: RecoveredCylinder, size: number): boolean {
    return (c.sweep >= 360 || c.sweep >= 60) && c.radius < size * 0.6;
}

/**
 * `solid` with the facet runs that fit a cylinder replaced by the exact cylinder, one boolean
 * each — whole cylinders first, the largest first, then the rounds — until `budgetMs` runs out;
 * a run whose boolean fails stays as facets. Returns how many were recovered.
 */
export function recoverCylinders(
    solid: IShape,
    budgetMs = Number.POSITIVE_INFINITY,
    onStep?: (cylinder: RecoveredCylinder, outcome: string, ms: number) => void,
): { shape: IShape; count: number } {
    const started = Date.now();
    const box = solid.boundingBox();
    const size =
        box === undefined
            ? 1
            : Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
    const cylinders = findCylinders(solid)
        .filter((c) => worthIt(c, size))
        .sort((a, b) => Number(b.sweep >= 360) - Number(a.sweep >= 360) || b.radius - a.radius);
    let shape = solid;
    let count = 0;
    const triangles = cylinders.length > 0 ? trianglesOf(solid) : new Float64Array(0);
    const reach = Math.max(0.5, size * 0.01);
    let volume = cylinders.length > 0 ? volumeOf(solid) : 0;
    for (const c of cylinders) {
        if (Date.now() - started > budgetMs) break;
        const stepStart = Date.now();
        const report = (outcome: string) => onStep?.(c, outcome, Date.now() - stepStart);
        const [below, above] = extensions(c, triangles, reach);
        const tool = toolOf(c, 1e-5, below, above);
        if (tool === undefined) continue;
        const ringVolume = volumeOf(tool);
        const next = apply(shape, [tool], c.convex);
        tool.dispose();
        if (next === undefined) {
            report("boolean failed");
            continue;
        }
        // a boolean that changed nothing (or the wrong way) recovered nothing; one that changed
        // more than half the ring did not just fill slivers — the surface was not that cylinder
        const after = volumeOf(next);
        const moved = c.convex ? after - volume : volume - after;
        if (!(moved > 0) || moved > ringVolume * 0.5) {
            if (next !== shape) next.dispose();
            report(`rejected: volume moved ${moved.toFixed(3)} of ring ${ringVolume.toFixed(3)}`);
            continue;
        }
        // and the solid still a valid one — a boolean can succeed and leave a defect the next
        // operation (a hole, a fillet) would trip on; then this step is undone
        if (!next.checkShape()) {
            if (next !== shape) next.dispose();
            report("rejected: result not a valid solid");
            continue;
        }
        report(`ok: ${moved.toFixed(3)}`);
        volume = after;
        if (shape !== solid && next !== shape) shape.dispose();
        shape = next;
        count++;
    }
    return { shape, count };
}
