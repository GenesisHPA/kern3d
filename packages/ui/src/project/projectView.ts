// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys, type IDocument, type IView, Localize, PubSub } from "@chili3d/core";
import { div, span, svg } from "@chili3d/element";
import { BrowserView } from "./browser/browserView";
import style from "./projectView.module.css";
import { ToolBar } from "./toolBar";
import { Tree } from "./tree";

/** How the browser shows a document: grouped by kind, or as the document's own tree. */
export type BrowserMode = "categories" | "tree";

const MODE_STORAGE_KEY = "chili3d.browserMode";

function loadMode(): BrowserMode {
    try {
        return globalThis.localStorage?.getItem(MODE_STORAGE_KEY) === "tree" ? "tree" : "categories";
    } catch {
        return "categories";
    }
}

function saveMode(mode: BrowserMode) {
    try {
        globalThis.localStorage?.setItem(MODE_STORAGE_KEY, mode);
    } catch {
        // a blocked storage only forgets the choice
    }
}

/**
 * The browser panel. Each open document has a `Tree` (the document tree: folders, drag and
 * drop, renaming) and a `BrowserView` (document settings, origin, nodes grouped by kind); the
 * header switches between them and the choice is remembered per browser.
 */
export class ProjectView extends HTMLElement {
    private readonly _documentTreeMap = new Map<IDocument, Tree>();
    private readonly _documentBrowserMap = new Map<IDocument, BrowserView>();
    private _mode: BrowserMode = loadMode();
    private readonly _toolBar: ToolBar;
    private readonly _modeButtons = new Map<BrowserMode, SVGSVGElement>();

    private _activeDocument: IDocument | undefined;
    get activeDocument() {
        return this._activeDocument;
    }

    get mode() {
        return this._mode;
    }

    private readonly panel: HTMLDivElement;

    constructor(props: { className: string }) {
        super();
        this.classList.add(style.root, props.className);
        this.panel = div({
            className: style.itemsPanel,
        });
        this._toolBar = new ToolBar(this);
        PubSub.default.sub("activeViewChanged", this.handleActiveViewChanged);
        PubSub.default.sub("documentClosed", this.handleDocumentClosed);

        this.render();
    }

    private render() {
        this.append(
            div(
                { className: style.headerPanel },
                span({
                    className: style.header,
                    textContent: new Localize("browser.header"),
                }),
                this.modeButton("categories", "icon-layer-group", "browser.mode.categories"),
                this.modeButton("tree", "icon-Directory-tree", "browser.mode.tree"),
                this._toolBar,
            ),
            this.panel,
        );
        this.applyModeButtons();
    }

    private modeButton(mode: BrowserMode, icon: string, tip: I18nKeys) {
        const button = svg({
            icon,
            className: style.modeButton,
            title: I18n.translate(tip),
            onclick: () => this.setMode(mode),
        });
        this._modeButtons.set(mode, button);
        return button;
    }

    private applyModeButtons() {
        this._modeButtons.forEach((button, mode) => {
            button.classList.toggle(style.modeActive, mode === this._mode);
        });
        this._toolBar.style.display = this._mode === "tree" ? "" : "none";
    }

    setMode(mode: BrowserMode) {
        if (mode === this._mode) return;
        this._mode = mode;
        saveMode(mode);
        this.applyModeButtons();
        if (this._activeDocument) this.showDocument(this._activeDocument);
    }

    activeTree() {
        if (!this._activeDocument) return undefined;
        return this._documentTreeMap.get(this._activeDocument);
    }

    activeBrowser() {
        if (!this._activeDocument) return undefined;
        return this._documentBrowserMap.get(this._activeDocument);
    }

    private readonly handleDocumentClosed = (document: IDocument) => {
        const tree = this._documentTreeMap.get(document);
        if (tree) {
            tree.remove();
            tree.dispose();
            this._documentTreeMap.delete(document);
        }
        const browser = this._documentBrowserMap.get(document);
        if (browser) {
            browser.dispose();
            this._documentBrowserMap.delete(document);
        }
    };

    private readonly handleActiveViewChanged = (view: IView | undefined) => {
        if (this._activeDocument === view?.document) return;

        this._documentTreeMap.get(this._activeDocument!)?.remove();
        this._documentBrowserMap.get(this._activeDocument!)?.remove();
        this._activeDocument = view?.document;

        if (view) this.showDocument(view.document);
    };

    /** Shows the document in the current mode, building that mode's panel on first use. */
    private showDocument(document: IDocument) {
        let tree = this._documentTreeMap.get(document);
        if (!tree) {
            tree = new Tree(document);
            this._documentTreeMap.set(document, tree);
        }
        if (this._mode === "tree") {
            this._documentBrowserMap.get(document)?.remove();
            this.panel.append(tree);
            return;
        }
        tree.remove();
        let browser = this._documentBrowserMap.get(document);
        if (!browser) {
            browser = new BrowserView(document);
            this._documentBrowserMap.set(document, browser);
        }
        this.panel.append(browser);
    }
}

customElements.define("chili-project-view", ProjectView);
