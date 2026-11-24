// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type CommandKeys, CommandStore, type I18nKeys, Localize, PubSub } from "@chili3d/core";
import { createIcon, div, span } from "@chili3d/element";
import style from "./ribbon.module.css";

/**
 * «Файл ▾» in the title bar: everything about files in one list with words, not only icons —
 * new, open, save, and the import / export of STL, STEP, IGES, BREP with the formats named.
 */
const ITEMS: ({ key: CommandKeys; hint?: I18nKeys } | "split")[] = [
    { key: "doc.new" },
    { key: "doc.open" },
    { key: "doc.save" },
    { key: "doc.saveToFile" },
    "split",
    { key: "file.import", hint: "fileMenu.import.hint" },
    { key: "file.export", hint: "fileMenu.export.hint" },
];

export function FileMenu(): HTMLElement {
    const list = div({ className: style.fileMenuList });
    list.hidden = true;
    const close = () => {
        list.hidden = true;
        document.removeEventListener("pointerdown", outside, true);
    };
    const outside = (e: Event) => {
        if (!root.contains(e.target as Node)) close();
    };
    for (const item of ITEMS) {
        if (item === "split") {
            list.append(div({ className: style.fileMenuSplit }));
            continue;
        }
        const data = CommandStore.getComandData(item.key);
        if (data === undefined) continue;
        const icon = createIcon(data.icon);
        icon.classList.add(style.fileMenuIcon);
        list.append(
            div(
                {
                    className: style.fileMenuItem,
                    onclick: () => {
                        close();
                        PubSub.default.pub("executeCommand", item.key);
                    },
                },
                icon,
                div(
                    { className: style.fileMenuText },
                    span({ textContent: new Localize(`command.${item.key}` as I18nKeys) }),
                    ...(item.hint
                        ? [span({ className: style.fileMenuHint, textContent: new Localize(item.hint) })]
                        : []),
                ),
            ),
        );
    }
    const button = div(
        {
            className: style.fileMenuButton,
            onclick: () => {
                list.hidden = !list.hidden;
                if (!list.hidden) document.addEventListener("pointerdown", outside, true);
                else close();
            },
        },
        span({ textContent: new Localize("fileMenu.title") }),
        span({ textContent: " ▾" }),
    );
    const root = div({ className: style.fileMenu }, button, list);
    return root;
}
