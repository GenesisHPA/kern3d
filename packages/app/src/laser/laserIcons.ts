// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { DrawTool } from "./laserDraw";

/**
 * The tool palette's icons: 24 × 24 line drawings in the current colour, one stroke weight,
 * drawn for this palette (no icon font, nothing fetched).
 */
const ICONS: Record<DrawTool | "snap", string> = {
    // an arrow pointer
    select: '<path d="M6 3.5 L6 18.5 L10 14.6 L12.8 20.5 L15.2 19.4 L12.5 13.6 L18 13.4 Z" fill="currentColor" fill-opacity="0.15"/>',
    // a node with its two handles on a curve
    nodes:
        '<path d="M3.5 18 C7 6, 17 6, 20.5 18"/><path d="M5 9.5 L19 9.5" stroke-dasharray="2 2"/>' +
        '<rect x="10" y="7.5" width="4" height="4" fill="currentColor"/>' +
        '<circle cx="5" cy="9.5" r="1.6" fill="currentColor"/><circle cx="19" cy="9.5" r="1.6" fill="currentColor"/>',
    line: '<path d="M4 19 L10 9 L15 15 L20 5"/><circle cx="4" cy="19" r="1.5" fill="currentColor"/><circle cx="10" cy="9" r="1.5" fill="currentColor"/><circle cx="15" cy="15" r="1.5" fill="currentColor"/><circle cx="20" cy="5" r="1.5" fill="currentColor"/>',
    // a pen nib
    curve: '<path d="M12 3 L17.5 12 L14.5 20 L9.5 20 L6.5 12 Z"/><path d="M12 3 L12 12.5"/><circle cx="12" cy="13.5" r="1.4"/><path d="M9 22 L15 22"/>',
    // a pencil
    pencil: '<path d="M4 20 L5 15.5 L16 4.5 L19.5 8 L8.5 19 Z"/><path d="M13.8 6.7 L17.3 10.2"/><path d="M5 15.5 L8.5 19"/>',
    rect: '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
    polygon:
        '<path d="M12 3.2 L14.4 9 L20.6 9.4 L15.8 13.4 L17.3 19.5 L12 16.2 L6.7 19.5 L8.2 13.4 L3.4 9.4 L9.6 9 Z"/>',
    text: '<path d="M5 6 L5 4 L19 4 L19 6"/><path d="M12 4 L12 20"/><path d="M9 20 L15 20"/>',
    // a QR-like code
    barcode:
        '<rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/>' +
        '<rect x="6" y="6" width="2" height="2" fill="currentColor"/><rect x="16" y="6" width="2" height="2" fill="currentColor"/>' +
        '<rect x="6" y="16" width="2" height="2" fill="currentColor"/>' +
        '<path d="M14 14 L16 14 M18 14 L20 14 M14 17 L17 17 M19 17 L20 17 M14 20 L15 20 M17 20 L20 20"/>',
    // a grid with a point caught on it
    snap:
        '<path d="M4 8 L20 8 M4 16 L20 16 M8 4 L8 20 M16 4 L16 20" stroke-opacity="0.55"/>' +
        '<circle cx="16" cy="16" r="2.6" fill="currentColor"/>',
};

export function toolIcon(tool: DrawTool | "snap"): string {
    return (
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
        `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[tool]}</svg>`
    );
}
