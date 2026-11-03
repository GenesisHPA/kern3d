// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CommandKeys } from "@chili3d/core";

const STORAGE_KEY = "chili3d.toolbarLayout.v1";

type Layout = Record<string, CommandKeys[]>;

/**
 * The user's arrangement of the toolbar: for a group (keyed by tab and group name) the
 * commands it shows as icons, in order. A group the user never rearranged has no entry and
 * keeps the ribbon profile's icons. Kept in the browser's storage, so it is per viewer; a
 * storage that is missing or throws only means the default layout.
 */
export class ToolbarLayout {
    private static cache: Layout | undefined;

    static key(tabName: string, groupName: string): string {
        return `${tabName}|${groupName}`;
    }

    private static load(): Layout {
        if (ToolbarLayout.cache) return ToolbarLayout.cache;
        let layout: Layout = {};
        try {
            const text = globalThis.localStorage?.getItem(STORAGE_KEY);
            const parsed = text ? JSON.parse(text) : undefined;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                for (const [key, value] of Object.entries(parsed)) {
                    if (Array.isArray(value)) {
                        layout[key] = value.filter((x): x is CommandKeys => typeof x === "string");
                    }
                }
            }
        } catch {
            layout = {};
        }
        ToolbarLayout.cache = layout;
        return layout;
    }

    private static save(layout: Layout) {
        ToolbarLayout.cache = layout;
        try {
            globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(layout));
        } catch {
            // the layout still holds for this session
        }
    }

    static get(key: string): CommandKeys[] | undefined {
        const value = ToolbarLayout.load()[key];
        return value ? [...value] : undefined;
    }

    static set(key: string, commands: CommandKeys[]) {
        ToolbarLayout.save({ ...ToolbarLayout.load(), [key]: [...new Set(commands)] });
    }

    static reset(key: string) {
        const layout = { ...ToolbarLayout.load() };
        delete layout[key];
        ToolbarLayout.save(layout);
    }

    /** Forgets the cached copy, so the next read comes from storage (tests). */
    static clearCache() {
        ToolbarLayout.cache = undefined;
    }
}

/**
 * `commands` with `command` moved (or inserted) so it lands at `index` of the list as it was
 * before the move.
 */
export function moveCommand(commands: CommandKeys[], command: CommandKeys, index: number): CommandKeys[] {
    const from = commands.indexOf(command);
    const result = commands.filter((x) => x !== command);
    let to = from >= 0 && from < index ? index - 1 : index;
    to = Math.max(0, Math.min(to, result.length));
    result.splice(to, 0, command);
    return result;
}
