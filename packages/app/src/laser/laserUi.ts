// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys } from "@chili3d/core";
import style from "./laserEditor.module.css";

/** Small DOM builders for the laser editor's panels: a labelled row per field. */

export function t(key: string, ...args: unknown[]): string {
    return I18n.translate(key as I18nKeys, ...args);
}

export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Partial<Record<string, unknown>> = {},
    ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined) continue;
        if (k === "className") e.className = String(v);
        else if (k.startsWith("on") && typeof v === "function") (e as any)[k] = v;
        else if (k === "textContent") e.textContent = String(v);
        else (e as any)[k] = v;
    }
    e.append(...children);
    return e;
}

export function button(key: string, action: () => void, title?: string): HTMLButtonElement {
    return el("button", {
        textContent: t(key),
        onclick: action,
        title: title === undefined ? undefined : t(title),
    });
}

export function heading(key: string): HTMLElement {
    return el("h3", { textContent: t(key) });
}

export function row(labelKey: string, ...controls: Node[]): HTMLElement {
    return el("label", { className: style.row }, el("span", { textContent: t(labelKey) }), ...controls);
}

/** A number field that reports a parsed value on change (Enter or leaving it); a comma reads as a point. */
export function numberField(
    value: number,
    onChange: (value: number) => void,
    options: { step?: number; min?: number; max?: number; digits?: number } = {},
): HTMLInputElement {
    const input = el("input", { type: "number" });
    input.step = String(options.step ?? "any");
    if (options.min !== undefined) input.min = String(options.min);
    if (options.max !== undefined) input.max = String(options.max);
    const digits = options.digits ?? 3;
    input.value = String(Number.parseFloat(value.toFixed(digits)));
    input.onfocus = () => input.select();
    const commit = (raw: number) => {
        let v = raw;
        if (!Number.isFinite(v)) return;
        if (options.min !== undefined) v = Math.max(options.min, v);
        if (options.max !== undefined) v = Math.min(options.max, v);
        onChange(v);
    };
    input.onchange = () => commit(Number.parseFloat(input.value.replace(",", ".")));
    // Our own stepping instead of the browser's spin arrows (hidden in the CSS): a panel that
    // re-renders on a change replaces the field under a held arrow, which then never sees the
    // mouse go up and keeps counting on its own. ↑/↓ (Shift ×10) and the wheel step once each.
    const step = (direction: number, big: boolean) => {
        const base = typeof options.step === "number" ? options.step : 1;
        const current = Number.parseFloat(input.value.replace(",", ".")) || 0;
        const next = Number.parseFloat((current + direction * base * (big ? 10 : 1)).toFixed(digits));
        input.value = String(next);
        commit(next);
    };
    input.onkeydown = (e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        step(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
    };
    input.onwheel = (e) => {
        if (document.activeElement !== input) return;
        e.preventDefault();
        step(e.deltaY < 0 ? 1 : -1, e.shiftKey);
    };
    return input;
}

export function checkbox(checked: boolean, onChange: (checked: boolean) => void): HTMLInputElement {
    const input = el("input", { type: "checkbox" });
    input.checked = checked;
    input.onchange = () => onChange(input.checked);
    return input;
}

export function textField(value: string, onChange: (value: string) => void): HTMLInputElement {
    const input = el("input", { type: "text" });
    input.value = value;
    input.onchange = () => onChange(input.value);
    return input;
}

export function select<T extends string>(
    options: readonly { value: T; label: string }[],
    value: T,
    onChange: (value: T) => void,
): HTMLSelectElement {
    const s = el("select");
    for (const o of options) {
        const option = el("option", { value: o.value, textContent: o.label });
        option.selected = o.value === value;
        s.append(option);
    }
    s.onchange = () => onChange(s.value as T);
    return s;
}
