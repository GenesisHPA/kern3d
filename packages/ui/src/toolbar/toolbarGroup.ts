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
    type CommandEntry,
    commandName,
    entryKey,
    groupEntries,
    primaryEntries,
    runEntry,
    shortcutText,
} from "./commandItems";
import style from "./toolbar.module.css";

/** How many commands a group shows as icons; the rest live in its dropdown. */
export const MAX_PRIMARY_COMMANDS = 4;

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
 */
export class ToolbarGroup extends HTMLElement {
    readonly #dropdown = new DropdownController(style.menu);

    constructor(readonly group: RibbonGroup) {
        super();
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
        for (const entry of primaryEntries(this.group, MAX_PRIMARY_COMMANDS)) {
            const button = iconButton(entry);
            if (button) icons.append(button);
        }
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
            for (const entry of groupEntries(this.group)) {
                if (CommandStore.getComandData(entryKey(entry)) === undefined && typeof entry === "string") {
                    continue;
                }
                dropdown.append(menuRow(entry, () => this.#dropdown.close()));
            }
        });
        // The controller sizes a dropdown to its anchor; a menu of names wants its own width.
        if (menu) menu.style.width = "";
    }
}

customElements.define("chili-toolbar-group", ToolbarGroup);
