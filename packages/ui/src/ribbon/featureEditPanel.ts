// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    I18n,
    type IDocument,
    type IFeatureListNode,
    type IHistoryRecord,
    type INode,
    Localize,
} from "@chili3d/core";
import { div, label, span, svg } from "@chili3d/element";
import { glyph } from "../glyphs";
import { FeatureListProperty } from "../property/featureListProperty";
import { enableDockedDrag, restoreDockedPanel } from "./commandContext";
import style from "./commandContext.module.css";

/**
 * A feature's parameters in a panel over the viewport — the same look and place as the panel a
 * command opens. Every field commits as it is edited (the model rebuilds live); OK keeps the
 * edits, Cancel undoes all of them, back to the history record the panel opened on.
 */
export class FeatureEditPanel extends HTMLElement {
    private readonly mark: IHistoryRecord | undefined;
    private closed = false;

    constructor(
        readonly document: IDocument,
        readonly node: INode & IFeatureListNode,
        readonly featureId: string,
        private readonly onClose: () => void,
    ) {
        super();
        this.mark = document.history.undoTop();
        this.className = `${style.panel} ${style.docked}`;
        this.render();
    }

    connectedCallback() {
        this.node.onPropertyChanged(this.onNodeChanged);
        restoreDockedPanel(this);
    }

    disconnectedCallback() {
        this.node.removePropertyChanged(this.onNodeChanged);
    }

    private item() {
        return this.node.featureItems().find((x) => x.id === this.featureId);
    }

    private render() {
        const item = this.item();
        const title = item?.name || (item ? I18n.translate(item.display) : "");
        const header = div(
            { className: style.command },
            item?.icon ? svg({ className: style.icon, icon: item.icon }) : glyph("feature", style.icon),
            label({ className: style.title, textContent: title }),
        );
        enableDockedDrag(this, header);
        const body = new FeatureListProperty(this.document, this.node, { single: this.featureId });
        body.classList.add(style.groups);
        const buttons = div(
            { className: style.selectionControl },
            div(
                { className: `${style.selectionButton} ${style.confirmButton}`, onclick: () => this.ok() },
                svg({ icon: "icon-confirm" }),
                span({ className: style.buttonText, textContent: new Localize("commandPanel.ok") }),
            ),
            div(
                { className: style.selectionButton, onclick: () => this.cancel() },
                svg({ icon: "icon-cancel" }),
                span({ className: style.buttonText, textContent: new Localize("commandPanel.cancel") }),
            ),
        );
        this.replaceChildren(div({ className: style.container }, header, body, buttons));
        this.addEventListener("keydown", this.onKeyDown);
    }

    /** The feature went away (deleted, undone past its creation): nothing is left to edit. */
    private readonly onNodeChanged = (property: string) => {
        if (property === "featuresJson" && this.item() === undefined) this.close();
    };

    private readonly onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.stopPropagation();
            this.cancel();
        }
    };

    ok() {
        // the box being edited commits on blur — let it land before the panel goes
        (globalThis.document?.activeElement as HTMLElement | null)?.blur?.();
        this.close();
    }

    /** Undoes every edit made while the panel was open. */
    cancel() {
        const history = this.document.history;
        let guard = history.undoCount();
        while (guard-- > 0 && history.undoTop() !== this.mark) history.undo();
        this.document.visual.update();
        this.close();
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.remove();
        this.onClose();
    }
}

customElements.define("chili-feature-edit-panel", FeatureEditPanel);
