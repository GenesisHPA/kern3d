// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type CommandData, type CommandKeys, CommandStore, I18n, type I18nKeys, PubSub } from "@chili3d/core";
import { createIcon, div, input, span } from "@chili3d/element";
import { glyph } from "../glyphs";
import { shortcutText } from "../toolbar/commandItems";
import style from "./commandAccess.module.css";

const PIN_STORAGE_KEY = "chili3d.toolbox.pins";
const DEFAULT_PINS: CommandKeys[] = [
    "sketch.create",
    "feature.extrude",
    "feature.fillet",
    "modify.moveCopy",
    "measure.length",
];
/** Commands that only mean something as a key (repeat) are left out of the list. */
const HIDDEN: ReadonlySet<string> = new Set(["special.last"]);
/**
 * Where a command lives, shown beside its name: the same word ("Fillet") names a sketch tool, a
 * feature and a direct edit, and the tag tells them apart.
 */
const PREFIX_TAGS: Record<string, I18nKeys> = {
    sketch: "ribbon.tab.sketch",
    constraint: "ribbon.tab.sketch",
    dimension: "ribbon.tab.sketch",
    feature: "ribbon.tab.parametric",
    create: "ribbon.tab.basic",
    modify: "ribbon.tab.basic",
    convert: "ribbon.tab.basic",
    boolean: "ribbon.tab.basic",
    drawing: "ribbon.tab.drawing",
};

export function commandTag(key: string): I18nKeys | undefined {
    return PREFIX_TAGS[key.split(".")[0]];
}

function loadPins(): CommandKeys[] {
    try {
        const raw = globalThis.localStorage?.getItem(PIN_STORAGE_KEY);
        const pins = raw ? (JSON.parse(raw) as unknown) : undefined;
        return Array.isArray(pins)
            ? (pins.filter((p) => typeof p === "string") as CommandKeys[])
            : DEFAULT_PINS;
    } catch {
        return DEFAULT_PINS;
    }
}

function savePins(pins: CommandKeys[]) {
    try {
        globalThis.localStorage?.setItem(PIN_STORAGE_KEY, JSON.stringify(pins));
    } catch {
        // a blocked storage only forgets the pins
    }
}

export interface ToolboxEntry {
    readonly data: CommandData;
    readonly name: string;
}

/**
 * The commands matching `query`, best first: a name starting with it, then a word of the name
 * starting with it, then any match of the name or the command key. Case-insensitive.
 */
export function searchCommands(entries: readonly ToolboxEntry[], query: string): ToolboxEntry[] {
    const q = query.trim().toLowerCase();
    if (q === "") return [...entries].sort((a, b) => a.name.localeCompare(b.name));
    const scored: [number, ToolboxEntry][] = [];
    for (const entry of entries) {
        const name = entry.name.toLowerCase();
        let score = -1;
        if (name.startsWith(q)) score = 0;
        else if (name.split(/[\s\-/(]+/).some((word) => word.startsWith(q))) score = 1;
        else if (name.includes(q) || entry.data.key.toLowerCase().includes(q)) score = 2;
        if (score >= 0) scored.push([score, entry]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).map(([, e]) => e);
}

/**
 * The "S" toolbox: a search box at the pointer over every registered command, filtered by the
 * localized name as it is typed. Up/Down move, Enter runs, Esc closes; a row's pin keeps the
 * command at the top of the empty search (remembered per browser).
 */
export class CommandToolbox {
    private panel?: HTMLElement;
    private box?: HTMLInputElement;
    private list?: HTMLElement;
    private results: ToolboxEntry[] = [];
    private cursor = 0;
    private pins = loadPins();
    private pointer = { x: window.innerWidth / 2, y: window.innerHeight / 3 };

    constructor() {
        window.addEventListener("keydown", this.onWindowKey, true);
        window.addEventListener("pointermove", this.onPointerMove, true);
    }

    dispose() {
        this.close();
        window.removeEventListener("keydown", this.onWindowKey, true);
        window.removeEventListener("pointermove", this.onPointerMove, true);
    }

    get isOpen() {
        return this.panel !== undefined;
    }

    private readonly onPointerMove = (e: PointerEvent) => {
        this.pointer = { x: e.clientX, y: e.clientY };
    };

    /** S with no modifier, outside a text box, opens it; the key never reaches the shortcuts. */
    private readonly onWindowKey = (e: KeyboardEvent) => {
        if (this.isOpen || e.ctrlKey || e.altKey || e.metaKey || e.key.toLowerCase() !== "s") return;
        const target = e.target as HTMLElement | null;
        if (
            target &&
            (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        ) {
            return;
        }
        if (document.querySelector("dialog[open]")) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.open(this.pointer.x, this.pointer.y);
    };

    private entries(): ToolboxEntry[] {
        return CommandStore.getAllCommands()
            .filter((data) => !HIDDEN.has(data.key))
            .map((data) => ({ data, name: I18n.translate(`command.${data.key}`) }));
    }

    open(x: number, y: number) {
        this.close();
        this.box = input({
            className: style.toolboxInput,
            placeholder: I18n.translate("toolbox.placeholder"),
        });
        this.box.addEventListener("input", () => this.update());
        this.box.addEventListener("keydown", this.onBoxKey);
        this.list = div({ className: style.toolboxList });
        this.panel = div(
            { className: style.toolbox },
            div({ className: style.toolboxSearch }, createIcon("icon-search"), this.box),
            this.list,
            div({ className: style.toolboxHint, textContent: I18n.translate("toolbox.hint") }),
        );
        const width = 340;
        this.panel.style.left = `${Math.max(8, Math.min(x - 30, window.innerWidth - width - 8))}px`;
        this.panel.style.top = `${Math.max(8, Math.min(y - 20, window.innerHeight - 420))}px`;
        document.body.append(this.panel);
        document.addEventListener("pointerdown", this.onOutside, true);
        this.update();
        this.box.focus();
    }

    close() {
        this.panel?.remove();
        this.panel = undefined;
        this.box = undefined;
        this.list = undefined;
        document.removeEventListener("pointerdown", this.onOutside, true);
    }

    private readonly onOutside = (e: PointerEvent) => {
        if (this.panel && !this.panel.contains(e.target as Node)) this.close();
    };

    private update() {
        if (!this.list || !this.box) return;
        const all = this.entries();
        const query = this.box.value;
        const rows: HTMLElement[] = [];
        let pinnedCount = 0;
        if (query.trim() === "") {
            const pinned = this.pins
                .map((key) => all.find((entry) => entry.data.key === key))
                .filter((entry): entry is ToolboxEntry => entry !== undefined);
            pinnedCount = pinned.length;
            if (pinnedCount > 0) {
                rows.push(
                    div({ className: style.toolboxHeader, textContent: I18n.translate("toolbox.pinned") }),
                );
            }
            this.results = [...pinned, ...searchCommands(all, "").filter((e) => !pinned.includes(e))];
        } else {
            this.results = searchCommands(all, query);
        }
        this.cursor = 0;
        this.results.forEach((entry, index) => {
            if (index === pinnedCount && pinnedCount > 0) rows.push(div({ className: style.toolboxDivider }));
            rows.push(this.row(entry, index));
        });
        if (this.results.length === 0) {
            rows.push(div({ className: style.toolboxEmpty, textContent: I18n.translate("toolbox.empty") }));
        }
        this.list.replaceChildren(...rows);
        this.markCursor();
    }

    private row(entry: ToolboxEntry, index: number) {
        const icon = createIcon(entry.data.icon);
        icon.classList.add(style.toolboxIcon);
        const pinned = this.pins.includes(entry.data.key);
        const pin = div({
            className: pinned ? `${style.toolboxPin} ${style.pinned}` : style.toolboxPin,
            title: I18n.translate(pinned ? "toolbox.unpin" : "toolbox.pin"),
            onclick: (e) => {
                e.stopPropagation();
                this.togglePin(entry.data.key);
            },
        });
        pin.append(glyph("pin"));
        const row = div(
            {
                className: style.toolboxRow,
                onclick: () => this.run(entry),
                onpointerenter: () => {
                    this.cursor = index;
                    this.markCursor();
                },
            },
            icon,
            span({ className: style.toolboxName, textContent: entry.name }),
            span({ className: style.toolboxTag, textContent: this.tagOf(entry) }),
            span({ className: style.toolboxShortcut, textContent: shortcutText(entry.data.key) ?? "" }),
            pin,
        );
        row.dataset["command"] = entry.data.key;
        row.dataset["index"] = `${index}`;
        return row;
    }

    private tagOf(entry: ToolboxEntry): string {
        const tag = commandTag(entry.data.key);
        return tag === undefined ? "" : I18n.translate(tag);
    }

    private togglePin(key: CommandKeys) {
        this.pins = this.pins.includes(key) ? this.pins.filter((p) => p !== key) : [...this.pins, key];
        savePins(this.pins);
        this.update();
    }

    private markCursor() {
        this.list?.querySelectorAll(`.${style.toolboxRow}`).forEach((row) => {
            const active = (row as HTMLElement).dataset["index"] === `${this.cursor}`;
            row.classList.toggle(style.current, active);
            if (active) (row as HTMLElement).scrollIntoView?.({ block: "nearest" });
        });
    }

    private readonly onBoxKey = (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === "Escape") {
            this.close();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            this.cursor = Math.max(0, Math.min(this.results.length - 1, this.cursor + step));
            this.markCursor();
        } else if (e.key === "Enter") {
            e.preventDefault();
            const entry = this.results[this.cursor];
            if (entry) this.run(entry);
        }
    };

    private run(entry: ToolboxEntry) {
        this.close();
        PubSub.default.pub("executeCommand", entry.data.key);
    }
}
