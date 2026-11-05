// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Desktop shell for Kern3D: serves the web build from inside the app under a fixed origin
// (kern3d://app) so the projects kept in IndexedDB survive updates, and installs updates
// published as GitHub Releases.

const { app, BrowserWindow, Menu, dialog, net, protocol, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SCHEME = "kern3d";
const ORIGIN = `${SCHEME}://app`;
const APP_DIR = path.join(__dirname, "app");
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

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

function createWindow() {
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 960,
        minHeight: 600,
        title: "Kern3D",
        icon: path.join(__dirname, "icon.png"),
        backgroundColor: "#1F2429",
        autoHideMenuBar: true,
        show: false,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
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
    confirmCloseWithOpenDocument(win);
    win.loadURL(`${ORIGIN}/index.html`);
    return win;
}

function setupUpdates(win) {
    if (!app.isPackaged) return;
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-downloaded", async (info) => {
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
    autoUpdater.on("error", (error) => console.error("[updater]", error?.message ?? error));
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
        mainWindow = createWindow();
        setupUpdates(mainWindow);
    });
    app.on("window-all-closed", () => app.quit());
}
