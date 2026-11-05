// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, type I18nKeys, type IApplication, type IDocument, PubSub } from "@chili3d/core";
import { DocumentTaskCommand } from "./documentTaskCommand";
import { askSaveTarget, type SaveTarget } from "./saveTarget";

@command({
    key: "doc.saveToFile",
    icon: "icon-download",
    // Downloading outranks everything — see `CommandService`.
    alwaysAvailable: true,
})
export class SaveDocumentToFile extends DocumentTaskCommand {
    protected readonly message: I18nKeys = "command.doc.saveToFile";
    private target?: SaveTarget;

    override async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (document) {
            // Asked before the spinner: its modal would sit over the name prompt.
            this.target = await askSaveTarget(document.name);
            if (!this.target) return;
            // Saving under a new name renames the document, as "Save as" does.
            if (this.target.name !== document.name) document.name = this.target.name;
        }
        await super.execute(app);
    }

    protected async run(document: IDocument): Promise<void> {
        // Let the spinner paint before the synchronous serialize/stringify below.
        await new Promise((r) => {
            setTimeout(r, 100);
        });
        const s = document.serialize();
        PubSub.default.pub("showToast", "toast.downloading");
        await this.target?.write(JSON.stringify(s));
    }
}
