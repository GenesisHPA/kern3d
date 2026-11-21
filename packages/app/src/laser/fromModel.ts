// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument, IShape, Matrix4 } from "@chili3d/core";
import { composeDrawing } from "../drawing/compose";
import type { Vec3 } from "../drawing/drawingData";
import type { DrawingNode } from "../drawing/drawingNode";
import { newView, resolveSource, ViewGeometryCache } from "../drawing/drawingViews";
import { computeViewGeometry, type Polyline2, type ViewGeometry } from "../drawing/hlr";
import { extractHlrInput } from "../drawing/hlrInput";
import { sheetToSvg } from "../drawing/svgExport";
import { basisOf, cross, normalize } from "../drawing/viewBasis";
import { chainPaths } from "./chain";
import { FLATTEN_TOLERANCE, flattenEllipseArc } from "./flatten";
import { isEmpty, type LaserPath, type Pt, pathsBounds, transformPaths, translation } from "./geometry";
import { importSvg, type SvgImport } from "./svgImport";

export type ModelView = "top" | "front" | "right";

/** A projected line as a path; an exact arc is flattened again to the laser's tolerance. */
function polylinePath(line: Polyline2): LaserPath {
    if (line.arc !== undefined) {
        const { cx, cy, r, start, sweep } = line.arc;
        const points: Pt[] = [{ x: cx + r * Math.cos(start), y: cy + r * Math.sin(start) }];
        flattenEllipseArc(cx, cy, r, r, 0, start, sweep, FLATTEN_TOLERANCE, points);
        const full = Math.abs(sweep) >= 2 * Math.PI - 1e-9;
        if (full) points.pop();
        return { points, closed: full };
    }
    const points: Pt[] = [];
    for (let k = 0; k + 1 < line.points.length; k += 2)
        points.push({ x: line.points[k], y: line.points[k + 1] });
    return { points, closed: false };
}

/** The visible lines of a view, joined into outlines and moved to start at (0, 0). */
export function geometryToImport(geometry: ViewGeometry | undefined): SvgImport | undefined {
    if (geometry === undefined) return undefined;
    const paths = chainPaths(geometry.visible.map(polylinePath).filter((p) => p.points.length > 1));
    const b = pathsBounds(paths);
    if (isEmpty(b)) return undefined;
    return {
        paths: transformPaths(paths, translation(-b.minX, -b.minY)),
        width: b.maxX - b.minX,
        height: b.maxY - b.minY,
    };
}

/** What a body looks like from above / the front / the right at 1:1, hidden lines left out. */
export function bodyOutline(document: IDocument, bodyId: string, view: ModelView): SvgImport | undefined {
    const cache = new ViewGeometryCache((id) => resolveSource(document, id));
    const v = { ...newView(bodyId, view, 1, 0, 0), showHidden: false, showTangent: false };
    return geometryToImport(cache.geometryOf(v));
}

/** A face seen square on, from the side its normal points to: its outline and holes, 1:1. */
export function faceOutline(face: IShape, transform: Matrix4): SvgImport | undefined {
    const input = extractHlrInput(face, transform);
    const n: Vec3 = [0, 0, 0];
    for (let k = 0; k + 2 < input.normal.length; k += 3) {
        n[0] += input.normal[k];
        n[1] += input.normal[k + 1];
        n[2] += input.normal[k + 2];
    }
    if (Math.hypot(...n) < 1e-9) return undefined;
    const w = normalize(n);
    const helper: Vec3 = Math.abs(w[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    // u across, v up the view, w = u × v towards the viewer
    const u = normalize(cross(helper, w));
    const v = cross(w, u);
    const geometry = computeViewGeometry(input, basisOf(u, v), { hidden: false, tangent: true });
    return geometryToImport(geometry);
}

/** A drawing sheet through the SVG exporter and back in: everything on it, at true size. */
export function drawingSheet(document: IDocument, node: DrawingNode, page = 0): SvgImport | undefined {
    const data = node.data;
    const cache = new ViewGeometryCache((id) => resolveSource(document, id));
    const sheet = composeDrawing(data, cache.all(data), page);
    // the white paper behind the sheet is not a line to burn
    const svg = sheetToSvg(sheet).replace(/<rect x="0" y="0" [^>]*fill="#fff"\/>/, "");
    return importSvg(svg);
}
