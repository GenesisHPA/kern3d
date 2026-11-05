// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * A tab beside the document tabs for a workspace that covers the 3D view — a drawing sheet.
 * The owner shows and hides its own content; the registry decides which one is in front.
 */
export interface WorkspaceTab {
    readonly id: string;
    /** The tab's text, read each time the strip is drawn (a rename shows on the next change). */
    title(): string;
    readonly icon?: string;
    /** Bring the content in front of the 3D view. */
    show(): void;
    /** Step back so the 3D view is seen; the content stays as it is. */
    hide(): void;
    /** Close the workspace for good (the tab's × or the workspace's own close). */
    close(): void;
}

/**
 * The open workspace tabs and which one, if any, is in front. `active === undefined` means the
 * 3D view (the document tabs) is in front.
 */
export class WorkspaceTabRegistry {
    private readonly tabs: WorkspaceTab[] = [];
    private activeId: string | undefined;
    private readonly listeners = new Set<() => void>();

    get list(): readonly WorkspaceTab[] {
        return this.tabs;
    }

    get active(): string | undefined {
        return this.activeId;
    }

    /** Adds the tab (once) and brings it to the front. */
    open(tab: WorkspaceTab): void {
        if (!this.tabs.some((x) => x.id === tab.id)) this.tabs.push(tab);
        this.activate(tab.id);
    }

    /** Brings `id` to the front, or the 3D view with undefined. */
    activate(id: string | undefined): void {
        for (const tab of this.tabs) if (tab.id !== id) tab.hide();
        const tab = this.tabs.find((x) => x.id === id);
        this.activeId = tab?.id;
        tab?.show();
        this.emit();
    }

    /** Forgets the tab (its owner has closed); the 3D view comes back if it was in front. */
    remove(id: string): void {
        const index = this.tabs.findIndex((x) => x.id === id);
        if (index < 0) return;
        this.tabs.splice(index, 1);
        if (this.activeId === id) this.activeId = undefined;
        this.emit();
    }

    /** The strip redraws on every change; returns the unsubscribe. */
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Lets the strip redraw after a tab's title changed. */
    changed(): void {
        this.emit();
    }

    private emit() {
        for (const listener of this.listeners) listener();
    }
}

export const workspaceTabs = new WorkspaceTabRegistry();
