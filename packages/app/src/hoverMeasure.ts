// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    CurveUtils,
    formatMeasurement,
    type ICurve,
    type IEdge,
    type IFace,
    type ISurface,
    ShapeTypes,
    type VisualShapeData,
} from "@chili3d/core";

const FULL_TURN = Math.PI * 2 - 1e-6;

function disposeQuietly(value: unknown) {
    (value as { dispose?: () => void } | undefined)?.dispose?.();
}

/** A line's length, a full circle's diameter, an arc's radius — what an edge reads when hovered. */
export function edgeReadout(edge: IEdge): string | undefined {
    let curve: ICurve | undefined;
    try {
        curve = edge.curve;
    } catch {
        return undefined; // a degenerate edge has no curve
    }
    try {
        const basis = CurveUtils.isTrimmed(curve) ? curve.basisCurve : curve;
        if (CurveUtils.isCircle(basis)) {
            const sweep = Math.abs(curve.lastParameter() - curve.firstParameter());
            return sweep >= FULL_TURN
                ? formatMeasurement("diameter", basis.radius * 2)
                : `${formatMeasurement("radius", basis.radius)} · ${formatMeasurement("length", edge.length())}`;
        }
        return formatMeasurement("length", edge.length());
    } finally {
        disposeQuietly(curve);
    }
}

/** The radius of a cylindrical surface (unwrapping a trimmed one), read structurally. */
function cylinderRadius(surface: ISurface): number | undefined {
    const s = surface as unknown as Record<string, unknown>;
    const isCylinder =
        typeof s.radius === "number" &&
        s.axis !== undefined &&
        s.semiAngle === undefined &&
        s.majorRadius === undefined &&
        s.area === undefined;
    if (isCylinder) return s.radius as number;
    const trimmed = surface as Partial<{ basisSurface(): ISurface }>;
    if (typeof trimmed.basisSurface !== "function") return undefined;
    const basis = trimmed.basisSurface();
    try {
        return cylinderRadius(basis);
    } finally {
        basis.dispose();
    }
}

/** A cylindrical face reads its diameter; other faces read nothing. */
export function faceReadout(face: IFace): string | undefined {
    const surface = face.surface();
    try {
        const radius = cylinderRadius(surface);
        return radius === undefined ? undefined : formatMeasurement("diameter", radius * 2);
    } finally {
        surface.dispose();
    }
}

/** What the sub-shape under the cursor reads: the first detected edge, else a cylindrical face. */
export function hoverReadout(detected: readonly VisualShapeData[]): string | undefined {
    const first = detected[0];
    if (first === undefined) return undefined;
    try {
        if (first.shape.shapeType === ShapeTypes.edge) return edgeReadout(first.shape as IEdge);
        if (first.shape.shapeType === ShapeTypes.face) return faceReadout(first.shape as IFace);
    } catch {
        return undefined;
    }
    return undefined;
}
