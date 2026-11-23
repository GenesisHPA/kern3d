// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { I18nKeys } from "../i18n";

/**
 * What a long task sees of its progress window: it reports how far it got and which stage it is
 * in, and checks whether the user pressed «Отмена». `report` is awaited — the window repaints
 * only while the task gives the browser a moment, so a task that never awaits shows nothing.
 */
export interface IProgress {
    /** `fraction` 0..1 (clamped; never goes back), `stage` — what is being done now. */
    report(fraction: number, stage?: I18nKeys, ...args: any[]): Promise<void>;
    /** The user asked to stop: finish the current step and throw `TaskCancelled`. */
    readonly cancelled: boolean;
    /** Throws `TaskCancelled` when the user asked to stop. */
    throwIfCancelled(): void;
}

/** Thrown by a task the user stopped: the transaction around it rolls back, no error is shown. */
export class TaskCancelled extends Error {
    constructor() {
        super("cancelled");
        this.name = "TaskCancelled";
    }
}

/** A progress that shows nothing and is never cancelled (tests, callers without a window). */
export const NoProgress: IProgress = {
    report: async () => {},
    cancelled: false,
    throwIfCancelled: () => {},
};

/** A sub-range of a progress: `report(0..1)` lands in `from..to` of the parent. */
export function subProgress(parent: IProgress, from: number, to: number): IProgress {
    return {
        report: (fraction, stage, ...args) =>
            parent.report(from + (to - from) * Math.min(1, Math.max(0, fraction)), stage, ...args),
        get cancelled() {
            return parent.cancelled;
        },
        throwIfCancelled: () => parent.throwIfCancelled(),
    };
}

type ProgressHost = (task: (progress: IProgress) => Promise<void>, title: I18nKeys) => Promise<void>;
let host: ProgressHost | undefined;

/**
 * The UI's progress window (set by the main window). Not a PubSub event: one more event made
 * PubSub's event union too complex for the compiler (TS2590 in every `PubSub.default.remove`).
 */
export function setProgressHost(value: ProgressHost | undefined) {
    host = value;
}

/** Runs a long task under the progress window, or plainly when there is no UI (tests). */
export function runWithProgress(
    task: (progress: IProgress) => Promise<void>,
    title: I18nKeys,
): Promise<void> {
    return host === undefined ? task(NoProgress) : host(task, title);
}
