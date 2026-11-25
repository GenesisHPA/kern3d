// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export type BrowserName = "chrome" | "edge" | "opera" | "yandex" | "samsung" | "firefox" | "safari" | "other";
export type BrowserOs = "windows" | "macos" | "linux" | "android" | "ios" | "other";

/** What the app runs in, and which of the browser features it leans on are there. */
export interface BrowserInfo {
    name: BrowserName;
    /** Major version, 0 when unknown. */
    version: number;
    os: BrowserOs;
    /** The Kern3D desktop program (its preload exposes `kern3dDesktop`). */
    desktopApp: boolean;
    phone: boolean;
    tablet: boolean;
    touch: boolean;
    /** USB serial to GRBL machines and RS485 adapters (Chrome/Edge/Opera on a computer). */
    webSerial: boolean;
    /** USB to JCZ (EzCAD) laser boards. */
    webUsb: boolean;
    webGl2: boolean;
}

/** The parts of `navigator` / `globalThis` the detection reads, so a test can hand in its own. */
export interface BrowserEnvironment {
    userAgent: string;
    maxTouchPoints?: number;
    hasSerial?: boolean;
    hasUsb?: boolean;
    hasWebGl2?: boolean;
    desktopApp?: boolean;
}

const NAMES: [RegExp, BrowserName][] = [
    [/YaBrowser\/(\d+)/, "yandex"],
    [/SamsungBrowser\/(\d+)/, "samsung"],
    [/Edg(?:e|A|iOS)?\/(\d+)/, "edge"],
    [/(?:OPR|Opera)\/(\d+)/, "opera"],
    [/(?:Firefox|FxiOS)\/(\d+)/, "firefox"],
    [/(?:Chrome|CriOS)\/(\d+)/, "chrome"],
    [/Version\/(\d+).*Safari\//, "safari"],
];

function browserName(ua: string): [BrowserName, number] {
    for (const [re, name] of NAMES) {
        const m = re.exec(ua);
        if (m) return [name, Number(m[1]) || 0];
    }
    return ["other", 0];
}

function browserOs(ua: string, touchPoints: number): BrowserOs {
    if (/iPhone|iPad|iPod/.test(ua)) return "ios";
    // iPadOS asks for desktop pages and calls itself a Mac; a Mac has no touch screen
    if (/Macintosh/.test(ua)) return touchPoints > 1 ? "ios" : "macos";
    if (/Android/.test(ua)) return "android";
    if (/Windows/.test(ua)) return "windows";
    if (/Linux|CrOS/.test(ua)) return "linux";
    return "other";
}

/** Reads the environment it is given; `detectBrowser()` with no argument reads the real one. */
export function detectBrowser(env: BrowserEnvironment = currentEnvironment()): BrowserInfo {
    const ua = env.userAgent;
    const touchPoints = env.maxTouchPoints ?? 0;
    const [name, version] = browserName(ua);
    const os = browserOs(ua, touchPoints);
    const mobileOs = os === "ios" || os === "android";
    const tablet =
        /iPad|Tablet/.test(ua) ||
        (os === "ios" && /Macintosh/.test(ua)) ||
        (os === "android" && !/Mobile/.test(ua));
    return {
        name,
        version,
        os,
        desktopApp: env.desktopApp ?? false,
        phone: mobileOs && !tablet,
        tablet,
        touch: touchPoints > 0,
        webSerial: env.hasSerial ?? false,
        webUsb: env.hasUsb ?? false,
        webGl2: env.hasWebGl2 ?? false,
    };
}

function currentEnvironment(): BrowserEnvironment {
    const nav = globalThis.navigator as (Navigator & { serial?: unknown; usb?: unknown }) | undefined;
    return {
        userAgent: nav?.userAgent ?? "",
        maxTouchPoints: nav?.maxTouchPoints ?? 0,
        hasSerial: nav?.serial !== undefined,
        hasUsb: nav?.usb !== undefined,
        hasWebGl2: typeof globalThis.WebGL2RenderingContext !== "undefined",
        desktopApp: (globalThis as { kern3dDesktop?: unknown }).kern3dDesktop !== undefined,
    };
}

const LABELS: Record<BrowserName, string> = {
    chrome: "Chrome",
    edge: "Edge",
    opera: "Opera",
    yandex: "Yandex",
    samsung: "Samsung Internet",
    firefox: "Firefox",
    safari: "Safari",
    other: "?",
};

const OS_LABELS: Record<BrowserOs, string> = {
    windows: "Windows",
    macos: "macOS",
    linux: "Linux",
    android: "Android",
    ios: "iOS",
    other: "?",
};

/** "Chrome 131 · Windows", "Kern3D program · Windows". */
export function describeBrowser(info: BrowserInfo): string {
    const name = info.desktopApp ? "Kern3D" : `${LABELS[info.name]}${info.version ? ` ${info.version}` : ""}`;
    return `${name} · ${OS_LABELS[info.os]}`;
}

/**
 * Marks the page with what it runs in (`data-browser`, `data-os`, `data-device`, `data-touch`),
 * for styles that differ per device, and returns the same facts.
 */
export function markDocument(info: BrowserInfo, root: HTMLElement = document.documentElement): BrowserInfo {
    root.setAttribute("data-browser", info.desktopApp ? "desktop-app" : info.name);
    root.setAttribute("data-os", info.os);
    root.setAttribute("data-device", info.phone ? "phone" : info.tablet ? "tablet" : "computer");
    root.setAttribute("data-touch", String(info.touch));
    return info;
}
