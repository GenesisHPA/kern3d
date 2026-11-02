// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ProjectionAngle, ProjectionSide, Vec3, ViewOrientation } from "./drawingData";

/**
 * An orthographic view direction: `u` is drawn along the sheet's +x, `v` along +y, and `w`
 * (= u × v) points from the model toward the viewer. The model is Z-up; the front view looks
 * along +Y (the viewer stands at -Y), which is the convention of the 3D view cube.
 */
export interface ViewBasis {
    u: Vec3;
    v: Vec3;
    w: Vec3;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function normalize(a: Vec3): Vec3 {
    const length = Math.hypot(a[0], a[1], a[2]);
    return length === 0 ? [0, 0, 0] : [a[0] / length, a[1] / length, a[2] / length];
}

function negate(a: Vec3): Vec3 {
    return [-a[0], -a[1], -a[2]];
}

export function basisOf(u: Vec3, v: Vec3): ViewBasis {
    const nu = normalize(u);
    const nv = normalize(v);
    return { u: nu, v: nv, w: normalize(cross(nu, nv)) };
}

const ISO_W = normalize([1, -1, 1]);
const ISO_V = normalize([-1 / 3, 1 / 3, 2 / 3]); // +Z projected onto the plane normal to ISO_W
const ISO_U = normalize(cross(ISO_V, ISO_W));

const ORIENTATION_AXES: Record<ViewOrientation, [Vec3, Vec3]> = {
    front: [
        [1, 0, 0],
        [0, 0, 1],
    ],
    back: [
        [-1, 0, 0],
        [0, 0, 1],
    ],
    top: [
        [1, 0, 0],
        [0, 1, 0],
    ],
    bottom: [
        [1, 0, 0],
        [0, -1, 0],
    ],
    right: [
        [0, 1, 0],
        [0, 0, 1],
    ],
    left: [
        [0, -1, 0],
        [0, 0, 1],
    ],
    iso: [ISO_U, ISO_V],
};

export function orientationBasis(orientation: ViewOrientation): ViewBasis {
    const [u, v] = ORIENTATION_AXES[orientation];
    return basisOf(u, v);
}

/** The named orientation a basis matches, if any. */
export function orientationOf(basis: ViewBasis): ViewOrientation | "custom" {
    for (const [name, [u, v]] of Object.entries(ORIENTATION_AXES) as [ViewOrientation, [Vec3, Vec3]][]) {
        if (dot(basis.u, normalize(u)) > 0.9999 && dot(basis.v, normalize(v)) > 0.9999) return name;
    }
    return "custom";
}

/**
 * The view placed on `side` of a parent. In first-angle projection (ГОСТ 2.305) the view
 * seen from the LEFT is placed on the RIGHT and the view from above BELOW; third angle puts
 * each view on the side it is seen from. Horizontal neighbours share the parent's `v`
 * (their rows line up), vertical neighbours share `u` (their columns line up).
 */
export function projectedBasis(parent: ViewBasis, side: ProjectionSide, angle: ProjectionAngle): ViewBasis {
    const flip = angle === "first" ? -1 : 1;
    if (side === "right" || side === "left") {
        const sign = (side === "right" ? 1 : -1) * flip;
        const w: Vec3 = sign > 0 ? parent.u : negate(parent.u);
        const v = parent.v;
        return { u: normalize(cross(v, w)), v, w };
    }
    const sign = (side === "up" ? 1 : -1) * flip;
    const w: Vec3 = sign > 0 ? parent.v : negate(parent.v);
    const u = parent.u;
    return { u, v: normalize(cross(w, u)), w };
}

/** ГОСТ 2.302 scales, largest first. */
export const STANDARD_SCALES = [
    50,
    40,
    20,
    10,
    5,
    4,
    2.5,
    2,
    1,
    1 / 2,
    1 / 2.5,
    1 / 4,
    1 / 5,
    1 / 10,
    1 / 15,
    1 / 20,
    1 / 25,
    1 / 40,
    1 / 50,
    1 / 75,
    1 / 100,
];

function trimNumber(value: number): string {
    return Number.parseFloat(value.toFixed(3)).toString();
}

/** "1:2", "2:1", "1:1". */
export function formatScale(scale: number): string {
    if (scale >= 1) return `${trimNumber(scale)}:1`;
    return `1:${trimNumber(1 / scale)}`;
}

/** Inverse of `formatScale`; also takes a bare number. Undefined for anything else. */
export function parseScale(text: string): number | undefined {
    const match = /^\s*(\d+(?:[.,]\d+)?)\s*(?::\s*(\d+(?:[.,]\d+)?))?\s*$/.exec(text);
    if (match === null) return undefined;
    const a = Number.parseFloat(match[1].replace(",", "."));
    const b = match[2] === undefined ? 1 : Number.parseFloat(match[2].replace(",", "."));
    if (!(a > 0) || !(b > 0)) return undefined;
    return a / b;
}

/** The largest standard scale at which `size` model mm fits into `room` paper mm. */
export function fittingScale(size: number, room: number): number {
    if (!(size > 0)) return 1;
    for (const scale of STANDARD_SCALES) {
        if (size * scale <= room) return scale;
    }
    return STANDARD_SCALES[STANDARD_SCALES.length - 1];
}
