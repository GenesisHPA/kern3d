// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys, type IPropertyChanged, type ParameterValue } from "@chili3d/core";

/** What the hole panel edits: the hole command's own option values. */
export interface HolePanelModel extends IPropertyChanged {
    style: I18nKeys;
    tip: I18nKeys;
    diameter: ParameterValue;
    /** "" drills through all. */
    depth: ParameterValue;
    drillAngle: ParameterValue;
    counterboreDiameter: ParameterValue;
    counterboreDepth: ParameterValue;
    countersinkDiameter: ParameterValue;
    countersinkAngle: ParameterValue;
}

export const HOLE_STYLE_KEYS = {
    simple: "feature.hole.style.simple",
    counterbore: "feature.hole.style.counterbore",
    countersink: "feature.hole.style.countersink",
} as const satisfies Record<string, I18nKeys>;

export const HOLE_TIP_KEYS = {
    angle: "feature.hole.tip.angle",
    flat: "feature.hole.tip.flat",
} as const satisfies Record<string, I18nKeys>;

const SVG = "http://www.w3.org/2000/svg";
const ACCENT = "#e53935";
const DEFAULT_BLIND_DEPTH = 10;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function svgEl(tag: string, attrs: Record<string, string | number>) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
}

/** A small toggle picture: the hole's section in the given form. */
function toggleIcon(kind: "simple" | "counterbore" | "countersink" | "angle" | "flat" | "blind" | "through") {
    const svg = svgEl("svg", { viewBox: "0 0 24 24", width: 22, height: 22 });
    svg.append(svgEl("rect", { x: 2, y: 3, width: 20, height: 19, fill: "currentColor", opacity: 0.18 }));
    const path: Record<typeof kind, string> = {
        simple: "M9 3 V17 L12 20 L15 17 V3 Z",
        counterbore: "M6 3 V8 H9 V17 L12 20 L15 17 V8 H18 V3 Z",
        countersink: "M5 3 L9 8 V17 L12 20 L15 17 V8 L19 3 Z",
        angle: "M8 3 V14 L12 19 L16 14 V3 Z",
        flat: "M8 3 V18 H16 V3 Z",
        blind: "M9 3 V14 L12 17 L15 14 V3 Z",
        through: "M9 3 V22 H15 V3 Z",
    };
    svg.append(
        svgEl("path", {
            d: path[kind],
            fill: "var(--background-color, #fff)",
            stroke: "currentColor",
            "stroke-width": 1.4,
        }),
    );
    return svg;
}

/**
 * The hole command's own panel: toggles for the hole's type, how it ends and how deep it goes,
 * and a section drawing with each size typed where it is drawn. Every edit lands on the
 * command's option at once, so the 3D preview follows it.
 */
export function createHolePanel(model: HolePanelModel): HTMLElement {
    const root = el("div", "k3-hole-panel");
    root.append(style());
    let lastDepth: ParameterValue = model.depth === "" ? DEFAULT_BLIND_DEPTH : model.depth;

    const render = () => {
        if (model.depth !== "") lastDepth = model.depth;
        const through = model.depth === "";
        const kind =
            model.style === HOLE_STYLE_KEYS.counterbore
                ? "counterbore"
                : model.style === HOLE_STYLE_KEYS.countersink
                  ? "countersink"
                  : "simple";
        const flat = model.tip === HOLE_TIP_KEYS.flat;
        root.replaceChildren(
            style(),
            toggleRow("common.type", [
                [
                    "simple",
                    HOLE_STYLE_KEYS.simple,
                    kind === "simple",
                    () => (model.style = HOLE_STYLE_KEYS.simple),
                ],
                [
                    "counterbore",
                    HOLE_STYLE_KEYS.counterbore,
                    kind === "counterbore",
                    () => (model.style = HOLE_STYLE_KEYS.counterbore),
                ],
                [
                    "countersink",
                    HOLE_STYLE_KEYS.countersink,
                    kind === "countersink",
                    () => (model.style = HOLE_STYLE_KEYS.countersink),
                ],
            ]),
            toggleRow("feature.hole.extent", [
                ["blind", "feature.hole.extent.blind", !through, () => (model.depth = lastDepth)],
                ["through", "feature.hole.extent.through", through, () => (model.depth = "")],
            ]),
            ...(through
                ? []
                : [
                      toggleRow("feature.hole.tip", [
                          ["angle", HOLE_TIP_KEYS.angle, !flat, () => (model.tip = HOLE_TIP_KEYS.angle)],
                          ["flat", HOLE_TIP_KEYS.flat, flat, () => (model.tip = HOLE_TIP_KEYS.flat)],
                      ]),
                  ]),
            diagram(model, kind, through, flat),
        );
    };

    const onChanged = () => {
        if (!root.isConnected && root.childElementCount > 0 && renderedOnce) {
            model.removePropertyChanged(onChanged); // the panel is gone with its command
            return;
        }
        // a box being typed in keeps its focus: redraw only once it is committed
        if (
            root.contains(document.activeElement) &&
            (document.activeElement as HTMLElement).tagName === "INPUT"
        )
            return;
        render();
    };
    let renderedOnce = false;
    model.onPropertyChanged(onChanged);
    root.addEventListener("focusout", () => setTimeout(() => root.isConnected && onChanged(), 0));
    render();
    renderedOnce = true;
    return root;
}

type Toggle = [icon: Parameters<typeof toggleIcon>[0], tip: I18nKeys, active: boolean, pick: () => void];

function toggleRow(label: I18nKeys, toggles: Toggle[]) {
    const row = el("div", "k3-hole-row");
    row.append(el("span", "k3-hole-label", I18n.translate(label)));
    const group = el("div", "k3-hole-toggles");
    for (const [icon, tip, active, pick] of toggles) {
        const button = el("button", active ? "k3-hole-toggle k3-active" : "k3-hole-toggle");
        button.type = "button";
        button.title = I18n.translate(tip);
        button.append(toggleIcon(icon));
        button.onclick = pick;
        group.append(button);
    }
    row.append(group);
    return row;
}

/** A size field placed at `y` on the drawing; commits on Enter or when it loses focus. */
function sizeField(
    y: number,
    tip: I18nKeys,
    value: ParameterValue,
    write: (v: ParameterValue) => void,
    unit = "мм",
) {
    const box = el("div", "k3-hole-field");
    box.style.top = `${y - 12}px`;
    const input = el("input");
    input.value = typeof value === "number" ? String(Number(value.toFixed(4))) : String(value);
    input.title = I18n.translate(tip);
    const commit = () => {
        const text = input.value.trim();
        if (text === "") return;
        const number = Number(text.replace(",", "."));
        write(Number.isFinite(number) ? number : text);
    };
    input.addEventListener("keydown", (e) => {
        e.stopPropagation(); // typing is not a hotkey
        if (e.key === "Enter") {
            commit();
            input.blur();
        }
    });
    input.addEventListener("change", commit);
    box.append(input, el("span", "k3-hole-unit", unit));
    return box;
}

/** The section drawing with its dimension leaders, and the fields at their ends. */
function diagram(
    model: HolePanelModel,
    kind: "simple" | "counterbore" | "countersink",
    through: boolean,
    flat: boolean,
) {
    const W = 120;
    const H = 200;
    const cx = 52;
    const top = 26;
    const r = 13; // drill radius in the picture
    const rr = 26; // recess radius
    const recessBottom = kind === "simple" ? top : top + 30;
    const wallEnd = through ? H - 6 : 150;
    const tipY = through || flat ? wallEnd : wallEnd + 16;

    const wrap = el("div", "k3-hole-diagram");
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    // material block, and the hole cut into it
    svg.append(
        svgEl("rect", { x: 4, y: top, width: 96, height: H - top - 2, fill: "currentColor", opacity: 0.12 }),
    );
    let d = "";
    if (kind === "counterbore") {
        d = `M${cx - rr} ${top} V${recessBottom} H${cx - r} V${wallEnd}`;
    } else if (kind === "countersink") {
        d = `M${cx - rr} ${top} L${cx - r} ${recessBottom} V${wallEnd}`;
    } else {
        d = `M${cx - r} ${top} V${wallEnd}`;
    }
    d += tipY > wallEnd ? ` L${cx} ${tipY} L${cx + r} ${wallEnd}` : ` H${cx + r}`;
    if (kind === "counterbore") d += ` V${recessBottom} H${cx + rr} V${top} Z`;
    else if (kind === "countersink") d += ` V${recessBottom} L${cx + rr} ${top} Z`;
    else d += ` V${top} Z`;
    svg.append(svgEl("path", { d, fill: ACCENT, "fill-opacity": 0.22, stroke: ACCENT, "stroke-width": 1.5 }));
    svg.append(
        svgEl("line", {
            x1: cx,
            y1: top - 8,
            x2: cx,
            y2: H,
            stroke: "currentColor",
            "stroke-dasharray": "4 3",
            opacity: 0.5,
        }),
    );

    const leader = (x: number, y: number) =>
        svg.append(svgEl("line", { x1: x, y1: y, x2: W, y2: y, stroke: "currentColor", opacity: 0.45 }));
    const fields: HTMLElement[] = [];
    const add = (
        y: number,
        x: number,
        tip: I18nKeys,
        value: ParameterValue,
        write: (v: ParameterValue) => void,
        unit?: string,
    ) => {
        leader(x, y);
        fields.push(sizeField(y, tip, value, write, unit));
    };

    if (kind === "counterbore") {
        add(
            top - 12,
            cx + rr,
            "feature.hole.counterboreDiameter",
            model.counterboreDiameter,
            (v) => (model.counterboreDiameter = v),
        );
        add(
            (top + recessBottom) / 2,
            cx + rr,
            "feature.hole.counterboreDepth",
            model.counterboreDepth,
            (v) => (model.counterboreDepth = v),
        );
    } else if (kind === "countersink") {
        add(
            top - 12,
            cx + rr,
            "feature.hole.countersinkDiameter",
            model.countersinkDiameter,
            (v) => (model.countersinkDiameter = v),
        );
        add(
            (top + recessBottom) / 2,
            cx + (r + rr) / 2,
            "feature.hole.countersinkAngle",
            model.countersinkAngle,
            (v) => (model.countersinkAngle = v),
            "°",
        );
    }
    add(recessBottom + 30, cx + r, "dimension.diameter", model.diameter, (v) => (model.diameter = v));
    if (!through) {
        add(wallEnd - 30, cx + r, "feature.hole.depth", model.depth, (v) => (model.depth = v));
        if (!flat)
            add(tipY, cx, "feature.hole.drillAngle", model.drillAngle, (v) => (model.drillAngle = v), "°");
    }
    wrap.append(svg, ...fields);
    return wrap;
}

function style() {
    const s = el("style");
    s.textContent = `
.k3-hole-panel { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; width: 100%; box-sizing: border-box; }
.k3-hole-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.k3-hole-label { font-size: 12px; opacity: 0.85; }
.k3-hole-toggles { display: flex; gap: 4px; }
.k3-hole-toggle { width: 30px; height: 28px; padding: 2px; border: 1px solid var(--chrome-border-color, #ccc); border-radius: 5px; background: transparent; color: var(--foreground-color, #333); cursor: pointer; display: flex; align-items: center; justify-content: center; }
.k3-hole-toggle.k3-active { border-color: var(--accent-color, #1e88e5); background: color-mix(in srgb, var(--accent-color, #1e88e5) 18%, transparent); }
.k3-hole-diagram { position: relative; height: 200px; margin-top: 4px; color: var(--foreground-color, #333); }
.k3-hole-diagram svg { position: absolute; left: 0; top: 0; }
.k3-hole-field { position: absolute; left: 124px; right: 0; display: flex; align-items: center; gap: 4px; }
.k3-hole-field input { width: 100%; min-width: 0; height: 22px; padding: 0 6px; font-size: 12px; border: 1px solid var(--chrome-border-color, #ccc); border-radius: 4px; background: var(--background-color, #fff); color: var(--foreground-color, #333); }
.k3-hole-unit { font-size: 11px; opacity: 0.7; width: 18px; }
`;
    return s;
}
