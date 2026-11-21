// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { MessageType } from "@chili3d/core";
import style from "./tip.module.css";

export class Tip extends HTMLElement {
    private color?: string;

    private readonly value = document.createElement("span");
    private readonly hint = document.createElement("span");

    constructor(msg: string, type: MessageType, hint?: string) {
        super();
        this.className = style.tip;
        this.hint.className = style.hint;
        this.append(this.value, this.hint);
        this.set(msg, type, hint);
    }

    /** With a hint the value is shown boxed, as the field it becomes when a number is typed. */
    set(msg: string, type: MessageType, hint?: string) {
        if (this.value.textContent !== msg) this.value.textContent = msg;
        this.value.classList.toggle(style.field, hint !== undefined);
        this.hint.textContent = hint ?? "";
        this.hint.style.display = hint === undefined ? "none" : "";

        const newStyle = this.getStyle(type);
        this.setStyle(newStyle);
    }

    private setStyle(newStyle: string) {
        if (this.color !== newStyle && newStyle !== undefined) {
            if (this.color !== undefined) this.classList.remove(this.color);
            this.classList.add(newStyle);
            this.color = newStyle;
        }
    }

    private getStyle(type: MessageType) {
        switch (type) {
            case "error":
                return style.error;
            case "warn":
                return style.warn;
            default:
                return style.info;
        }
    }
}

customElements.define("chili-tip", Tip);
