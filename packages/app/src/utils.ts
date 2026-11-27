// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { CAMERA_FLY_DURATION, I18n, type IApplication, runWithProgress, Transaction } from "@chili3d/core";

export async function importFiles(application: IApplication, files: File[] | FileList) {
    const document =
        application.activeView?.document ??
        (await application.newDocument(I18n.translate("document.untitled")));
    await runWithProgress(async (progress) => {
        await Transaction.executeAsync(document, "import model", async () => {
            await document.application.dataExchange.import(document, files, progress);
        });
        document.application.activeView?.cameraController.fitContent({
            duration: CAMERA_FLY_DURATION,
        });
    }, "command.file.import");
}
