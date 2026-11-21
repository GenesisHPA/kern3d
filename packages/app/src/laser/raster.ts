// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { DitherKind, RasterSettings } from "./laserData";

/** Lightness per pixel, 0 = black … 1 = white, rows from the top of the picture. */
export interface GrayImage {
    width: number;
    height: number;
    data: Float32Array;
}

/** RGBA bytes (canvas `ImageData`) to lightness; transparent counts as white (nothing to burn). */
export function grayFromRgba(rgba: ArrayLike<number>, width: number, height: number): GrayImage {
    const data = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
        const a = rgba[i * 4 + 3] / 255;
        const luma = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255;
        data[i] = luma * a + (1 - a);
    }
    return { width, height, data };
}

/**
 * The picture resampled to `width` × `height` by area averaging (each target pixel the mean of
 * the source it covers), so a reduction keeps the tones and an enlargement repeats pixels.
 */
export function resampleGray(image: GrayImage, width: number, height: number): GrayImage {
    if (width === image.width && height === image.height) return { ...image, data: image.data.slice() };
    const data = new Float32Array(width * height);
    const fx = image.width / width;
    const fy = image.height / height;
    for (let ty = 0; ty < height; ty++) {
        const y0 = ty * fy;
        const y1 = y0 + fy;
        for (let tx = 0; tx < width; tx++) {
            const x0 = tx * fx;
            const x1 = x0 + fx;
            let sum = 0;
            let area = 0;
            for (let sy = Math.floor(y0); sy < Math.min(image.height, Math.ceil(y1)); sy++) {
                const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
                for (let sx = Math.floor(x0); sx < Math.min(image.width, Math.ceil(x1)); sx++) {
                    const w = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
                    sum += image.data[sy * image.width + sx] * w;
                    area += w;
                }
            }
            data[ty * width + tx] = area > 0 ? sum / area : 1;
        }
    }
    return { width, height, data };
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Brightness, contrast, gamma and invert, in that order, on a copy. */
export function adjustGray(
    image: GrayImage,
    s: Pick<RasterSettings, "brightness" | "contrast" | "gamma" | "invert">,
) {
    const data = new Float32Array(image.data.length);
    const c = Math.max(-99.9, Math.min(100, s.contrast)) / 100;
    // contrast as a slope about mid-grey: −100 flattens everything to grey, +100 doubles the slope
    const slope = 1 + c;
    const gamma = s.gamma > 0 ? s.gamma : 1;
    for (let i = 0; i < data.length; i++) {
        let v = image.data[i] + s.brightness / 100;
        v = (v - 0.5) * slope + 0.5;
        v = clamp01(v) ** gamma;
        data[i] = s.invert ? 1 - v : v;
    }
    return { width: image.width, height: image.height, data };
}

/** Error-diffusion kernels: [dx, dy, weight] with the weights' sum. */
const KERNELS: Record<DitherKind, { taps: [number, number, number][]; sum: number }> = {
    floyd: {
        taps: [
            [1, 0, 7],
            [-1, 1, 3],
            [0, 1, 5],
            [1, 1, 1],
        ],
        sum: 16,
    },
    jarvis: {
        taps: [
            [1, 0, 7],
            [2, 0, 5],
            [-2, 1, 3],
            [-1, 1, 5],
            [0, 1, 7],
            [1, 1, 5],
            [2, 1, 3],
            [-2, 2, 1],
            [-1, 2, 3],
            [0, 2, 5],
            [1, 2, 3],
            [2, 2, 1],
        ],
        sum: 48,
    },
};

/**
 * 1-bit burn mask by error diffusion (Floyd–Steinberg or Jarvis–Judice–Ninke), scanned left to
 * right on every row so the result is the same each time: 1 = burn (dark), 0 = leave.
 */
export function dither(image: GrayImage, kind: DitherKind): Uint8Array {
    const { width, height } = image;
    const work = Float32Array.from(image.data);
    const out = new Uint8Array(width * height);
    const { taps, sum } = KERNELS[kind];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const old = work[i];
            const white = old >= 0.5 ? 1 : 0;
            out[i] = 1 - white;
            const error = old - white;
            for (const [dx, dy, w] of taps) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || nx >= width || ny >= height) continue;
                work[ny * width + nx] += (error * w) / sum;
            }
        }
    }
    return out;
}

/**
 * The power of each pixel as a fraction of the layer's power (0 = laser off): what the line
 * generator burns. Grayscale scales with darkness between `minPower` and full, skipping the
 * near-white; threshold and dither are on/off.
 */
export function powerMap(image: GrayImage, s: RasterSettings): Float32Array {
    const adjusted = adjustGray(image, s);
    const n = adjusted.data.length;
    const out = new Float32Array(n);
    if (s.mode === "dither") {
        const mask = dither(adjusted, s.dither);
        for (let i = 0; i < n; i++) out[i] = mask[i];
        return out;
    }
    if (s.mode === "threshold") {
        const t = s.threshold / 100;
        for (let i = 0; i < n; i++) out[i] = adjusted.data[i] < t ? 1 : 0;
        return out;
    }
    const white = 1 - Math.max(0, s.whiteClip) / 100;
    const min = clamp01(s.minPower / 100);
    for (let i = 0; i < n; i++) {
        const v = adjusted.data[i];
        out[i] = v >= white && v > 0 ? 0 : min + (1 - min) * (1 - v);
    }
    return out;
}
