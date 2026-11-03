// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandIcon,
    type CommandKeys,
    CommandStore,
    I18n,
    Localize,
    PubSub,
    type RibbonGroup,
} from "@chili3d/core";
import { createIcon, div, span } from "@chili3d/element";
import { glyph } from "../glyphs";
import { DropdownController } from "../ribbon/dropdownController";
import { RibbonPushButton } from "../ribbon/ribbonButton";
import {
    arrangedEntries,
    type CommandEntry,
    commandName,
    entryKey,
    groupEntries,
    primaryEntries,
    runEntry,
    shortcutText,
} from "./commandItems";
import style from "./toolbar.module.css";
import { moveCommand, ToolbarLayout } from "./toolbarLayout";

/** How many commands a group shows as icons by default; the rest live in its dropdown. */
export const MAX_PRIMARY_COMMANDS = 8;

/** The command being dragged on the toolbar and the group it may be dropped in. */
let dragged: { layoutKey: string; command: CommandKeys } | undefined;

const publish = (command: CommandKeys) => PubSub.default.pub("executeCommand", command);

function entryIcon(entry: CommandEntry): CommandIcon {
    if (typeof entry !== "string") return entry.icon as CommandIcon;
    return CommandStore.getComandData(entry)?.icon ?? "icon-history";
}

/** A toolbar icon for one command: the ribbon's own button, so toggles keep their binding. */
function iconButton(entry: CommandEntry): HTMLElement | undefined {
    if (typeof entry === "string") return RibbonPushButton.fromCommandName(entry, "large");
    return new RibbonPushButton(entry.command, entry.icon, "large", entry.onClick, entry.display);
}

/** One row of a group's dropdown (also used by the marking menu's context list). */
export function menuRow(entry: CommandEntry, onRun: () => void): HTMLElement {
    const icon = createIcon(entryIcon(entry));
    icon.classList.add(style.menuIcon);
    const shortcut = shortcutText(entryKey(entry));
    return div(
        {
            className: style.menuRow,
            dataset: { command: entryKey(entry) },
            onclick: (e) => {
                e.stopPropagation();
                onRun();
                runEntry(entry, publish);
            },
        },
        icon,
        span({ className: style.menuText, textContent: commandName(entry) }),
        span({ className: style.menuShortcut, textContent: shortcut ?? "" }),
    );
}

/**
 * A command group of the toolbar: its most used commands as icons above the group's name, and
 * the name opening a dropdown with every command of the group. A prominent group (the sketch's
 * "Finish") is one emphasised button instead.
 *
 * The icons can be rearranged: dragged among themselves, dragged in from the dropdown, or
 * shown and hidden with the dropdown's pins. The arrangement is saved per tab and group in
 * `ToolbarLayout`; "Reset" in the dropdown returns to the profile's icons.
 */
export class ToolbarGroup extends HTMLElement {
    readonly #dropdown = new DropdownController(style.menu);
    readonly layoutKey: string;

    /** `tabName` keys the user's arrangement: the same group name appears in several tabs. */
    constructor(
        readonly group: RibbonGroup,
        tabName = "",
    ) {
        super();
        this.layoutKey = ToolbarLayout.key(tabName, group.groupName);
        this.className = group.prominent ? `${style.group} ${style.prominent}` : style.group;
        this.render();
    }

    connectedCallback() {
        this.group.items.onCollectionChanged(this.render);
        this.group.collapsedItems.onCollectionChanged(this.render);
    }

    disconnectedCallback() {
        this.group.items.removeCollectionChanged(this.render);
        this.group.collapsedItems.removeCollectionChanged(this.render);
        this.#dropdown.close();
    }

    get isMenuOpen(): boolean {
        return this.#dropdown.isOpened;
    }

    private readonly render = () => {
        this.#dropdown.close();
        this.replaceChildren();
        if (this.group.prominent) {
            this.renderProminent();
            return;
        }
        const icons = div({ className: style.icons });
        this.setupDropZone(icons);
        this.iconEntries().forEach((entry, index) => {
            const button = iconButton(entry);
            if (button) icons.append(this.iconSlot(entry, index, button));
        });
        const header = div(
            {
                className: style.groupHeader,
                title: I18n.translate("toolbar.moreCommands"),
                onclick: (e) => {
                    e.stopPropagation();
                    this.toggleMenu();
                },
            },
            span({ className: style.groupName, textContent: new Localize(this.group.groupName) }),
            glyph("chevronDown", style.chevron),
        );
        this.append(icons, header);
    };

    /** The group's icons: the user's arrangement when there is one, else the profile's. */
    iconEntries(): CommandEntry[] {
        const saved = ToolbarLayout.get(this.layoutKey);
        if (saved !== undefined) return arrangedEntries(this.group, saved);
        return primaryEntries(this.group, MAX_PRIMARY_COMMANDS);
    }

    /** Places `command` among the icons at `index`, moving it when it is already there. */
    placeCommand(command: CommandKeys, index: number) {
        const current = this.iconEntries().map(entryKey);
        ToolbarLayout.set(this.layoutKey, moveCommand(current, command, index));
        this.render();
    }

    /** Shows `command` as an icon (at the end), or takes its icon away. */
    togglePinned(command: CommandKeys) {
        const current = this.iconEntries().map(entryKey);
        const next = current.includes(command) ? current.filter((x) => x !== command) : [...current, command];
        ToolbarLayout.set(this.layoutKey, next);
        this.render();
    }

    resetLayout() {
        ToolbarLayout.reset(this.layoutKey);
        this.render();
    }

    private canDrop() {
        return dragged !== undefined && dragged.layoutKey === this.layoutKey;
    }

    private startDrag(e: DragEvent, command: CommandKeys) {
        dragged = { layoutKey: this.layoutKey, command };
        e.dataTransfer?.setData("text/plain", command);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    }

    private endDrag() {
        dragged = undefined;
        this.querySelectorAll(`.${style.dropBefore}, .${style.dropAfter}, .${style.dragging}`).forEach((x) =>
            x.classList.remove(style.dropBefore, style.dropAfter, style.dragging),
        );
    }

    /** One draggable icon: a command dropped on its left or right half lands there. */
    private iconSlot(entry: CommandEntry, index: number, button: HTMLElement): HTMLElement {
        const command = entryKey(entry);
        const slot = div({ className: style.iconSlot, dataset: { iconCommand: command } }, button);
        slot.draggable = true;
        const isBefore = (e: DragEvent) => {
            const rect = slot.getBoundingClientRect();
            return e.clientX < rect.left + rect.width / 2;
        };
        slot.addEventListener("dragstart", (e) => {
            this.startDrag(e, command);
            slot.classList.add(style.dragging);
        });
        slot.addEventListener("dragend", () => this.endDrag());
        slot.addEventListener("dragover", (e) => {
            if (!this.canDrop()) return;
            e.preventDefault();
            e.stopPropagation();
            const before = isBefore(e);
            slot.classList.toggle(style.dropBefore, before);
            slot.classList.toggle(style.dropAfter, !before);
        });
        slot.addEventListener("dragleave", () => slot.classList.remove(style.dropBefore, style.dropAfter));
        slot.addEventListener("drop", (e) => {
            if (!this.canDrop()) return;
            e.preventDefault();
            e.stopPropagation();
            const moved = dragged!.command;
            this.endDrag();
            this.placeCommand(moved, isBefore(e) ? index : index + 1);
        });
        return slot;
    }

    /** The icon row also takes a drop on its free space (or while it is empty): at the end. */
    private setupDropZone(icons: HTMLElement) {
        icons.addEventListener("dragover", (e) => {
            if (!this.canDrop()) return;
            e.preventDefault();
            icons.classList.add(style.dropZone);
        });
        icons.addEventListener("dragleave", () => icons.classList.remove(style.dropZone));
        icons.addEventListener("drop", (e) => {
            icons.classList.remove(style.dropZone);
            if (!this.canDrop()) return;
            e.preventDefault();
            const moved = dragged!.command;
            this.endDrag();
            this.placeCommand(moved, Number.MAX_SAFE_INTEGER);
        });
    }

    private renderProminent() {
        for (const entry of groupEntries(this.group)) {
            const icon = createIcon(entryIcon(entry));
            icon.classList.add(style.prominentIcon);
            this.append(
                div(
                    {
                        className: style.prominentButton,
                        dataset: { command: entryKey(entry) },
                        title: commandName(entry),
                        onclick: () => runEntry(entry, publish),
                    },
                    icon,
                    span({ className: style.groupName, textContent: new Localize(this.group.groupName) }),
                ),
            );
        }
    }

    toggleMenu() {
        if (this.#dropdown.isOpened) {
            this.#dropdown.close();
            return;
        }
        const anchor = this.querySelector(`.${style.groupHeader}`) as HTMLElement | null;
        if (!anchor) return;
        let menu: HTMLElement | undefined;
        this.#dropdown.open(anchor, (dropdown) => {
            menu = dropdown;
            const pinned = new Set(this.iconEntries().map(entryKey));
            for (const entry of groupEntries(this.group)) {
                if (CommandStore.getComandData(entryKey(entry)) === undefined && typeof entry === "string") {
                    continue;
                }
                dropdown.append(this.menuEntry(entry, pinned.has(entryKey(entry))));
            }
            if (ToolbarLayout.get(this.layoutKey) !== undefined) {
                dropdown.append(
                    div({ className: style.menuSeparator }),
                    div(
                        {
                            className: `${style.menuRow} ${style.menuReset}`,
                            onclick: (e) => {
                                e.stopPropagation();
                                this.resetLayout();
                            },
                        },
                        span({
                            className: style.menuText,
                            textContent: I18n.translate("toolbar.resetLayout"),
                        }),
                    ),
                );
            }
        });
        // The controller sizes a dropdown to its anchor; a menu of names wants its own width.
        if (menu) menu.style.width = "";
    }

    /**
     * A dropdown row with a pin that shows or hides the command on the toolbar; the row can
     * also be dragged onto the group's icons.
     */
    private menuEntry(entry: CommandEntry, pinned: boolean): HTMLElement {
        const command = entryKey(entry);
        const row = menuRow(entry, () => this.#dropdown.close());
        const pin = div(
            {
                className: pinned ? `${style.menuPin} ${style.pinned}` : style.menuPin,
                title: I18n.translate(pinned ? "toolbar.unpinCommand" : "toolbar.pinCommand"),
                onclick: (e) => {
                    e.stopPropagation();
                    this.togglePinned(command);
                    this.toggleMenu();
                },
            },
            glyph("pin"),
        );
        row.append(pin);
        row.draggable = true;
        row.addEventListener("dragstart", (e) => this.startDrag(e, command));
        row.addEventListener("dragend", () => this.endDrag());
        return row;
    }
}

customElements.define("chili-toolbar-group", ToolbarGroup);
