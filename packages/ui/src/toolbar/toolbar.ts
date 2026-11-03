// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Binding,
    type CollectionChangedArgs,
    type CommandKeys,
    Config,
    I18n,
    type IApplication,
    type IConverter,
    type IView,
    Localize,
    PubSub,
    Result,
    type Ribbon,
    type RibbonTab,
    type RibbonWorkspaceKeys,
} from "@chili3d/core";
import { a, collection, div, span, svg } from "@chili3d/element";
import { glyph } from "../glyphs";
import { DropdownController } from "../ribbon/dropdownController";
import { QuickButton } from "../ribbon/ribbon";
import { RibbonPushButton } from "../ribbon/ribbonButton";
import style from "./toolbar.module.css";
import { ToolbarGroup } from "./toolbarGroup";

class ActiveViewConverter implements IConverter<IView> {
    constructor(readonly view: IView) {}
    convert(value: IView): Result<string> {
        return Result.ok(this.view === value ? `${style.docTab} ${style.active}` : style.docTab);
    }
}

/** The glyph a workspace shows in the switcher; any plugin workspace falls back to design's. */
function workspaceGlyph(workspace: RibbonWorkspaceKeys) {
    return glyph(workspace === "ribbon.workspace.drawing" ? "drawing" : "design", style.workspaceIcon);
}

/**
 * The application's top toolbar: an app bar (home, quick commands, open documents) over a
 * command bar — the workspace switcher, the tabs of the current workspace, and the active tab's
 * groups. It renders the `Ribbon` model as it stands, so ribbon profiles, contextual tabs (the
 * sketch tab `Ribbon.openTab` shows while a sketch is edited) and plugin groups all keep working.
 * A tab's groups are built once and kept, so switching tabs does not rebuild them.
 */
export class MainToolbar extends HTMLElement {
    private readonly tabStrip = div({ className: style.tabStrip });
    private readonly groupArea = div({ className: style.groupArea });
    private readonly workspaceLabel = span({ className: style.workspaceName });
    private readonly workspaceButton: HTMLElement;
    private readonly tabPanels = new Map<RibbonTab, HTMLElement>();
    readonly #workspaceMenu = new DropdownController(style.menu);

    constructor(
        readonly app: IApplication,
        readonly ribbon: Ribbon,
    ) {
        super();
        this.className = style.root;
        this.workspaceButton = div(
            {
                className: style.workspace,
                title: I18n.translate("toolbar.workspace"),
                onclick: (e) => {
                    e.stopPropagation();
                    this.toggleWorkspaceMenu();
                },
            },
            div({ className: style.workspaceIconSlot }),
            div({ className: style.workspaceText }, this.workspaceLabel, glyph("chevronDown", style.chevron)),
        );
        this.append(
            this.appBar(),
            div(
                { className: style.commandBar },
                this.workspaceButton,
                div({ className: style.tabArea }, this.tabStrip, this.groupArea),
            ),
        );
        this.refresh();
    }

    connectedCallback() {
        this.ribbon.onPropertyChanged(this.onRibbonChanged);
        this.ribbon.tabs.onCollectionChanged(this.onTabsChanged);
        this.ribbon.tabs.forEach((tab) => tab.onPropertyChanged(this.onTabChanged));
        Config.instance.onPropertyChanged(this.onConfigChanged);
    }

    disconnectedCallback() {
        this.ribbon.removePropertyChanged(this.onRibbonChanged);
        this.ribbon.tabs.removeCollectionChanged(this.onTabsChanged);
        this.ribbon.tabs.forEach((tab) => tab.removePropertyChanged(this.onTabChanged));
        Config.instance.removePropertyChanged(this.onConfigChanged);
        this.#workspaceMenu.close();
    }

    private readonly onRibbonChanged = (property: keyof Ribbon) => {
        if (property === "activeTab") this.refresh();
    };

    private readonly onTabChanged = (property: keyof RibbonTab) => {
        if (property === "visible") this.renderTabs();
    };

    private readonly onTabsChanged = (args: CollectionChangedArgs) => {
        if (args.action === "add")
            args.items.forEach((tab: RibbonTab) => tab.onPropertyChanged(this.onTabChanged));
        this.refresh();
    };

    private readonly onConfigChanged = (property: keyof Config) => {
        if (property !== "navigation3D") return;
        this.querySelectorAll(customElements.getName(RibbonPushButton)!).forEach((x) => {
            (x as RibbonPushButton).updateShortcut();
        });
    };

    /** The current workspace is the active tab's: a contextual tab opening switches nothing. */
    get workspace(): RibbonWorkspaceKeys {
        return this.ribbon.activeTab?.workspace ?? "ribbon.workspace.design";
    }

    workspaces(): RibbonWorkspaceKeys[] {
        const result: RibbonWorkspaceKeys[] = [];
        for (const tab of this.ribbon.tabs) {
            if (!result.includes(tab.workspace)) result.push(tab.workspace);
        }
        return result;
    }

    switchWorkspace(workspace: RibbonWorkspaceKeys) {
        if (workspace === this.workspace) return;
        const tab = this.ribbon.tabs.find((t) => t.workspace === workspace && t.visible);
        if (tab) this.ribbon.activeTab = tab;
    }

    private refresh() {
        I18n.set(this.workspaceLabel, "textContent", this.workspace);
        this.workspaceButton.firstElementChild?.replaceChildren(workspaceGlyph(this.workspace));
        this.renderTabs();
        this.renderGroups();
    }

    private renderTabs() {
        const tabs = this.ribbon.tabs.filter((t) => t.visible && t.workspace === this.workspace);
        this.tabStrip.replaceChildren(
            ...tabs.map((tab) => {
                let className = style.tab;
                if (tab.contextual) className += ` ${style.contextual}`;
                if (tab === this.ribbon.activeTab) className += ` ${style.active}`;
                return div({
                    className,
                    dataset: { tab: tab.tabName },
                    textContent: new Localize(tab.tabName),
                    onclick: () => {
                        this.ribbon.activeTab = tab;
                    },
                });
            }),
        );
    }

    /**
     * A tab's panel is built the first time the tab is shown and then only hidden: a collection
     * element rebuilds its items whenever it is re-attached, so detaching it would rebuild every
     * group on each tab switch.
     */
    private renderGroups() {
        const tab = this.ribbon.activeTab;
        if (tab !== undefined && !this.tabPanels.has(tab)) {
            const panel = collection({
                className: style.groups,
                dataset: { tab: tab.tabName },
                sources: tab.groups,
                template: (group) => new ToolbarGroup(group, tab.tabName),
            });
            this.tabPanels.set(tab, panel);
            this.groupArea.append(panel);
        }
        this.tabPanels.forEach((panel, owner) => {
            panel.style.display = owner === tab ? "" : "none";
        });
    }

    private toggleWorkspaceMenu() {
        if (this.#workspaceMenu.isOpened) {
            this.#workspaceMenu.close();
            return;
        }
        let menu: HTMLElement | undefined;
        this.#workspaceMenu.open(this.workspaceButton, (dropdown) => {
            menu = dropdown;
            for (const workspace of this.workspaces()) {
                const className =
                    workspace === this.workspace ? `${style.menuRow} ${style.active}` : style.menuRow;
                dropdown.append(
                    div(
                        {
                            className,
                            dataset: { workspace },
                            onclick: (e) => {
                                e.stopPropagation();
                                this.#workspaceMenu.close();
                                this.switchWorkspace(workspace);
                            },
                        },
                        workspaceGlyph(workspace),
                        span({ className: style.menuText, textContent: new Localize(workspace) }),
                    ),
                );
            }
        });
        if (menu) menu.style.width = "";
    }

    private appBar() {
        return div(
            { className: style.appBar },
            div(
                {
                    className: style.appIcon,
                    title: I18n.translate("command.doc.open"),
                    onclick: () => PubSub.default.pub("displayHome", true),
                },
                svg({ className: style.appLogo, icon: "icon-chili" }),
                span({ className: style.appName, textContent: "Chili3D" }),
            ),
            collection({
                className: style.quickCommands,
                sources: this.ribbon.quickCommands,
                template: (command: CommandKeys) => QuickButton(command as any),
            }),
            collection({
                className: style.docTabs,
                sources: this.app.views,
                template: (view: IView) => this.docTab(view),
            }),
            svg({
                className: style.appButton,
                icon: "icon-plus",
                title: I18n.translate("command.doc.new"),
                onclick: () => PubSub.default.pub("executeCommand", "doc.new"),
            }),
            div({ className: style.spacer }),
            a(
                { href: "https://github.com/xiangechen/chili3d", target: "_blank" },
                svg({ title: "Github", className: style.appButton, icon: "icon-github" }),
            ),
        );
    }

    private docTab(view: IView) {
        return div(
            {
                className: new Binding(this.app, "activeView", new ActiveViewConverter(view)),
                onclick: () => {
                    this.app.activeView = view;
                },
            },
            span({ className: style.docName, textContent: new Binding(view.document, "name") }),
            svg({
                className: style.docClose,
                icon: "icon-times",
                onclick: (e) => {
                    e.stopPropagation();
                    view.close();
                },
            }),
        );
    }
}

customElements.define("chili-main-toolbar", MainToolbar);
