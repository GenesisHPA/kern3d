// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys, type ParameterValue } from "@chili3d/core";
import type { EntitySize, EntitySizeKind } from "../entitySize";
import style from "./sketchEntityPanel.module.css";

const LABELS: Record<EntitySizeKind, I18nKeys> = {
    diameter: "sketch.size.diameter",
    radius: "sketch.size.radius",
    length: "sketch.size.length",
};

/**
 * The size of the one selected sketch entity, in the canvas's bottom-left corner: a circle's Ø,
 * an arc's R, a line's length. Typing a value and Enter writes it (`SketchEditor.applyEntitySize`
 * — the dimension already on that size, or a new driving one); Esc puts the reading back.
 */
export class SketchEntityPanel {
    readonly element = document.createElement("div");
    private readonly label = document.createElement("span");
    private readonly input = document.createElement("input");
    private size: EntitySize | undefined;

    constructor(private readonly apply: (size: EntitySize, value: ParameterValue) => void) {
        this.element.className = style.root;
        this.label.className = style.label;
        this.input.className = style.input;
        this.input.type = "text";
        const unit = document.createElement("span");
        unit.className = style.unit;
        unit.textContent = I18n.translate("sketch.size.mm");
        this.element.append(this.label, this.input, unit);
        this.element.addEventListener("pointerdown", (e) => e.stopPropagation());
        this.input.addEventListener("keydown", this.onKeyDown);
        this.hide();
    }

    /** Shows `size` (undefined hides the panel). A field being typed into keeps its text. */
    show(size: EntitySize | undefined): void {
        this.size = size;
        if (size === undefined) {
            this.hide();
            return;
        }
        this.element.style.display = "";
        this.label.textContent = I18n.translate(LABELS[size.kind]);
        this.input.disabled = size.driven === true;
        this.input.title = size.driven === true ? I18n.translate("sketch.drivenNotEditable") : "";
        if (document.activeElement !== this.input) this.input.value = format(size.value);
    }

    get visible(): boolean {
        return this.element.style.display !== "none";
    }

    private hide(): void {
        this.element.style.display = "none";
    }

    private readonly onKeyDown = (e: KeyboardEvent) => {
        // the sketch's own keys (Delete, Esc, letters) must not act while the field is typed in
        e.stopPropagation();
        if (e.key === "Escape") {
            if (this.size !== undefined) this.input.value = format(this.size.value);
            this.input.blur();
        } else if (e.key === "Enter" && this.size !== undefined) {
            e.preventDefault();
            const text = this.input.value.trim().replace(",", ".");
            if (text === "") return;
            const number = Number(text);
            this.input.blur();
            this.apply(this.size, Number.isFinite(number) ? number : text);
        }
    };

    dispose(): void {
        this.input.removeEventListener("keydown", this.onKeyDown);
        this.element.remove();
    }
}

function format(value: number): string {
    return `${Number.parseFloat(value.toFixed(3))}`;
}
