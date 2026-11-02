// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { BoundingBox, type IShape } from "@chili3d/core";

/** Overlaps smaller than this (mm³) are touching faces or kernel noise, not interference. */
export const MIN_INTERFERENCE_VOLUME = 1e-4;

export interface Interference {
    /** Indices into the shapes handed in, `first < second`. */
    first: number;
    second: number;
    /** mm³ */
    volume: number;
    /** The common solid — the caller shows it and disposes it. */
    overlap: IShape;
}

/**
 * Every pair of shapes whose solids share volume, with the shared solid (a boolean common).
 * Pairs whose bounding boxes miss each other are skipped before the kernel is asked. Shapes
 * must already be in world space; none of them is changed.
 */
export function findInterferences(shapes: IShape[], minVolume = MIN_INTERFERENCE_VOLUME): Interference[] {
    const boxes = shapes.map((shape) => shape.boundingBox());
    const result: Interference[] = [];
    for (let i = 0; i < shapes.length; i++) {
        for (let j = i + 1; j < shapes.length; j++) {
            if (!BoundingBox.isIntersect(boxes[i], boxes[j])) continue;
            const overlap = commonOf(shapes[i], shapes[j], minVolume);
            if (overlap) result.push({ first: i, second: j, ...overlap });
        }
    }
    return result;
}

function commonOf(a: IShape, b: IShape, minVolume: number) {
    const common = shapeFactory.booleanCommon([a], [b]);
    if (!common.isOk) return undefined;
    const volume = Math.abs(common.value.volume());
    if (volume < minVolume) {
        common.value.dispose();
        return undefined;
    }
    return { volume, overlap: common.value };
}
