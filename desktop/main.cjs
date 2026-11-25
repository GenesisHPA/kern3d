// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Desktop shell for Kern3D: serves the web build from inside the app under a fixed origin
// (kern3d://app) so the projects kept in IndexedDB survive updates, and installs updates
// published as GitHub Releases.

const { app, BrowserWindow, Menu, dialog, net, protocol, session, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SCHEME = "kern3d";
const ORIGIN = `${SCHEME}://app`;
const APP_DIR = path.join(__dirname, "app");
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// An AppImage cannot ship the setuid sandbox helper, and Ubuntu 24.04+ blocks the unprivileged
// user-namespace sandbox for unconfined apps — without this the AppImage does not start there.
// The window only ever shows the bundled app (outside links open in the browser).
if (process.platform === "linux" && process.env.APPIMAGE) app.commandLine.appendSwitch("no-sandbox");

protocol.registerSchemesAsPrivileged([
    {
        scheme: SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
]);

/** Maps kern3d://app/<path> to a file of the bundled web build; nothing outside it is reachable. */
function serveBundledApp() {
    protocol.handle(SCHEME, (request) => {
        let relative = decodeURIComponent(new URL(request.url).pathname);
        if (relative === "/" || relative === "") relative = "/index.html";
        const file = path.normalize(path.join(APP_DIR, relative));
        if (!file.startsWith(APP_DIR + path.sep)) {
            return new Response("Not found", { status: 404 });
        }
        return net.fetch(pathToFileURL(file).toString());
    });
}

function isInternal(url) {
    return url.startsWith(`${ORIGIN}/`) || url === ORIGIN;
}

function openExternally(url) {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url);
}

/** The page refuses to unload while a document is open; ask instead of silently staying open. */
function confirmCloseWithOpenDocument(win) {
    win.webContents.on("will-prevent-unload", (event) => {
        const choice = dialog.showMessageBoxSync(win, {
            type: "question",
            buttons: ["Закрыть", "Отмена"],
            defaultId: 1,
            cancelId: 1,
            title: "Kern3D",
            message: "Закрыть Kern3D?",
            detail: "Несохранённые изменения в открытых документах будут потеряны.",
        });
        if (choice === 0) event.preventDefault(); // preventDefault here lets the unload proceed
    });
}

/** A serial port as the picker lists it: its name and, for USB adapters, the vendor/product ids. */
function portLabel(port) {
    const ids = port.vendorId ? ` (USB ${port.vendorId}:${port.productId ?? "?"})` : "";
    return `${port.displayName || port.portName || port.portId}${port.portName && port.displayName ? ` — ${port.portName}` : ""}${ids}`;
}

/**
 * Web Serial for the laser workspace (a GRBL engraver on a COM port). Chromium in Electron
 * has no port chooser of its own: the page's `navigator.serial.requestPort()` arrives here
 * as `select-serial-port`, answered with the only port there is, or with the one picked in a
 * small dialog when there are several. Permission is granted to our own origin only.
 */
function enableWebSerial(win) {
    const ses = win.webContents.session ?? session.defaultSession;
    ses.on("select-serial-port", (event, portList, _webContents, callback) => {
        event.preventDefault();
        if (portList.length === 0) {
            dialog.showMessageBox(win, {
                type: "warning",
                title: "Kern3D",
                message: "Последовательные порты не найдены.",
                detail: "Подключите гравёр по USB и проверьте, что установлен драйвер (CH340, CP210x, FTDI).",
            });
            callback("");
            return;
        }
        if (portList.length === 1) {
            callback(portList[0].portId);
            return;
        }
        const buttons = [...portList.map(portLabel), "Отмена"];
        dialog
            .showMessageBox(win, {
                type: "question",
                title: "Kern3D",
                message: "Выберите порт гравёра",
                buttons,
                cancelId: buttons.length - 1,
                noLink: true,
            })
            .then(({ response }) => callback(response < portList.length ? portList[response].portId : ""))
            .catch(() => callback(""));
    });
    // WebUSB for a JCZ (EzCAD) galvo board: the page asks for VID 0x9588 / PID 0x9899 only,
    // so the first device offered is the board; none offered means a driver other than WinUSB
    ses.on("select-usb-device", (event, details, callback) => {
        event.preventDefault();
        if (details.deviceList.length === 0) {
            dialog.showMessageBox(win, {
                type: "warning",
                title: "Kern3D",
                message: "Плата JCZ (EzCAD) не найдена.",
                detail: "Подключите станок по USB. Если установлен драйвер EzCAD (Lmcv4u), замените его на WinUSB программой Zadig (устройство USB\\VID_9588&PID_9899).",
            });
            callback();
            return;
        }
        callback(details.deviceList[0].deviceId);
    });
    const allowed = (origin) => isInternal(origin) || origin === ORIGIN;
    ses.setPermissionCheckHandler((_webContents, permission, origin) => {
        if (permission === "serial" || permission === "usb") return allowed(origin);
        return true;
    });
    ses.setDevicePermissionHandler((details) => {
        if (details.deviceType === "serial" || details.deviceType === "usb") return allowed(details.origin);
        return false;
    });
}

/** desktop/scripts/usb-driver.ps1, next to the app when packaged. */
function usbDriverScript() {
    return app.isPackaged
        ? path.join(process.resourcesPath, "usb-driver.ps1")
        : path.join(__dirname, "scripts", "usb-driver.ps1");
}

function runPowerShell(args) {
    const { execFile } = require("node:child_process");
    return new Promise((resolve) => {
        execFile(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args],
            { windowsHide: true, timeout: 180000 },
            (error, stdout, stderr) => resolve({ error, stdout: String(stdout), stderr: String(stderr) }),
        );
    });
}

function lastJson(text) {
    const line = text.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    try {
        return JSON.parse(line);
    } catch {
        return undefined;
    }
}

/**
 * The JCZ board's Windows driver: its status, and a switch to WinUSB or back to EzCAD's own,
 * run by the bundled script with administrator rights (Windows asks the user). Only our own
 * page may ask, and only for these two targets.
 */
function enableUsbDriverSwitch() {
    const { ipcMain } = require("electron");
    const fs = require("node:fs");
    const os = require("node:os");
    const fromApp = (event) => isInternal(event.senderFrame?.url ?? "");
    ipcMain.handle("usb-driver:status", async (event) => {
        if (process.platform !== "win32" || !fromApp(event)) return { found: false, driver: "unsupported" };
        const r = await runPowerShell(["-File", usbDriverScript(), "-Action", "status"]);
        return lastJson(r.stdout) ?? { found: false, driver: "none", error: r.stderr || r.error?.message };
    });
    ipcMain.handle("usb-driver:install", async (event, to) => {
        if (process.platform !== "win32" || !fromApp(event)) return { ok: false, error: "unsupported" };
        if (to !== "winusb" && to !== "ezcad") return { ok: false, error: "bad target" };
        const log = path.join(os.tmpdir(), `kern3d-usb-driver-${Date.now()}.json`);
        const q = (s) => `'${s.replace(/'/g, "''")}'`;
        const inner = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `"${usbDriverScript()}"`]
            .concat(["-Action", "install", "-To", to, "-Log", `"${log}"`])
            .map(q)
            .join(",");
        // the elevated copy runs hidden; a refused rights prompt makes Start-Process throw
        const r = await runPowerShell([
            "-Command",
            `try { Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList ${inner} -ErrorAction Stop } catch { 'cancelled' }`,
        ]);
        let result;
        try {
            result = JSON.parse(fs.readFileSync(log, "utf8").replace(/^﻿/, ""));
            fs.rmSync(log, { force: true });
        } catch {
            result = {
                ok: false,
                error: r.stdout.includes("cancelled") ? "cancelled" : r.stderr || "no result",
            };
        }
        return result;
    });
}

/**
 * The fonts installed in Windows (the machine's and the user's own), for laser text without a
 * download or the browser's font-access prompt: one upright regular face per family, read from
 * the registry. Only files the registry lists can be read back.
 */
function enableSystemFonts() {
    const { ipcMain } = require("electron");
    const fs = require("node:fs");
    const fromApp = (event) => isInternal(event.senderFrame?.url ?? "");
    const STYLE =
        /\b(bold|italic|oblique|light|semilight|semibold|demibold|thin|extralight|ultralight|medium|heavy)\b/i;
    let families; // Map family -> file
    const load = async () => {
        if (families !== undefined) return families;
        families = new Map();
        if (process.platform !== "win32") return families;
        const keys = [
            "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
            "HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
        ];
        const script =
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $o=@(); " +
            keys
                .map(
                    (k) =>
                        `$p=Get-ItemProperty '${k}' -ErrorAction SilentlyContinue; if($p){$p.PSObject.Properties | ` +
                        "Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $o += ,@($_.Name, [string]$_.Value) }};",
                )
                .join(" ") +
            " ConvertTo-Json -Compress -InputObject $o";
        const r = await runPowerShell(["-Command", script]);
        let rows = [];
        try {
            rows = JSON.parse(r.stdout.trim() || "[]");
        } catch {
            rows = [];
        }
        const dir = path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts");
        for (const [name, value] of rows) {
            if (typeof name !== "string" || typeof value !== "string") continue;
            if (!/\.(ttf|otf)$/i.test(value)) continue; // collections (.ttc) are not read
            const family = name.replace(/\s*\((TrueType|OpenType)\)\s*$/i, "").trim();
            if (family === "" || family.includes("&") || STYLE.test(family)) continue;
            const file = path.isAbsolute(value) ? value : path.join(dir, value);
            if (!families.has(family) && fs.existsSync(file)) families.set(family, file);
        }
        return families;
    };
    ipcMain.on("progress:set", (event, value) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        const v = Number(value);
        if (win && !win.isDestroyed() && Number.isFinite(v)) win.setProgressBar(v < 0 ? -1 : Math.min(1, v));
    });
    ipcMain.handle("fonts:list", async (event) => {
        if (!fromApp(event)) return [];
        return [...(await load()).keys()].sort((a, b) => a.localeCompare(b)).map((family) => ({ family }));
    });
    ipcMain.handle("fonts:read", async (event, family) => {
        if (!fromApp(event) || typeof family !== "string") return undefined;
        const file = (await load()).get(family);
        if (file === undefined) return undefined;
        const bytes = await fs.promises.readFile(file);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    });
}

/**
 * `--station`: the machine station by the mill — the «Kern3D Станок» page full screen (kiosk),
 * no modeller. Started like this from the station PC's autostart.
 */
const STATION = process.argv.includes("--station");

function createWindow() {
    const win = new BrowserWindow({
        width: STATION ? 1200 : 1440,
        height: STATION ? 1920 : 900,
        minWidth: STATION ? 400 : 960,
        minHeight: STATION ? 600 : 600,
        kiosk: STATION,
        title: STATION ? "Kern3D Станок" : "Kern3D",
        icon: path.join(__dirname, "icon.png"),
        backgroundColor: STATION ? "#0f1013" : "#1F2429",
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            preload: path.join(__dirname, "preload.cjs"),
        },
    });
    win.once("ready-to-show", () => win.show());
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (isInternal(url)) return { action: "allow" };
        openExternally(url);
        return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
        if (isInternal(url)) return;
        event.preventDefault();
        openExternally(url);
    });
    if (!STATION) confirmCloseWithOpenDocument(win);
    enableWebSerial(win);
    win.loadURL(`${ORIGIN}/${STATION ? "station.html" : "index.html"}`);
    return win;
}

function setupUpdates(win) {
    if (!app.isPackaged) return;
    const { autoUpdater } = require("electron-updater");
    const fs = require("node:fs");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    const updaterLog = path.join(app.getPath("userData"), "updater.log");
    const log = (line) => {
        try {
            fs.appendFileSync(updaterLog, `${new Date().toISOString()} ${line}\n`);
        } catch {}
    };
    const setProgress = (value) => {
        if (!win.isDestroyed()) win.setProgressBar(value);
    };
    autoUpdater.on("update-available", (info) => log(`available ${info.version}, downloading`));
    autoUpdater.on("download-progress", (p) => setProgress(Math.max(0.01, (p.percent ?? 0) / 100)));
    autoUpdater.on("update-downloaded", async (info) => {
        setProgress(-1);
        log(`downloaded ${info.version}`);
        const { response } = await dialog.showMessageBox(win, {
            type: "info",
            buttons: ["Перезапустить сейчас", "Позже"],
            defaultId: 0,
            cancelId: 1,
            title: "Обновление Kern3D",
            message: `Загружена новая версия Kern3D ${info.version}.`,
            detail:
                "Сохраните проект и перезапустите программу, чтобы установить обновление. " +
                "Если выбрать «Позже», оно установится при следующем закрытии Kern3D.",
        });
        if (response === 0) autoUpdater.quitAndInstall();
    });
    autoUpdater.on("error", (error) => {
        setProgress(-1);
        log(`error ${error?.message ?? error}`);
        console.error("[updater]", error?.message ?? error);
    });
    const check = () => autoUpdater.checkForUpdates().catch(() => {});
    check();
    setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    let mainWindow;
    app.on("second-instance", () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });
    app.whenReady().then(() => {
        Menu.setApplicationMenu(null);
        serveBundledApp();
        enableUsbDriverSwitch();
        enableSystemFonts();
        mainWindow = createWindow();
        setupUpdates(mainWindow);
    });
    app.on("window-all-closed", () => app.quit());
}
