// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * A command that lays out its own parameter panel (icon toggles, a dimensioned diagram…) instead
 * of the generic one-row-per-`@property` list. The command panel still supplies the title,
 * the drag handle and the OK / Cancel controls around it.
 */
export interface ICommandPanelProvider {
    createCommandPanel(): HTMLElement;
}

export function isCommandPanelProvider(command: unknown): command is ICommandPanelProvider {
    return typeof (command as Partial<ICommandPanelProvider> | undefined)?.createCommandPanel === "function";
}
