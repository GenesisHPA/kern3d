// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FontCatalog, type FontOutline, Logger, outlineFor } from "@chili3d/core";

/**
 * The font a drawing's text is outlined in for PDF: Roboto, a small open font that covers
 * Latin and Cyrillic (the app's default Noto Sans SC would cost 17 MB for the same letters).
 * Fetched once per session through the text feature's font cache; undefined when unreachable.
 */
export async function loadDrawingFont(): Promise<FontOutline | undefined> {
    const font = FontCatalog.find((f) => f.family === "Roboto") ?? FontCatalog[0];
    const result = await outlineFor(font.family, font.url);
    if (result.isOk) return result.value;
    Logger.warn(`Drawing font unavailable: ${result.error}`);
    return undefined;
}
