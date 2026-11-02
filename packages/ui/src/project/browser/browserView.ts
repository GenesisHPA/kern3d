// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Annotation,
    Binding,
    CAMERA_FLY_DURATION,
    CommandStore,
    FolderNode,
    I18n,
    type I18nKeys,
    type IDocument,
    type INode,
    isReferenceGeometryNode,
    Localize,
    NodeCategories,
    type NodeCategory,
    NodeSelectionHandler,
    PubSub,
    ShapeSelectionHandler,
    ShapeTypes,
    Transaction,
    VisualNode,
    XYZ,
} from "@chili3d/core";
import { div, span, svg } from "@chili3d/element";
import { glyph } from "../../glyphs";
import { TreeModel } from "../tree/treeModel";
import style from "./browserView.module.css";

/** The sections the browser lists nodes under, in display order. */
const SECTIONS: readonly { category: NodeCategory; title: I18nKeys }[] = [
    { category: "body", title: "browser.bodies" },
    { category: "sketch", title: "browser.sketches" },
    { category: "construction", title: "browser.construction" },
    { category: "drawing", title: "browser.drawings" },
    { category: "annotation", title: "ribbon.group.annotation" },
    { category: "other", title: "browser.other" },
];

type Triple = readonly [number, number, number];

/** The origin planes: where the camera sits to look at each, and its up vector there. */
const ORIGIN_PLANES: readonly { title: I18nKeys; eye: Triple; up: Triple }[] = [
    { title: "browser.plane.xy", eye: [0, 0, 1], up: [0, 1, 0] },
    { title: "browser.plane.xz", eye: [0, -1, 0], up: [0, 0, 1] },
    { title: "browser.plane.yz", eye: [1, 0, 0], up: [0, 0, 1] },
];

const xyz = ([x, y, z]: Triple) => new XYZ({ x, y, z });

/** What a node is when no feature package claimed it. */
function defaultCategory(node: INode): NodeCategory {
    if (isReferenceGeometryNode(node)) return "construction";
    if (node instanceof Annotation) return "annotation";
    if (node instanceof VisualNode) return "body";
    return "other";
}

export function browserCategory(node: INode): NodeCategory {
    return NodeCategories.of(node, defaultCategory);
}

/**
 * The nodes the browser lists, in document order: everything a folder holds, with folders
 * opened up (they group nodes, they are not one). A parametric body's children are its
 * consumed tools and stay with it.
 */
export function listedNodes(root: INode | undefined): INode[] {
    const result: INode[] = [];
    const visit = (node: INode | null | undefined) => {
        for (let current = node; current; current = current.nextSibling) {
            if (current instanceof FolderNode) visit(current.firstChild);
            else result.push(current);
        }
    };
    if (root instanceof FolderNode) visit(root.firstChild);
    return result;
}

class BrowserSection {
    readonly rows: HTMLElement;
    readonly element: HTMLElement;
    private readonly count = span({ className: style.count });
    private expanded = true;
    private readonly chevron: Element;

    constructor(
        title: I18nKeys,
        onToggleVisibility?: () => void,
        readonly category?: NodeCategory,
    ) {
        this.rows = div({ className: style.rows });
        this.chevron = glyph("chevronDown", style.chevron);
        const eye = onToggleVisibility ? this.eye(onToggleVisibility) : undefined;
        this.element = div(
            { className: style.section, dataset: { section: category ?? title } },
            div(
                { className: style.sectionHeader, onclick: () => this.toggle() },
                this.chevron,
                span({ className: style.sectionTitle, textContent: new Localize(title) }),
                this.count,
                ...(eye ? [eye] : []),
            ),
            this.rows,
        );
    }

    private eye(onToggle: () => void) {
        const eye = svg({
            className: style.sectionEye,
            icon: "icon-eye",
            title: I18n.translate("browser.toggleVisibility"),
            onclick: (e) => {
                e.stopPropagation();
                onToggle();
            },
        });
        eye.dataset["eye"] = "section";
        return eye;
    }

    setCount(count: number) {
        this.count.textContent = count > 0 ? `${count}` : "";
        this.element.classList.toggle(style.empty, count === 0);
    }

    toggle() {
        this.expanded = !this.expanded;
        this.rows.style.display = this.expanded ? "" : "none";
        this.chevron.classList.toggle(style.collapsed, !this.expanded);
    }
}

/**
 * The browser panel's "by kind" view of a document: document settings, the origin planes, then
 * the document's nodes grouped by kind (bodies, sketches, construction, drawings…), each row the
 * project tree's own row element with its eye toggle. Grouping is display-only — the document
 * tree, folders and drag-and-drop stay in the tree view. A node change re-walks the tree and
 * moves only the rows that changed, so property edits of a body never touch this panel.
 */
export class BrowserView extends HTMLElement {
    private readonly rows = new Map<INode, TreeModel>();
    private readonly sections = new Map<NodeCategory, BrowserSection>();
    private selected = new Set<INode>();

    constructor(private readonly document: IDocument) {
        super();
        this.className = style.root;
        this.append(this.documentSection().element, this.originSection().element);
        for (const { category, title } of SECTIONS) {
            const section = new BrowserSection(title, () => this.toggleCategory(category), category);
            this.sections.set(category, section);
            this.append(section.element);
        }
        this.addEventListener("click", this.onClick);
        this.addEventListener("dblclick", this.onDoubleClick);
        this.reconcile();
    }

    connectedCallback() {
        this.document.modelManager.addNodeObserver(this.reconcile);
        this.document.selection.onNodeChanged.sub(this.onSelectionChanged);
        this.reconcile();
    }

    disconnectedCallback() {
        this.document.modelManager.removeNodeObserver(this.reconcile);
        this.document.selection.onNodeChanged.remove(this.onSelectionChanged);
    }

    dispose() {
        this.disconnectedCallback();
        this.rows.forEach((row) => row.dispose());
        this.rows.clear();
        this.remove();
    }

    rowOf(node: INode): TreeModel | undefined {
        return this.rows.get(node);
    }

    private documentSection() {
        const section = new BrowserSection("browser.document");
        const hasVariables = CommandStore.getComandData("feature.variable") !== undefined;
        section.rows.append(
            div(
                { className: style.row },
                glyph("document", style.rowGlyph),
                span({ className: style.rowName, textContent: new Binding(this.document, "name") }),
            ),
            div(
                { className: style.row },
                span({ className: style.rowNote, textContent: new Localize("browser.units") }),
            ),
            ...(hasVariables
                ? [
                      div(
                          {
                              className: `${style.row} ${style.link}`,
                              onclick: () => PubSub.default.pub("executeCommand", "feature.variable"),
                          },
                          svg({ className: style.rowGlyph, icon: "icon-cog" }),
                          span({ className: style.rowName, textContent: new Localize("browser.parameters") }),
                      ),
                  ]
                : []),
        );
        return section;
    }

    private originSection() {
        const section = new BrowserSection("browser.origin");
        for (const plane of ORIGIN_PLANES) {
            section.rows.append(
                div(
                    {
                        className: `${style.row} ${style.link}`,
                        title: I18n.translate("browser.plane.lookAt"),
                        onclick: () => this.lookAlong(xyz(plane.eye), xyz(plane.up)),
                    },
                    glyph("plane", style.rowGlyph),
                    span({ className: style.rowName, textContent: new Localize(plane.title) }),
                ),
            );
        }
        section.toggle();
        return section;
    }

    private lookAlong(direction: XYZ, up: XYZ) {
        const view = this.document.application.activeView;
        if (view?.document !== this.document) return;
        const camera = view.cameraController;
        const distance = camera.cameraPosition.distanceTo(camera.cameraTarget);
        const eye = camera.cameraTarget.add(direction.multiply(distance));
        camera.lookAt(eye, camera.cameraTarget, up, { duration: CAMERA_FLY_DURATION });
        view.update();
    }

    /** Brings the rows in line with the document: adds, removes and reorders, nothing else. */
    readonly reconcile = () => {
        const wanted = new Map<NodeCategory, INode[]>();
        for (const node of listedNodes(this.document.modelManager.rootNode)) {
            const category = browserCategory(node);
            const list = wanted.get(category) ?? [];
            list.push(node);
            wanted.set(category, list);
        }
        const keep = new Set<INode>();
        for (const [category, section] of this.sections) {
            const nodes = wanted.get(category) ?? [];
            nodes.forEach((node, index) => {
                keep.add(node);
                const row = this.ensureRow(node);
                if (section.rows.children[index] !== row) {
                    section.rows.insertBefore(row, section.rows.children[index] ?? null);
                }
            });
            section.setCount(nodes.length);
        }
        for (const [node, row] of this.rows) {
            if (keep.has(node)) continue;
            row.dispose();
            this.rows.delete(node);
        }
    };

    private ensureRow(node: INode): TreeModel {
        let row = this.rows.get(node);
        if (row === undefined) {
            row = new TreeModel(this.document, node);
            row.draggable = false;
            row.classList.add(style.nodeRow);
            if (this.selected.has(node)) row.classList.add(style.selected);
            this.rows.set(node, row);
        }
        return row;
    }

    private toggleCategory(category: NodeCategory) {
        const nodes = Array.from(this.rows.keys()).filter((node) => browserCategory(node) === category);
        if (nodes.length === 0) return;
        const visible = !nodes.every((node) => node.visible);
        Transaction.execute(this.document, "change visible", () => {
            nodes.forEach((node) => {
                node.visible = visible;
            });
        });
        this.document.visual.update();
    }

    private readonly onSelectionChanged = (selected: INode[]) => {
        this.selected.forEach((node) => this.rows.get(node)?.classList.remove(style.selected));
        this.selected = new Set(selected);
        this.selected.forEach((node) => this.rows.get(node)?.classList.add(style.selected));
    };

    private nodeAt(event: Event): INode | undefined {
        let element = event.target as HTMLElement | null;
        while (element && element !== this) {
            if (element instanceof TreeModel) return element.node;
            element = element.parentElement;
        }
        return undefined;
    }

    private canSelect() {
        const handler = this.document.visual.eventHandler;
        if (handler instanceof NodeSelectionHandler) return true;
        if (handler instanceof ShapeSelectionHandler) return handler.shapeType === ShapeTypes.shape;
        return false;
    }

    private readonly onClick = (event: MouseEvent) => {
        const node = this.nodeAt(event);
        if (node === undefined || !this.canSelect()) return;
        event.stopPropagation();
        this.document.selection.setSelectedNodes([node], event.ctrlKey);
    };

    private readonly onDoubleClick = (event: MouseEvent) => {
        const node = this.nodeAt(event);
        if (node === undefined) return;
        event.stopPropagation();
        PubSub.default.pub("nodeDoubleClicked", node);
    };
}

customElements.define("chili-browser-view", BrowserView);
