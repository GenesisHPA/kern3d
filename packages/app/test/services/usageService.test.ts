// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PubSub, UsageStats } from "@chili3d/core";
import { afterEach, describe, expect, rs, test } from "@rstest/core";
import { UsageService, usagePlatform } from "../../src/services/usageService";

describe("usagePlatform", () => {
    test.each([
        ["https:", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "web"],
        ["kern3d:", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/45", "windows"],
        ["kern3d:", "Mozilla/5.0 (X11; Linux x86_64) Electron/45", "linux"],
        ["kern3d:", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Electron/45", "mac"],
    ])("%s + %s -> %s", (protocol, ua, expected) => {
        expect(usagePlatform({ protocol }, ua)).toBe(expected);
    });
});

describe("UsageService", () => {
    afterEach(() => {
        rs.unstubAllGlobals();
        localStorage.removeItem(UsageStats.optOutKey);
        localStorage.removeItem(UsageStats.clientIdKey);
    });

    function stubSite(protocol: string, hostname: string) {
        rs.stubGlobal("location", { protocol, hostname, href: `${protocol}//${hostname}/` });
    }

    test("stays silent on a local development host", () => {
        stubSite("http:", "localhost");
        const service = new UsageService();
        service.start();
        try {
            PubSub.default.pub("executeCommand", "doc.new" as any);
            expect(service.pending()).toEqual({});
        } finally {
            service.stop();
        }
    });

    test("counts the open and every command on the published site", () => {
        stubSite("https:", "genesishpa.github.io");
        const sent: Blob[] = [];
        rs.stubGlobal("navigator", {
            ...navigator,
            sendBeacon: (_url: string, body: Blob) => {
                sent.push(body);
                return true;
            },
        });
        const service = new UsageService();
        service.start();
        PubSub.default.pub("executeCommand", "doc.new" as any);
        PubSub.default.pub("executeCommand", "doc.new" as any);
        expect(service.pending()).toEqual({ "app:open": 1, "cmd:doc.new": 2 });
        service.stop();
        expect(sent.length).toBe(1);
        expect(service.pending()).toEqual({});
    });

    test("sends the counts with installation id, platform and version", async () => {
        stubSite("https:", "genesishpa.github.io");
        let payload: any;
        rs.stubGlobal("navigator", {
            ...navigator,
            sendBeacon: (url: string, body: Blob) => {
                expect(url).toBe(UsageStats.endpoint);
                payload = body;
                return true;
            },
        });
        const service = new UsageService();
        service.start();
        service.stop();
        const data = JSON.parse(await (payload as Blob).text());
        expect(data.cid).toBe(localStorage.getItem(UsageStats.clientIdKey));
        expect(data.p).toBe("web");
        expect(data.e).toEqual({ "app:open": 1 });
        expect(typeof data.v).toBe("string");
    });

    test("does nothing when statistics are switched off", () => {
        stubSite("https:", "genesishpa.github.io");
        UsageStats.setEnabled(false);
        const service = new UsageService();
        service.start();
        try {
            PubSub.default.pub("executeCommand", "doc.new" as any);
            expect(service.pending()).toEqual({});
        } finally {
            service.stop();
        }
    });
});
