// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type CommandKeys, type IApplication, type IService, PubSub, UsageStats } from "@chili3d/core";

const FLUSH_INTERVAL_MS = 60_000;

/** Where the app runs: the desktop shell serves it from kern3d://, everything else is the web. */
export function usagePlatform(location: { protocol: string }, userAgent: string): string {
    if (location.protocol !== "kern3d:") return "web";
    if (/Windows/i.test(userAgent)) return "windows";
    if (/Mac OS X|Macintosh/i.test(userAgent)) return "mac";
    if (/Linux/i.test(userAgent)) return "linux";
    return "desktop";
}

/** Local development and tests never report. */
function isReportingHost(location: { protocol: string; hostname: string }): boolean {
    if (location.protocol === "kern3d:") return true;
    if (location.protocol !== "https:") return false;
    return !["localhost", "127.0.0.1", "::1"].includes(location.hostname);
}

/**
 * Counts what the app is used for — opens, active minutes, which commands run — and sends the
 * counts, with a random installation id, platform and version, once a minute and when the page
 * is hidden. No document content, names or personal data. Off when the user opts out.
 */
export class UsageService implements IService {
    private counts = new Map<string, number>();
    private timer: ReturnType<typeof setInterval> | undefined;

    register(_app: IApplication): void {}

    start(): void {
        if (!this.active()) return;
        this.add("app:open");
        PubSub.default.sub("executeCommand", this.onCommand);
        this.timer = setInterval(this.tick, FLUSH_INTERVAL_MS);
        globalThis.addEventListener?.("pagehide", this.flushNow);
        globalThis.document?.addEventListener?.("visibilitychange", this.onVisibility);
    }

    stop(): void {
        PubSub.default.remove("executeCommand", this.onCommand);
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        globalThis.removeEventListener?.("pagehide", this.flushNow);
        globalThis.document?.removeEventListener?.("visibilitychange", this.onVisibility);
        this.flushNow();
    }

    /** The counts not sent yet (for tests and diagnostics). */
    pending(): Record<string, number> {
        return Object.fromEntries(this.counts);
    }

    add(event: string, count = 1): void {
        this.counts.set(event, (this.counts.get(event) ?? 0) + count);
    }

    private active(): boolean {
        const location = globalThis.location;
        return !!location && isReportingHost(location) && UsageStats.isEnabled();
    }

    private readonly onCommand = (command: CommandKeys) => {
        this.add(`cmd:${command}`);
    };

    private readonly tick = () => {
        if (globalThis.document?.visibilityState === "visible") this.add("app:minute");
        this.flushNow();
    };

    private readonly onVisibility = () => {
        if (globalThis.document?.visibilityState === "hidden") this.flushNow();
    };

    private readonly flushNow = () => {
        if (this.counts.size === 0 || !UsageStats.isEnabled()) return;
        const cid = UsageStats.clientId();
        if (!cid) return;
        const body = JSON.stringify({
            cid,
            p: usagePlatform(globalThis.location, globalThis.navigator?.userAgent ?? ""),
            v: __APP_VERSION__,
            lang: globalThis.navigator?.language ?? "",
            e: this.pending(),
        });
        this.counts.clear();
        // text/plain keeps it a "simple" cross-origin request: no preflight, nothing to read back.
        const blob = new Blob([body], { type: "text/plain" });
        if (globalThis.navigator?.sendBeacon?.(UsageStats.endpoint, blob)) return;
        globalThis
            .fetch?.(UsageStats.endpoint, { method: "POST", body, keepalive: true, mode: "no-cors" })
            .catch(() => {});
    };
}
