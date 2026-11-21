// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { GrblTransport } from "./grblController";

/** The part of the Web Serial API used here (Chrome/Edge, and the desktop app's Chromium). */
interface SerialPortLike {
    open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
    close(): Promise<void>;
    readonly readable: ReadableStream<Uint8Array> | null;
    readonly writable: WritableStream<Uint8Array> | null;
    getInfo?(): { usbVendorId?: number; usbProductId?: number };
}

interface SerialLike {
    requestPort(options?: object): Promise<SerialPortLike>;
}

function serialApi(): SerialLike | undefined {
    return (globalThis.navigator as unknown as { serial?: SerialLike } | undefined)?.serial;
}

/** Whether this browser can talk to a serial port at all (Firefox and Safari cannot). */
export function webSerialAvailable(): boolean {
    return serialApi() !== undefined;
}

/**
 * Bytes as they are: every character a single byte (0–255), so the realtime commands above 0x7F
 * (jog cancel 0x85) are not turned into two UTF-8 bytes.
 */
export function toBytes(text: string): Uint8Array {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
}

/** An open serial port: writes go out in order, what arrives is handed to `onData` as text. */
export class WebSerialConnection implements GrblTransport {
    private writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    private closed = false;

    private constructor(
        private readonly port: SerialPortLike,
        private readonly onData: (text: string) => void,
        private readonly onClose: () => void,
    ) {}

    /** Asks the user for a port (the browser's own chooser) and opens it. */
    static async request(
        baud: number,
        onData: (text: string) => void,
        onClose: () => void,
    ): Promise<WebSerialConnection> {
        const api = serialApi();
        if (api === undefined) throw new Error("Web Serial is not available");
        const port = await api.requestPort();
        await port.open({ baudRate: baud, bufferSize: 4096 });
        const connection = new WebSerialConnection(port, onData, onClose);
        connection.writer = port.writable?.getWriter();
        void connection.readLoop();
        return connection;
    }

    private async readLoop() {
        const decoder = new TextDecoder();
        try {
            while (!this.closed && this.port.readable !== null) {
                this.reader = this.port.readable.getReader();
                try {
                    for (;;) {
                        const { value, done } = await this.reader.read();
                        if (done) break;
                        if (value !== undefined) this.onData(decoder.decode(value, { stream: true }));
                    }
                } finally {
                    this.reader.releaseLock();
                    this.reader = undefined;
                }
            }
        } catch {
            // the device went away (unplugged) — reported as closed below
        }
        if (!this.closed) {
            this.closed = true;
            this.onClose();
        }
    }

    async write(data: string): Promise<void> {
        if (this.closed || this.writer === undefined) return;
        await this.writer.write(toBytes(data));
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        try {
            await this.reader?.cancel();
        } catch {}
        try {
            this.writer?.releaseLock();
        } catch {}
        try {
            await this.port.close();
        } catch {}
        this.onClose();
    }
}
