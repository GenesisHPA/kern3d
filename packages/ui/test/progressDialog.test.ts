// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type IProgress, PubSub } from "@chili3d/core";
import { afterEach, describe, expect, test } from "@rstest/core";
import { showProgress } from "../src/progressDialog";

function dialog(): HTMLDialogElement | null {
    return document.querySelector("dialog");
}

describe("progress window", () => {
    afterEach(() => {
        document.querySelectorAll("dialog").forEach((d) => {
            d.remove();
        });
        PubSub.default.removeAll("showToast");
        PubSub.default.removeAll("displayError");
    });

    test("shows the title, the stage and the percent while the task runs, and closes after", async () => {
        let progress!: IProgress;
        let release!: () => void;
        const running = showProgress(async (p) => {
            progress = p;
            await new Promise<void>((resolve) => {
                release = resolve;
            });
        }, "command.modify.rebuildFromMesh");
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(dialog()?.textContent).toContain(I18n.translate("command.modify.rebuildFromMesh"));
        await progress.report(0.42, "stl.stage.axis{0}{1}", 2, 3);
        expect(dialog()?.textContent).toContain(I18n.translate("stl.stage.axis{0}{1}", 2, 3));
        expect(dialog()?.textContent).toContain("42 %");
        // never goes back
        await progress.report(0.1);
        expect(dialog()?.textContent).toContain("42 %");

        release();
        await running;
        expect(dialog()).toBeNull();
    });

    test("«Отмена» stops the task quietly: a toast, no error", async () => {
        const toasts: unknown[] = [];
        const errors: unknown[] = [];
        PubSub.default.sub("showToast", (key) => toasts.push(key));
        PubSub.default.sub("displayError", (e) => errors.push(e));
        let progress!: IProgress;
        let release!: () => void;
        const running = showProgress(async (p) => {
            progress = p;
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            p.throwIfCancelled();
        }, "command.modify.rebuildFromMesh");
        await new Promise((resolve) => setTimeout(resolve, 80));

        dialog()?.querySelector("button")?.click();
        expect(progress.cancelled).toBe(true);
        release();
        await running;

        expect(toasts).toEqual(["progress.cancelled"]);
        expect(errors).toEqual([]);
        expect(dialog()).toBeNull();
    });

    test("an error of the task goes to the error toast", async () => {
        const errors: unknown[] = [];
        PubSub.default.sub("displayError", (e) => errors.push(e));
        await showProgress(async () => {
            throw new Error("boom");
        }, "command.file.import");
        expect(String(errors[0])).toContain("boom");
        expect(dialog()).toBeNull();
    });
});
