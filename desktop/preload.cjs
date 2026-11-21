// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// What the desktop shell offers the page beyond the browser: switching the Windows driver of a
// JCZ (EzCAD) laser board between EzCAD's own and WinUSB (which the page talks to over WebUSB).

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kern3dDesktop", {
    usbDriver: {
        /** {found, driver: "winusb" | "ezcad" | "other" | "none", ezcadAvailable} */
        status: () => ipcRenderer.invoke("usb-driver:status"),
        /** Asks Windows for administrator rights and switches; resolves with the new status. */
        install: (to) => ipcRenderer.invoke("usb-driver:install", to),
    },
    fonts: {
        /** The installed font families with an upright regular face: [{family}] */
        list: () => ipcRenderer.invoke("fonts:list"),
        /** The regular face's file of a listed family, as an ArrayBuffer (undefined if unknown). */
        read: (family) => ipcRenderer.invoke("fonts:read", family),
    },
});
