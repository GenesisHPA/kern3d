// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, type I18nKeys, Localize } from "@chili3d/core";
import { div, input, label, span } from "@chili3d/element";

/** The scan-to-CAD tools' switches, in ribbon order: the `Config` flag and its label. */
export const SCAN_TOOL_SETTINGS = [
    { key: "scanSectionSketch", display: "settings.scan.sectionSketch" },
    { key: "scanDeviationMap", display: "settings.scan.deviationMap" },
    { key: "scanFitRegion", display: "settings.scan.fitRegion" },
    { key: "scanPrepare", display: "settings.scan.prepare" },
] as const satisfies readonly { key: keyof Config; display: I18nKeys }[];

/**
 * «Инструменты сканов / сетки»: one checkbox per tool, each a `Config` flag (saved with the
 * other settings). Off hides the tool's ribbon buttons and refuses its command.
 */
export function ScanToolsSettings(classes: { group: string; title: string; row: string }): HTMLElement {
    return div(
        { className: classes.group },
        span({ className: classes.title, textContent: new Localize("settings.scan.title") }),
        ...SCAN_TOOL_SETTINGS.map(({ key, display }) => {
            const box = input({ type: "checkbox", checked: Config.instance[key] });
            box.dataset["setting"] = key;
            box.onchange = () => {
                Config.instance[key] = box.checked;
            };
            return label({ className: classes.row }, box, span({ textContent: new Localize(display) }));
        }),
    );
}
