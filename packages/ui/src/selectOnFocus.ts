// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Input types that hold one value the user retypes rather than edits in place. */
const VALUE_INPUTS = new Set(["", "text", "number", "search", "tel", "url"]);

/** Inputs that opt out (free text such as a chat box) carry `data-keep-caret`. */
function isValueInput(target: EventTarget | null): target is HTMLInputElement {
    return (
        target instanceof HTMLInputElement &&
        VALUE_INPUTS.has(target.type) &&
        !target.readOnly &&
        !target.disabled &&
        target.dataset["keepCaret"] === undefined
    );
}

/**
 * A value field selects its whole content when it gains focus, so a new number is typed
 * straight over the old one (no "0" to delete first). A click would put the caret back on its
 * mouseup, so the mouseup that ends the focusing click is swallowed — but only when it left
 * nothing selected, so a drag-select inside the field still works.
 */
export function installSelectOnFocus(root: Document = document) {
    root.addEventListener("focusin", (e) => {
        const input = e.target;
        if (!isValueInput(input)) return;
        try {
            input.select();
        } catch {
            // Some input types refuse selection; they keep the caret.
        }
        const onUp = (up: MouseEvent) => {
            if (input.selectionStart === input.selectionEnd) {
                up.preventDefault();
                input.select();
            }
        };
        input.addEventListener("mouseup", onUp, { once: true });
        // A keyboard focus has no mouseup: drop the listener before a later click needs the caret.
        setTimeout(() => input.removeEventListener("mouseup", onUp), 500);
    });
}
