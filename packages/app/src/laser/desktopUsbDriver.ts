// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The Windows driver of a JCZ (EzCAD) board, as the Kern3D desktop app can switch it: the page
 * reaches the board over WebUSB only through WinUSB, EzCAD only through its own driver. A plain
 * browser has none of this (`desktopUsbDriver()` is undefined there).
 */

export type BoardDriver = "winusb" | "ezcad" | "other" | "none" | "unsupported";

export interface BoardDriverStatus {
    found: boolean;
    driver: BoardDriver;
    /** EzCAD's own driver package is installed, so a switch back is possible. */
    ezcadAvailable?: boolean;
    ok?: boolean;
    error?: string;
}

export interface DesktopUsbDriver {
    status(): Promise<BoardDriverStatus>;
    install(to: "winusb" | "ezcad"): Promise<BoardDriverStatus>;
}

export function desktopUsbDriver(): DesktopUsbDriver | undefined {
    const api = (globalThis as { kern3dDesktop?: { usbDriver?: DesktopUsbDriver } }).kern3dDesktop;
    return api?.usbDriver;
}
