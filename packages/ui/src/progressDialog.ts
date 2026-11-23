// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { errorText, I18n, type I18nKeys, type IProgress, PubSub, TaskCancelled } from "@chili3d/core";
import { button, div, span } from "@chili3d/element";
import style from "./progressDialog.module.css";

/** The desktop app's taskbar bar (Electron `win.setProgressBar`); absent in the browser. */
function taskbar(value: number) {
    const api = (globalThis as { kern3dDesktop?: { setProgress?: (v: number) => void } }).kern3dDesktop;
    try {
        api?.setProgress?.(value);
    } catch {}
}

/** Longest the task may run without giving the browser a frame, ms. */
const YIELD_EVERY = 100;

function clock(ms: number) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A long task under a modal window: title, stage, a bar with the percent, elapsed time and
 * «Отмена». The same bar on the taskbar icon in the desktop app. A cancelled task (it throws
 * `TaskCancelled`) closes quietly with a toast; any other error goes to the error toast.
 */
export async function showProgress(task: (progress: IProgress) => Promise<void>, title: I18nKeys) {
    const started = Date.now();
    let fraction = 0;
    let cancelled = false;
    let lastYield = Date.now();

    const bar = div({ className: style.fill });
    const percent = span({ className: style.percent, textContent: "0 %" });
    const stage = span({ className: style.stage, textContent: "" });
    const elapsed = span({ className: style.elapsed, textContent: "0:00" });
    const cancel = button({
        className: style.cancel,
        textContent: I18n.translate("common.cancel"),
        onclick: () => {
            cancelled = true;
            cancel.disabled = true;
            cancel.textContent = I18n.translate("progress.cancelling");
        },
    });
    const dialog = document.createElement("dialog");
    dialog.className = style.dialog;
    dialog.appendChild(
        div(
            { className: style.container },
            span({ className: style.title, textContent: I18n.translate(title) }),
            stage,
            div({ className: style.track }, bar),
            div({ className: style.row }, percent, elapsed, cancel),
        ),
    );
    // Esc would close the modal and leave the task running unseen: Esc means «Отмена»
    dialog.addEventListener("cancel", (e) => {
        e.preventDefault();
        cancel.click();
    });
    document.body.appendChild(dialog);
    try {
        dialog.showModal();
    } catch {}
    const timer = setInterval(() => {
        elapsed.textContent = clock(Date.now() - started);
    }, 500);

    const progress: IProgress = {
        async report(value, key, ...stageArgs) {
            const next = Math.min(1, Math.max(fraction, value));
            if (next !== fraction) {
                fraction = next;
                bar.style.width = `${(fraction * 100).toFixed(1)}%`;
                percent.textContent = `${Math.floor(fraction * 100)} %`;
                taskbar(Math.max(0.01, fraction));
            }
            if (key !== undefined) stage.textContent = I18n.translate(key, ...stageArgs);
            // a frame for the window (and the «Отмена» click) at most every YIELD_EVERY ms
            if (Date.now() - lastYield >= YIELD_EVERY) {
                await new Promise((resolve) => setTimeout(resolve, 16));
                lastYield = Date.now();
            }
        },
        get cancelled() {
            return cancelled;
        },
        throwIfCancelled() {
            if (cancelled) throw new TaskCancelled();
        },
    };

    taskbar(0.01);
    // let the window paint before the task's first long synchronous step
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
        await task(progress);
    } catch (error) {
        if (error instanceof TaskCancelled) PubSub.default.pub("showToast", "progress.cancelled");
        else PubSub.default.pub("displayError", errorText(error));
    } finally {
        clearInterval(timer);
        taskbar(-1);
        dialog.remove();
    }
}
