// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type IDocument, type INode, Transaction } from "@chili3d/core";
import { div, span } from "@chili3d/element";
import toolbarStyle from "../toolbar/toolbar.module.css";
import { menuRow } from "../toolbar/toolbarGroup";
import style from "./commandAccess.module.css";

let openMenu: { overlay: HTMLElement; onKey: (e: KeyboardEvent) => void } | undefined;

/** Closes the tree's context menu, if one is open. */
export function closeNodeContextMenu() {
    if (openMenu === undefined) return;
    openMenu.overlay.remove();
    window.removeEventListener("keydown", openMenu.onKey, true);
    openMenu = undefined;
}

/**
 * The right-click menu of a model-tree row: the node is selected first, then the commands that
 * apply to it (the same list the canvas menu shows under its wedges, e.g. «Edit sketch»,
 * «Extrude», «Delete» for a sketch) and a show/hide row. A click outside or Esc closes it.
 */
export function openNodeContextMenu(
    document: IDocument,
    node: INode,
    commands: readonly Parameters<typeof menuRow>[0][],
    x: number,
    y: number,
) {
    closeNodeContextMenu();
    document.selection.setSelectedNodes([node], false);
    const list = div({ className: style.contextList });
    list.style.transform = "none";
    list.style.left = `${x}px`;
    list.style.top = `${y}px`;
    for (const command of commands) list.append(menuRow(command, closeNodeContextMenu));
    list.append(
        div(
            {
                className: toolbarStyle.menuRow,
                onclick: () => {
                    closeNodeContextMenu();
                    Transaction.execute(document, "change visible", () => {
                        node.visible = !node.visible;
                    });
                    document.visual.update();
                },
            },
            span({ className: toolbarStyle.menuIcon }),
            span({
                className: toolbarStyle.menuText,
                textContent: I18n.translate(node.visible ? "contextMenu.hide" : "contextMenu.show"),
            }),
        ),
    );
    list.addEventListener("pointerdown", (e) => e.stopPropagation());
    const overlay = div({ className: style.overlay, onpointerdown: () => closeNodeContextMenu() }, list);
    overlay.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        closeNodeContextMenu();
    });
    const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        closeNodeContextMenu();
    };
    window.addEventListener("keydown", onKey, true);
    globalThis.document.body.append(overlay);
    openMenu = { overlay, onKey };
    // Near the window's edges the list moves back on screen.
    const rect = list.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 8) list.style.top = `${Math.max(8, y - rect.height)}px`;
    if (rect.right > window.innerWidth - 8) list.style.left = `${Math.max(8, x - rect.width)}px`;
}
