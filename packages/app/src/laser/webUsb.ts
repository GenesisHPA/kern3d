// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { LmcTransport } from "./jczDriver";
import { LMC_ENDPOINT_IN, LMC_ENDPOINT_OUT, LMC_PRODUCT_ID, LMC_VENDOR_ID } from "./lmc";

/** The part of WebUSB used here (Chrome, Edge, the desktop app). */
interface UsbDeviceLike {
    readonly vendorId: number;
    readonly productId: number;
    readonly configuration: unknown;
    open(): Promise<void>;
    close(): Promise<void>;
    selectConfiguration(value: number): Promise<void>;
    claimInterface(index: number): Promise<void>;
    releaseInterface(index: number): Promise<void>;
    transferOut(endpoint: number, data: Uint8Array): Promise<{ status: string }>;
    transferIn(endpoint: number, length: number): Promise<{ status: string; data?: DataView }>;
}

interface UsbLike {
    getDevices(): Promise<UsbDeviceLike[]>;
    requestDevice(options: { filters: { vendorId: number; productId: number }[] }): Promise<UsbDeviceLike>;
}

function usbApi(): UsbLike | undefined {
    return (globalThis.navigator as unknown as { usb?: UsbLike } | undefined)?.usb;
}

export function webUsbAvailable(): boolean {
    return usbApi() !== undefined;
}

/**
 * Why the board could not be opened, worded for the help it calls for: no WebUSB at all, the
 * board not offered (on Windows: EzCAD's own driver holds it — it needs WinUSB), or offered
 * but refused (in use by EzCAD, or no permission).
 */
export type UsbOpenFailure = "unavailable" | "notListed" | "openFailed";

export class UsbOpenError extends Error {
    constructor(
        readonly failure: UsbOpenFailure,
        message: string,
    ) {
        super(message);
    }
}

const isBoard = (d: UsbDeviceLike) => d.vendorId === LMC_VENDOR_ID && d.productId === LMC_PRODUCT_ID;

/** Finds (or asks the user for) the LMC board and claims it, as the reference's USB connection does. */
export async function openLmcUsb(): Promise<LmcTransport> {
    const usb = usbApi();
    if (usb === undefined) throw new UsbOpenError("unavailable", "WebUSB is not available");
    let device = (await usb.getDevices()).find(isBoard);
    if (device === undefined) {
        try {
            device = await usb.requestDevice({
                filters: [{ vendorId: LMC_VENDOR_ID, productId: LMC_PRODUCT_ID }],
            });
        } catch (error) {
            throw new UsbOpenError("notListed", String((error as Error)?.message ?? error));
        }
    }
    try {
        await device.open();
        if (device.configuration === null) await device.selectConfiguration(1);
        await device.claimInterface(0);
    } catch (error) {
        await device.close().catch(() => {});
        throw new UsbOpenError("openFailed", String((error as Error)?.message ?? error));
    }
    const board = device;
    const transferIn = async () => {
        const result = await board.transferIn(LMC_ENDPOINT_IN & 0x7f, 8);
        if (result.status !== "ok" || result.data === undefined)
            throw new Error(`USB read: ${result.status}`);
        return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
    };
    /** WebUSB cannot cancel a read: one still waiting from the drain takes the next reply. */
    let pending: Promise<Uint8Array> | undefined;
    return {
        async write(bytes) {
            const result = await board.transferOut(LMC_ENDPOINT_OUT & 0x7f, bytes);
            if (result.status !== "ok") throw new Error(`USB write: ${result.status}`);
        },
        read() {
            const p = pending ?? transferIn();
            pending = undefined;
            return p;
        },
        async drain() {
            let stale = 0;
            for (let i = 0; i < 8; i++) {
                const p = transferIn();
                const got = await Promise.race([p, new Promise<undefined>((r) => setTimeout(r, 150))]);
                if (got === undefined) {
                    pending = p;
                    break;
                }
                stale++;
            }
            return stale;
        },
        async close() {
            await board.releaseInterface(0).catch(() => {});
            await board.close().catch(() => {});
        },
    };
}
