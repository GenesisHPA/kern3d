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
import { div, input, span, svg } from "@chili3d/element";
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

/** The rollback position one step from `bar` (undefined = after the last feature). */
export function stepBar(bar: number | undefined, count: number, step: -1 | 1): number | undefined {
    const position = bar ?? count;
    const next = Math.max(0, Math.min(count, position + step));
    return next >= count ? undefined : next;
}

/** One operation on the document-wide strip: the feature and the body it belongs to. */
export interface TimelineEntry {
    readonly body: FeatureListBody;
    readonly item: FeatureItem;
    /** The feature's index in its own body's list (what the body's rollback bar counts). */
    readonly index: number;
}

/**
 * Every body's features as one strip, in the order they were made. Each body's own order is
 * kept (a k-way merge on the heads), and the creation time decides between bodies; features
 * from older files carry none and go first, in document order.
 */
export function mergeTimeline(bodies: readonly FeatureListBody[]): TimelineEntry[] {
    const lists = bodies.map((body) => ({ body, items: body.featureItems(), next: 0 }));
    const merged: TimelineEntry[] = [];
    for (;;) {
        let pick: (typeof lists)[number] | undefined;
        for (const list of lists) {
            if (list.next >= list.items.length) continue;
            const key = list.items[list.next].createdAt ?? 0;
            const best = pick === undefined ? Infinity : (pick.items[pick.next].createdAt ?? 0);
            if (key < best) pick = list;
        }
        if (pick === undefined) return merged;
        merged.push({ body: pick.body, item: pick.items[pick.next], index: pick.next });
        pick.next++;
    }
}

function isRolledBack(entry: TimelineEntry): boolean {
    const bar = entry.body.rollbackBarIndex;
    return bar !== undefined && entry.index >= bar;
}

/**
 * The design history strip under the canvas: every operation of the document — all bodies —
 * as icons in the order they were made, one rollback marker that can be dragged between them,
 * and playback buttons that step it. Moving the marker rolls each body back to the operations
 * left of it. Double-click (or "Edit") opens the operation in the edit panel over the viewport;
 * right-click gives the operation's actions.
 *
 * The strip is rebuilt only when a body's feature list or rollback bar changes, or a body
 * comes or goes.
 */
export class Timeline extends HTMLElement {
    private document?: IDocument;
    private bodies: FeatureListBody[] = [];
    private entries: TimelineEntry[] = [];
    private readonly strip = div({ className: style.strip });
    private readonly marker = div({ className: style.marker, title: I18n.translate("timeline.marker") });
    private readonly empty = span({ className: style.empty, textContent: new Localize("timeline.empty") });
    private readonly menu = new DropdownController(style.menu);
    /** The marker's gap while it is being dragged, previewed before it is committed. */
    private dragIndex: number | undefined;

    constructor(readonly app: IApplication) {
        super();
        this.className = style.root;
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

    /** The operations on the strip, in strip order. */
    get timelineEntries(): readonly TimelineEntry[] {
        return this.entries;
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
        this.document?.modelManager.removeNodeObserver(this.onNodesChanged);
        this.document = document;
        document?.modelManager.addNodeObserver(this.onNodesChanged);
        this.watchBodies(document ? featureBodies(document) : []);
    }

    /** Follows exactly the document's bodies: their lists and bars redraw the strip. */
    private watchBodies(bodies: FeatureListBody[]) {
        for (const body of this.bodies) body.removePropertyChanged(this.onBodyChanged);
        this.bodies = bodies;
        for (const body of this.bodies) body.onPropertyChanged(this.onBodyChanged);
        this.render();
    }

    private readonly onNodesChanged = (_records: NodeRecord[]) => {
        if (this.document) this.watchBodies(featureBodies(this.document));
    };

    private readonly onBodyChanged = (property: string) => {
        if (property === "featuresJson" || property === "rollbackBarIndex") this.render();
    };

    /** The gap the marker sits in: before the first rolled-back operation, else at the end. */
    private markerGap(): number {
        const first = this.entries.findIndex(isRolledBack);
        return first < 0 ? this.entries.length : first;
    }

    /** Rebuilds the strip: one icon per operation and the marker at its gap. */
    render() {
        this.entries = mergeTimeline(this.bodies);
        if (this.entries.length === 0) {
            this.strip.replaceChildren(this.empty);
            return;
        }
        const gap = this.dragIndex ?? this.markerGap();
        const children: HTMLElement[] = this.entries.map((entry, index) =>
            this.featureIcon(entry, index, this.dragIndex === undefined ? isRolledBack(entry) : index >= gap),
        );
        children.splice(Math.min(gap, this.entries.length), 0, this.marker);
        this.marker.style.display = this.bodies.some((b) => b.setRollbackBar !== undefined) ? "" : "none";
        this.strip.replaceChildren(...children);
    }

    private featureIcon(entry: TimelineEntry, index: number, rolledBack: boolean) {
        const item = entry.item;
        let className = style.feature;
        if (rolledBack) className += ` ${style.rolledBack}`;
        if (item.suppressed || item.suppressedByVariable) className += ` ${style.suppressed}`;
        if (item.error !== undefined) className += ` ${style.error}`;
        else if (item.warning !== undefined) className += ` ${style.warning}`;
        const name = item.name || I18n.translate(item.display);
        const owner = this.bodies.length > 1 ? ` — ${entry.body.name}` : "";
        const element = div({
            className,
            title: `${index + 1}. ${name}${owner}${item.error ? `\n${item.error}` : ""}`,
            ondblclick: () => this.edit(entry),
            oncontextmenu: (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openMenu(entry, index, e.currentTarget as HTMLElement);
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

    /** Opens the operation in the edit panel over the viewport. */
    edit(entry: TimelineEntry) {
        PubSub.default.pub("editFeature", entry.body, entry.item.id);
    }

    private transact(name: string, action: () => void) {
        const document = this.document;
        if (document === undefined) return;
        Transaction.execute(document, name, action);
        document.visual.update();
    }

    /**
     * Puts the marker in gap `index` of the strip (undefined = the end): every body is rolled
     * back to the operations of its own left of the gap, in one undo step.
     */
    moveBar(index: number | undefined) {
        const gap =
            index === undefined ? this.entries.length : Math.max(0, Math.min(index, this.entries.length));
        const changes: [FeatureListBody, number | undefined][] = [];
        for (const body of this.bodies) {
            if (body.setRollbackBar === undefined) continue;
            const kept = this.entries.slice(0, gap).filter((entry) => entry.body === body).length;
            const total = this.entries.filter((entry) => entry.body === body).length;
            const bar = kept >= total ? undefined : kept;
            if (bar !== body.rollbackBarIndex) changes.push([body, bar]);
        }
        if (changes.length === 0) return;
        this.transact("move rollback bar", () => {
            for (const [body, bar] of changes) body.setRollbackBar?.(bar);
        });
    }

    step(direction: -1 | 1) {
        const count = this.entries.length;
        this.moveBar(stepBar(this.markerGap() >= count ? undefined : this.markerGap(), count, direction));
    }

    private openMenu(entry: TimelineEntry, index: number, anchor: HTMLElement) {
        const { body, item } = entry;
        const suppressed = item.suppressed === true;
        const entries: [string, I18nKeys, () => void][] = [
            ["icon-edit", "timeline.edit", () => this.edit(entry)],
            ["icon-history", "timeline.rollHere", () => this.moveBar(index + 1)],
            [
                suppressed ? "icon-eye" : "icon-eye-slash",
                suppressed ? "timeline.unsuppress" : "timeline.suppress",
                () => this.transact("toggle feature", () => body.setFeatureSuppressed(item.id, !suppressed)),
            ],
        ];
        if (body.renameFeature !== undefined) {
            entries.push(["icon-tag", "common.rename", () => this.rename(entry)]);
        }
        entries.push([
            "icon-trash",
            "common.delete",
            () => this.transact("remove feature", () => body.removeFeature(item.id)),
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

    private rename(entry: TimelineEntry) {
        const { body, item } = entry;
        const box = input({ value: item.name ?? I18n.translate(item.display) });
        box.addEventListener("keydown", (e) => e.stopPropagation());
        PubSub.default.pub("showDialog", "common.rename", box, () => {
            this.transact("rename feature", () => body.renameFeature?.(item.id, box.value.trim()));
        });
    }

    // --- marker drag ---

    private readonly onMarkerDown = (e: PointerEvent) => {
        if (e.button !== 0 || !this.bodies.some((b) => b.setRollbackBar !== undefined)) return;
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
