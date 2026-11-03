// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandKeys,
    CommandStore,
    Config,
    formatShortcutKey,
    I18n,
    ObservableCollection,
    type PushButton,
    type RibbonButton,
    type RibbonCommand,
    type RibbonGroup,
    ShortcutProfiles,
} from "@chili3d/core";

/** One runnable entry of a group: a registered command, or a push button with its own click. */
export type CommandEntry = PushButton | CommandKeys;

export function entryKey(entry: CommandEntry): CommandKeys {
    return typeof entry === "string" ? entry : entry.command;
}

function buttonEntries(button: RibbonButton): CommandEntry[] {
    if (typeof button === "string") return [button];
    if (button.type === "push") return [button];
    return [...button.items];
}

function itemEntries(item: RibbonCommand): CommandEntry[] {
    if (item instanceof ObservableCollection) return Array.from(item).flatMap(buttonEntries);
    return buttonEntries(item);
}

/**
 * Every command of a group in ribbon order — its items, stacks and split buttons opened up,
 * then the collapsed ones — each once. This is the group's dropdown: the toolbar shows only a
 * few of them as icons, so the list is what keeps every command of the group reachable.
 */
export function groupEntries(group: RibbonGroup): CommandEntry[] {
    const seen = new Set<CommandKeys>();
    const result: CommandEntry[] = [];
    const add = (entry: CommandEntry) => {
        const key = entryKey(entry);
        if (seen.has(key)) return;
        seen.add(key);
        result.push(entry);
    };
    group.items.forEach((item) => itemEntries(item).forEach(add));
    group.collapsedItems.forEach(add);
    return result;
}

/**
 * The commands a group shows as icons: its top-level single buttons (a stack is the ribbon's
 * column of small, secondary buttons) — a split or pulldown button by its first command —
 * capped at `max`.
 */
export function primaryEntries(group: RibbonGroup, max: number): CommandEntry[] {
    const result: CommandEntry[] = [];
    for (const item of group.items) {
        if (result.length >= max) break;
        if (item instanceof ObservableCollection) continue;
        const first = buttonEntries(item)[0];
        if (first !== undefined && CommandStore.getComandData(entryKey(first)) !== undefined) {
            result.push(first);
        }
    }
    return result;
}

/**
 * The icons of a group the user arranged: the saved commands, in their order, that the group
 * still has and that are registered. A saved command the group no longer has is skipped.
 */
export function arrangedEntries(group: RibbonGroup, commands: readonly CommandKeys[]): CommandEntry[] {
    const all = groupEntries(group);
    const result: CommandEntry[] = [];
    for (const command of commands) {
        const entry = all.find((x) => entryKey(x) === command);
        if (entry !== undefined && CommandStore.getComandData(command) !== undefined) result.push(entry);
    }
    return result;
}

/** The shortcut of a command under the active navigation profile, as shown to the user. */
export function shortcutText(command: CommandKeys): string | undefined {
    const spec = ShortcutProfiles[Config.instance.navigation3D][command];
    if (spec === undefined) return undefined;
    const first = Array.isArray(spec) ? spec[0] : spec;
    return first === undefined || first.trim() === "" ? undefined : formatShortcutKey(first);
}

/** The localized name of a command, or its key when it has no translation. */
export function commandName(entry: CommandEntry): string {
    if (typeof entry !== "string" && entry.display !== undefined) return I18n.translate(entry.display);
    return I18n.translate(`command.${entryKey(entry)}` as never);
}

/** Runs an entry the way its ribbon button would. */
export function runEntry(entry: CommandEntry, publish: (command: CommandKeys) => void): void {
    if (typeof entry === "string") publish(entry);
    else entry.onClick();
}
