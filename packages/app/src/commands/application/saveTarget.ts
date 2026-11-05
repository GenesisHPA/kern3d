// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DOCUMENT_FILE_EXTENSION, download, Localize, PubSub } from "@chili3d/core";
import { div, input, label } from "@chili3d/element";

/** Where a document is saved: the name the user chose (without extension) and how to write it. */
export interface SaveTarget {
    readonly name: string;
    write(data: string): Promise<void>;
}

interface FileHandleLike {
    readonly name: string;
    createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

type SaveFilePicker = (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileHandleLike>;

/** Turns what the user typed into a file name: no path characters, no doubled extension. */
export function cleanFileName(text: string, fallback: string): string {
    let name = text.replace(/[\\/:*?"<>|]/g, "_").trim();
    if (name.toLowerCase().endsWith(DOCUMENT_FILE_EXTENSION)) {
        name = name.slice(0, -DOCUMENT_FILE_EXTENSION.length).trim();
    }
    return name.length > 0 ? name : fallback;
}

/**
 * Asks the user under which name to save. Uses the system "Save as" dialog where the browser has
 * one (Chrome/Edge: name and folder), otherwise an in-app dialog for the name followed by a plain
 * download. Resolves `undefined` when the user cancels.
 */
export async function askSaveTarget(currentName: string): Promise<SaveTarget | undefined> {
    const picker = (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
    if (picker) {
        try {
            return await pickWithSystemDialog(picker, currentName);
        } catch (e) {
            if ((e as Error)?.name === "AbortError") return undefined;
            // No user activation left, a blocked API, … — the in-app dialog still works.
        }
    }
    return askNameInDialog(currentName);
}

async function pickWithSystemDialog(picker: SaveFilePicker, currentName: string): Promise<SaveTarget> {
    const handle = await picker({
        suggestedName: `${currentName}${DOCUMENT_FILE_EXTENSION}`,
        types: [{ description: "Kern3D", accept: { "application/json": [DOCUMENT_FILE_EXTENSION] } }],
    });
    return {
        name: cleanFileName(handle.name, currentName),
        write: async (data) => {
            const stream = await handle.createWritable();
            await stream.write(data);
            await stream.close();
        },
    };
}

function askNameInDialog(currentName: string): Promise<SaveTarget | undefined> {
    return new Promise((resolve) => {
        const field = input({
            value: currentName,
            onkeydown: (e) => {
                // Enter/Escape reach the dialog (confirm/cancel); anything else is typing, not a hotkey.
                if (e.key !== "Enter" && e.key !== "Escape") e.stopPropagation();
            },
        });
        const content = div(
            { style: { display: "flex", flexDirection: "column", gap: "10px", minWidth: "320px" } },
            label({ textContent: new Localize("common.name") }, ": "),
            field,
        );
        PubSub.default.pub("showDialog", "command.doc.saveToFile", content, [
            {
                content: "common.confirm",
                onclick: () => {
                    const name = cleanFileName(field.value, currentName);
                    resolve({
                        name,
                        write: async (data) => download([data], `${name}${DOCUMENT_FILE_EXTENSION}`),
                    });
                },
            },
            { content: "common.cancel", onclick: () => resolve(undefined) },
        ]);
        setTimeout(() => {
            field.focus();
            field.select();
        }, 0);
    });
}
