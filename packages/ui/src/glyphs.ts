// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createIcon } from "@chili3d/element";

/**
 * Small line glyphs of the app chrome (toolbar, timeline, navigation bar) that the icon font
 * has no symbol for. Drawn on a 16-unit grid in `currentColor`, so they follow the theme.
 */
const PATHS = {
    chevronDown: "M4 6l4 4 4-4",
    toStart: "M4 3v10M12 3 6 8l6 5z",
    stepBack: "M11 3 5 8l6 5z",
    stepForward: "M5 3l6 5-6 5z",
    toEnd: "M12 3v10M4 3l6 5-6 5z",
    orbit: "M8 2.5a5.5 5.5 0 1 1-5.2 3.7M2.5 2.8v3.4h3.4M8 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3",
    pan: "M8 1.5v13M1.5 8h13M8 1.5 6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2",
    zoom: "M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM10.3 10.3l3.7 3.7M5 7h4M7 5v4",
    fit: "M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5M5.5 5.5h5v5h-5z",
    grid: "M2 2h12v12H2zM2 6h12M2 10h12M6 2v12M10 2v12",
    section: "M2.5 5 8 2l5.5 3v6L8 14l-5.5-3zM2.5 5 8 8l5.5-3M8 8v6M1 9.5l14-3",
    display: "M2.5 5 8 2l5.5 3v6L8 14l-5.5-3zM2.5 5 8 8l5.5-3M8 8v6",
    design: "M2.5 5 8 2l5.5 3v6L8 14l-5.5-3zM2.5 5 8 8l5.5-3M8 8v6",
    drawing: "M3 1.5h7l3 3v10H3zM10 1.5v3h3M5 8h6M5 10.5h6M5 5.5h3",
    pin: "M6 2h4l-.5 4 2.5 2.5H4L6.5 6zM8 8.5V14",
    plane: "M1.5 10 6 4h8.5L10 10z",
    document: "M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3",
    feature: "M3 3h10v10H3z",
    eye: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4",
} as const;

export type GlyphName = keyof typeof PATHS;

/** Glyphs drawn solid; the rest are outlines. */
const FILLED = new Set<GlyphName>(["toStart", "stepBack", "stepForward", "toEnd"]);

export function glyph(name: GlyphName, className?: string): Element {
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
        'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' +
        // The fill sits on the path: the app's global `svg { fill: currentColor }` would win
        // over an attribute on the <svg> itself.
        `<path d="${PATHS[name]}" fill="${FILLED.has(name) ? "currentColor" : "none"}"/></svg>`;
    const element = createIcon({ type: "svg", value: svg });
    if (className) element.classList.add(className);
    return element;
}
