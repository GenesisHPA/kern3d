// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Anonymous usage statistics: whether they are sent, and the random id of this installation.
 * Nothing personal is ever stored or sent — the id is a random UUID made on first run.
 */
export const UsageStats = {
    endpoint: "https://genesistactical.net/kern3d/api/usage",
    optOutKey: "kern3d.usage.optOut",
    clientIdKey: "kern3d.usage.cid",

    isEnabled(): boolean {
        try {
            return globalThis.localStorage?.getItem(this.optOutKey) !== "1";
        } catch {
            return false;
        }
    },

    setEnabled(enabled: boolean): void {
        try {
            if (enabled) globalThis.localStorage?.removeItem(this.optOutKey);
            else globalThis.localStorage?.setItem(this.optOutKey, "1");
        } catch {
            // Storage blocked: stats simply stay off (isEnabled() reports false).
        }
    },

    clientId(): string | undefined {
        try {
            const storage = globalThis.localStorage;
            if (!storage) return undefined;
            let id = storage.getItem(this.clientIdKey);
            if (!id) {
                id =
                    globalThis.crypto?.randomUUID?.() ??
                    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
                storage.setItem(this.clientIdKey, id);
            }
            return id;
        } catch {
            return undefined;
        }
    },
};
