// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describeBrowser, detectBrowser, markDocument } from "../src/foundation/browserInfo";

const UA = {
    chromeWin:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    edgeWin:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
    yandex: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10.0.0 Safari/537.36",
    firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    safariMac:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    chromeIphone:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
    androidPhone:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    androidTablet:
        "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    samsung:
        "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
};

describe("detectBrowser", () => {
    test.each([
        ["chromeWin", "chrome", 131, "windows", false],
        ["edgeWin", "edge", 131, "windows", false],
        ["yandex", "yandex", 24, "windows", false],
        ["firefoxLinux", "firefox", 133, "linux", false],
        ["safariMac", "safari", 18, "macos", false],
        ["iphone", "safari", 18, "ios", true],
        ["chromeIphone", "chrome", 131, "ios", true],
        ["androidPhone", "chrome", 131, "android", true],
        ["samsung", "samsung", 26, "android", true],
    ] as const)("%s → %s %i on %s, phone %s", (key, name, version, os, phone) => {
        const info = detectBrowser({ userAgent: UA[key], maxTouchPoints: phone ? 5 : 0 });
        expect(info.name).toBe(name);
        expect(info.version).toBe(version);
        expect(info.os).toBe(os);
        expect(info.phone).toBe(phone);
    });

    test("an Android tablet and an iPad asking for the desktop page are tablets, not phones", () => {
        const android = detectBrowser({ userAgent: UA.androidTablet, maxTouchPoints: 5 });
        expect([android.tablet, android.phone]).toEqual([true, false]);
        const ipad = detectBrowser({ userAgent: UA.safariMac, maxTouchPoints: 5 });
        expect([ipad.os, ipad.tablet, ipad.phone]).toEqual(["ios", true, false]);
    });

    test("the features and the desktop program are reported as handed in", () => {
        const info = detectBrowser({
            userAgent: UA.chromeWin,
            hasSerial: true,
            hasUsb: true,
            desktopApp: true,
        });
        expect([info.webSerial, info.webUsb, info.desktopApp]).toEqual([true, true, true]);
        expect(describeBrowser(info)).toBe("Kern3D · Windows");
        expect(describeBrowser(detectBrowser({ userAgent: UA.firefoxLinux }))).toBe("Firefox 133 · Linux");
    });

    test("markDocument writes the facts as data attributes", () => {
        const root = document.createElement("div");
        markDocument(detectBrowser({ userAgent: UA.iphone, maxTouchPoints: 5 }), root);
        expect(root.dataset).toMatchObject({ browser: "safari", os: "ios", device: "phone", touch: "true" });
    });
});
