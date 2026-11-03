// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type I18nKeys, type IDocument, Localize, type Property, Transaction } from "@chili3d/core";
import { div, option, select, span } from "@chili3d/element";
import commonStyle from "./common.module.css";
import { PropertyBase } from "./propertyBase";

/**
 * A dropdown for a node property declared with a `combobox` (an assembly joint's type): the
 * property's value is one of the combobox items, as a command's dropdown is. The items are
 * i18n keys, shown localized; a pick is written in one transaction.
 */
export class SelectProperty extends PropertyBase {
    private readonly element: HTMLSelectElement;

    constructor(
        readonly document: IDocument,
        objects: any[],
        readonly property: Property,
    ) {
        super(objects);
        const items = [...(property.combobox?.items ?? [])];
        const current = items.indexOf(objects[0][property.name]);
        this.element = select(
            {
                onchange: () => {
                    const value = items[this.element.selectedIndex];
                    Transaction.execute(document, "modify property", () => {
                        objects.forEach((x) => {
                            x[property.name] = value;
                        });
                        document.visual.update();
                    });
                },
            },
            ...items.map((item, index) =>
                option({
                    selected: index === current,
                    textContent: typeof item === "string" ? new Localize(item as I18nKeys) : String(item),
                }),
            ),
        );
        this.element.selectedIndex = current;
        this.appendChild(
            div(
                { className: commonStyle.panel },
                span({ className: commonStyle.propertyName, textContent: new Localize(property.display) }),
                this.element,
            ),
        );
    }
}

customElements.define("chili-select-property", SelectProperty);
