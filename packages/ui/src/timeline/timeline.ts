// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type FeatureItem,
    FolderNode,
    I18n,
    type I18nKeys,
    type IApplication,
    type IDocument,
    type IFeatureListNode,
    type INode,
    type IView,
    isFeatureListNode,
    Localize,
    type NodeRecord,
    PubSub,
    Transaction,
} from "@chili3d/core";
import { div, input, option, select, span, svg } from "@chili3d/element";
import { glyph } from "../glyphs";
import { DropdownController } from "../ribbon/dropdownController";
import style from "./timeline.module.css";

export type FeatureListBody = INode & IFeatureListNode;

function isBody(node: INode | undefined): node is FeatureListBody {
    return node !== undefined && isFeatureListNode(node);
}

/** Every feature-list body of a document, in document order (folders opened up). */
export function featureBodies(document: IDocument): FeatureListBody[] {
    const result: FeatureListBody[] = [];
    const visit = (node: INode | null | undefined) => {
        for (let current = node; current; current = current.nextSibling) {
            if (isBody(current)) result.push(current);
            else if (current instanceof FolderNode) visit(current.firstChild);
        }
    };
    const root = document.modelManager.rootNode;
    if (root instanceof FolderNode) visit(root.firstChild);
    return result;
}

/** The body a selected node belongs to: itself, or the body that consumed it as a tool. */
function owningBody(node: INode): FeatureListBody | undefined {
    for (let current: INode | undefined = node; current; current = current.parent) {
        if (isBody(current)) return current;
    }
    return undefined;
}

/** The rollback position one step from `bar` (undefined = after the last feature). */
export function stepBar(bar: number | undefined, count: number, step: -1 | 1): number | undefined {
    const position = bar ?? count;
    const next = Math.max(0, Math.min(count, position + step));
    return next >= count ? undefined : next;
}

/**
 * The design history strip under the canvas: the features of one parametric body as icons in
 * build order, a rollback marker that can be dragged between them, and playback buttons that
 * step it. Double-click (or "Edit") opens the feature in the property panel, right-click gives
 * the feature's actions. The body is the selected one (or the one owning a selected tool), else
 * the first of the document, and the picker beside the strip switches it.
 *
 * The strip is rebuilt only when the body's feature list or rollback bar changes — a parameter
 * typed into the panel rewrites `featuresJson` once per edit, never per keystroke of another
 * property.
 */
export class Timeline extends HTMLElement {
    private document?: IDocument;
    private body?: FeatureListBody;
    private readonly picker = select({ className: style.picker, title: I18n.translate("timeline.body") });
    private readonly strip = div({ className: style.strip });
    private readonly marker = div({ className: style.marker, title: I18n.translate("timeline.marker") });
    private readonly empty = span({ className: style.empty, textContent: new Localize("timeline.empty") });
    private readonly menu = new DropdownController(style.menu);
    /** The marker's gap while it is being dragged, previewed before it is committed. */
    private dragIndex: number | undefined;

    constructor(readonly app: IApplication) {
        super();
        this.className = style.root;
        this.picker.addEventListener("change", this.onPick);
        this.marker.dataset["marker"] = "rollback";
        this.marker.addEventListener("pointerdown", this.onMarkerDown);
        this.append(
            div(
                { className: style.controls },
                this.button("toStart", "timeline.toStart", () => this.moveBar(0)),
                this.button("stepBack", "timeline.stepBack", () => this.step(-1)),
                this.button("stepForward", "timeline.stepForward", () => this.step(1)),
                this.button("toEnd", "timeline.toEnd", () => this.moveBar(undefined)),
            ),
            this.picker,
            this.strip,
        );
        this.render();
    }

    connectedCallback() {
        PubSub.default.sub("activeViewChanged", this.onActiveViewChanged);
        this.onActiveViewChanged(this.app.activeView);
    }

    disconnectedCallback() {
        PubSub.default.remove("activeViewChanged", this.onActiveViewChanged);
        this.setDocument(undefined);
    }

    get currentBody() {
        return this.body;
    }

    private button(name: Parameters<typeof glyph>[0], tip: I18nKeys, onclick: () => void) {
        const element = div({ className: style.control, title: I18n.translate(tip), onclick });
        element.dataset["action"] = name;
        element.append(glyph(name, style.controlGlyph));
        return element;
    }

    private readonly onActiveViewChanged = (view: IView | undefined) => {
        this.setDocument(view?.document);
    };

    private setDocument(document: IDocument | undefined) {
        if (document === this.document) return;
        if (this.document) {
            this.document.selection.onNodeChanged.remove(this.onSelectionChanged);
            this.document.modelManager.removeNodeObserver(this.onNodesChanged);
        }
        this.document = document;
        if (document) {
            document.selection.onNodeChanged.sub(this.onSelectionChanged);
            document.modelManager.addNodeObserver(this.onNodesChanged);
        }
        this.setBody(document ? featureBodies(document).at(0) : undefined);
    }

    setBody(body: FeatureListBody | undefined) {
        if (body !== this.body) {
            this.body?.removePropertyChanged(this.onBodyChanged);
            this.body = body;
            this.body?.onPropertyChanged(this.onBodyChanged);
        }
        this.renderPicker();
        this.render();
    }

    private readonly onSelectionChanged = (selected: INode[]) => {
        const body = selected.map(owningBody).find((b) => b !== undefined);
        if (body !== undefined && body !== this.body) this.setBody(body);
    };

    /** A body added or removed changes the picker; the shown one going away picks another. */
    private readonly onNodesChanged = (_records: NodeRecord[]) => {
        if (!this.document) return;
        const bodies = featureBodies(this.document);
        if (this.body === undefined || !bodies.includes(this.body)) this.setBody(bodies.at(0));
        else this.renderPicker();
    };

    private readonly onBodyChanged = (property: string) => {
        if (property === "featuresJson" || property === "rollbackBarIndex") this.render();
        else if (property === "name") this.renderPicker();
    };

    private readonly onPick = () => {
        if (!this.document) return;
        const bodies = featureBodies(this.document);
        this.setBody(bodies[Number(this.picker.value)]);
    };

    private renderPicker() {
        const bodies = this.document ? featureBodies(this.document) : [];
        this.picker.replaceChildren(
            ...bodies.map((body, index) =>
                option({ value: `${index}`, textContent: body.name, selected: body === this.body }),
            ),
        );
        this.picker.style.display = bodies.length > 1 ? "" : "none";
    }

    /** Rebuilds the strip: one icon per feature and the marker at the bar's gap. */
    render() {
        const body = this.body;
        if (body === undefined) {
            this.strip.replaceChildren(this.empty);
            return;
        }
        const items = body.featureItems();
        const bar = this.dragIndex ?? body.rollbackBarIndex ?? items.length;
        const children: HTMLElement[] = items.map((item, index) =>
            this.featureIcon(item, index, index >= bar),
        );
        children.splice(Math.min(bar, items.length), 0, this.marker);
        this.marker.style.display = body.setRollbackBar === undefined ? "none" : "";
        this.strip.replaceChildren(...children);
    }

    private featureIcon(item: FeatureItem, index: number, rolledBack: boolean) {
        let className = style.feature;
        if (rolledBack) className += ` ${style.rolledBack}`;
        if (item.suppressed || item.suppressedByVariable) className += ` ${style.suppressed}`;
        if (item.error !== undefined) className += ` ${style.error}`;
        else if (item.warning !== undefined) className += ` ${style.warning}`;
        const name = item.name || I18n.translate(item.display);
        const element = div({
            className,
            title: `${index + 1}. ${name}${item.error ? `\n${item.error}` : ""}`,
            ondblclick: () => this.edit(item),
            oncontextmenu: (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openMenu(item, index, e.currentTarget as HTMLElement);
            },
        });
        element.dataset["feature"] = item.id;
        element.append(
            item.icon
                ? svg({ className: style.featureIcon, icon: item.icon })
                : glyph("feature", style.featureIcon),
        );
        return element;
    }

    edit(item: FeatureItem) {
        const body = this.body;
        if (body === undefined) return;
        PubSub.default.pub("focusFeature", body, item.id);
        this.document?.selection.setSelectedNodes([body], false);
    }

    private transact(name: string, action: (body: FeatureListBody) => void) {
        const body = this.body;
        const document = this.document;
        if (body === undefined || document === undefined) return;
        Transaction.execute(document, name, () => action(body));
        document.visual.update();
    }

    moveBar(index: number | undefined) {
        const body = this.body;
        if (body?.setRollbackBar === undefined) return;
        const count = body.featureItems().length;
        const next = index === undefined || index >= count ? undefined : Math.max(0, index);
        if (next === body.rollbackBarIndex) return;
        this.transact("move rollback bar", (b) => b.setRollbackBar?.(next));
    }

    step(direction: -1 | 1) {
        const body = this.body;
        if (body === undefined) return;
        this.moveBar(stepBar(body.rollbackBarIndex, body.featureItems().length, direction));
    }

    private openMenu(item: FeatureItem, index: number, anchor: HTMLElement) {
        const body = this.body;
        if (body === undefined) return;
        const suppressed = item.suppressed === true;
        const entries: [string, I18nKeys, () => void][] = [
            ["icon-edit", "timeline.edit", () => this.edit(item)],
            ["icon-history", "timeline.rollHere", () => this.moveBar(index + 1)],
            [
                suppressed ? "icon-eye" : "icon-eye-slash",
                suppressed ? "timeline.unsuppress" : "timeline.suppress",
                () => this.transact("toggle feature", (b) => b.setFeatureSuppressed(item.id, !suppressed)),
            ],
        ];
        if (body.renameFeature !== undefined) {
            entries.push(["icon-tag", "common.rename", () => this.rename(item)]);
        }
        entries.push([
            "icon-trash",
            "common.delete",
            () => this.transact("remove feature", (b) => b.removeFeature(item.id)),
        ]);
        this.menu.open(anchor, (menu) => {
            for (const [icon, label, run] of entries) {
                const row = div(
                    {
                        className: style.menuRow,
                        onclick: (e) => {
                            e.stopPropagation();
                            this.menu.close();
                            run();
                        },
                    },
                    svg({ className: style.menuIcon, icon }),
                    span({ textContent: I18n.translate(label) }),
                );
                menu.append(row);
            }
            // above the strip: the timeline sits at the bottom edge of the window
            requestAnimationFrame?.(() => {
                const rect = anchor.getBoundingClientRect();
                menu.style.width = "";
                menu.style.top = `${Math.max(4, rect.top - menu.offsetHeight - 4)}px`;
            });
        });
    }

    private rename(item: FeatureItem) {
        const box = input({ value: item.name ?? I18n.translate(item.display) });
        box.addEventListener("keydown", (e) => e.stopPropagation());
        PubSub.default.pub("showDialog", "common.rename", box, () => {
            this.transact("rename feature", (b) => b.renameFeature?.(item.id, box.value.trim()));
        });
    }

    // --- marker drag ---

    private readonly onMarkerDown = (e: PointerEvent) => {
        if (e.button !== 0 || this.body?.setRollbackBar === undefined) return;
        e.preventDefault();
        // The strip holds the capture: the marker itself is re-inserted as it moves, and a
        // node leaving the DOM loses its pointer capture.
        this.strip.setPointerCapture?.(e.pointerId);
        this.strip.addEventListener("pointermove", this.onMarkerMove);
        this.strip.addEventListener("pointerup", this.onMarkerUp);
        this.marker.classList.add(style.dragging);
    };

    /** The gap nearest the pointer: before the first feature whose centre is right of it. */
    gapAt(clientX: number): number {
        const icons = Array.from(this.strip.querySelectorAll<HTMLElement>(`.${style.feature}`));
        const index = icons.findIndex((icon) => {
            const rect = icon.getBoundingClientRect();
            return clientX < rect.left + rect.width / 2;
        });
        return index < 0 ? icons.length : index;
    }

    private readonly onMarkerMove = (e: PointerEvent) => {
        const gap = this.gapAt(e.clientX);
        if (gap === this.dragIndex) return;
        this.dragIndex = gap;
        this.render();
    };

    private readonly onMarkerUp = (e: PointerEvent) => {
        this.strip.releasePointerCapture?.(e.pointerId);
        this.strip.removeEventListener("pointermove", this.onMarkerMove);
        this.strip.removeEventListener("pointerup", this.onMarkerUp);
        this.marker.classList.remove(style.dragging);
        const gap = this.dragIndex;
        this.dragIndex = undefined;
        if (gap === undefined) return;
        this.render();
        this.moveBar(gap);
    };
}

customElements.define("chili-timeline", Timeline);
