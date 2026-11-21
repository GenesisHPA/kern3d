// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    cachedOutline,
    FontCatalog,
    type FontOutline,
    hasLocalFontAccess,
    type LocalFontEntry,
    listLocalFonts,
    outlineFor,
    parseFont,
    rememberOutline,
} from "@chili3d/core";
import type { LaserFontRef } from "./shapes";

/**
 * The fonts a laser text can be set in: the app's catalogue (open fonts fetched once a session)
 * and, where the browser lets a page list them (Chrome, Edge, the desktop app), the fonts
 * installed on this computer. Roboto by default: small, and it has Latin and Cyrillic.
 */

const LOCAL_URL = "local:";

export function defaultLaserFont(): LaserFontRef {
    const roboto = FontCatalog.find((f) => f.family === "Roboto") ?? FontCatalog[0];
    return { family: roboto.family, url: roboto.url };
}

export function catalogFonts(): LaserFontRef[] {
    return FontCatalog.map((f) => ({ family: f.family, url: f.url }));
}

let localList: Promise<LocalFontEntry[]> | undefined;

function localFonts(): Promise<LocalFontEntry[]> {
    localList ??= listLocalFonts().then((r) => (r.isOk ? r.value : []));
    return localList;
}

/** The installed families, one each (the browser asks the user once for the permission). */
export async function localFontFamilies(): Promise<LaserFontRef[]> {
    if (!hasLocalFontAccess()) return [];
    const seen = new Set<string>();
    const out: LaserFontRef[] = [];
    for (const f of await localFonts()) {
        if (seen.has(f.family)) continue;
        seen.add(f.family);
        out.push({ family: f.family, local: true });
    }
    return out;
}

export function localFontsAvailable(): boolean {
    return hasLocalFontAccess();
}

/** The upright regular face of a family, or whatever face it has. */
function regularFace(entries: LocalFontEntry[], family: string): LocalFontEntry | undefined {
    const faces = entries.filter((e) => e.family === family);
    return (
        faces.find((e) => /^(regular|normal|book|roman)$/i.test(e.style)) ??
        faces.find((e) => !/italic|oblique|bold|black|light|thin/i.test(e.style)) ??
        faces[0]
    );
}

/** The font's outlines: from this session's memory, the catalogue's address or the system. */
export async function loadLaserFont(ref: LaserFontRef): Promise<FontOutline | undefined> {
    if (ref.local) {
        const known = cachedOutline(ref.family, LOCAL_URL);
        if (known !== undefined) return known;
        const face = regularFace(await localFonts(), ref.family);
        if (face === undefined) return undefined;
        try {
            const parsed = await parseFont(await face.read(), ref.family);
            if (!parsed.isOk) return undefined;
            rememberOutline(ref.family, LOCAL_URL, parsed.value);
            return parsed.value;
        } catch {
            return undefined;
        }
    }
    const url = ref.url ?? FontCatalog.find((f) => f.family === ref.family)?.url ?? "";
    const result = await outlineFor(ref.family, url);
    return result.isOk ? result.value : undefined;
}
