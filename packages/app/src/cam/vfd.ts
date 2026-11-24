// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The spindle's frequency inverter (VFD) over RS485 (a USB–RS485 adapter on the computer, or
 * the controller's own port): start forward / reverse, stop, set the speed, read it back. The
 * same protocols grblHAL's spindle drivers speak: Huanyang's own (HY02D…, the common Chinese
 * inverters) and plain Modbus RTU with the registers set per model (H100, YL620, Fuling, GS2,
 * Delta…; presets below). The rpm becomes Hz by the spindle's max rpm at its max frequency.
 */
export const VFD_PROTOCOLS = ["huanyang", "modbus"] as const;
export type VfdProtocol = (typeof VFD_PROTOCOLS)[number];

export interface VfdSettings {
    protocol: VfdProtocol;
    /** Modbus slave address (PD163 on a Huanyang). */
    address: number;
    baudRate: number;
    /** The spindle at `maxHz` turns `maxRpm`. */
    maxRpm: number;
    maxHz: number;
    minRpm: number;
    /** Plain Modbus: the control word register and its values, the frequency register and units. */
    controlRegister: number;
    runForward: number;
    runReverse: number;
    stop: number;
    frequencyRegister: number;
    /** Register units per Hz (×100 for 0.01 Hz). */
    frequencyScale: number;
    /** Where the running frequency is read back (0 — not read). */
    outputRegister: number;
}

/** Register maps of common inverters (their manuals); Huanyang needs none. */
export const VFD_PRESETS: Record<string, Partial<VfdSettings>> = {
    "Huanyang HY": { protocol: "huanyang", maxHz: 400 },
    H100: {
        protocol: "modbus",
        controlRegister: 0x2000,
        runForward: 1,
        runReverse: 2,
        stop: 6,
        frequencyRegister: 0x2001,
        frequencyScale: 10,
        outputRegister: 0x3000,
    },
    "YL620-A": {
        protocol: "modbus",
        controlRegister: 0x2000,
        runForward: 0x12,
        runReverse: 0x22,
        stop: 0x01,
        frequencyRegister: 0x2001,
        frequencyScale: 10,
        outputRegister: 0x200b,
    },
    "Fuling DZB": {
        protocol: "modbus",
        controlRegister: 0x1000,
        runForward: 1,
        runReverse: 2,
        stop: 5,
        frequencyRegister: 0x1001,
        frequencyScale: 100,
        outputRegister: 0x2001,
    },
};

export function defaultVfd(): VfdSettings {
    return {
        protocol: "huanyang",
        address: 1,
        baudRate: 9600,
        maxRpm: 24000,
        maxHz: 400,
        minRpm: 6000,
        controlRegister: 0x2000,
        runForward: 1,
        runReverse: 2,
        stop: 6,
        frequencyRegister: 0x2001,
        frequencyScale: 100,
        outputRegister: 0,
    };
}

/** Modbus CRC-16 (poly 0xA001, init 0xFFFF), sent low byte first. */
export function crc16(bytes: ArrayLike<number>): number {
    let crc = 0xffff;
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i] & 0xff;
        for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    return crc;
}

export function frame(body: number[]): Uint8Array {
    const crc = crc16(body);
    return Uint8Array.from([...body, crc & 0xff, crc >> 8]);
}

export function checkFrame(bytes: Uint8Array): boolean {
    if (bytes.length < 4) return false;
    const crc = crc16(bytes.subarray(0, bytes.length - 2));
    return bytes[bytes.length - 2] === (crc & 0xff) && bytes[bytes.length - 1] === crc >> 8;
}

/** The speed asked as the inverter's frequency, Hz (clamped to its range). */
export function rpmToHz(rpm: number, s: VfdSettings): number {
    if (rpm <= 0) return 0;
    const r = Math.min(s.maxRpm, Math.max(s.minRpm, rpm));
    return (r / s.maxRpm) * s.maxHz;
}

/** Frames for one command. */
export function commandFrames(
    s: VfdSettings,
    command: { kind: "run"; rpm: number; reverse?: boolean } | { kind: "stop" } | { kind: "read" },
): Uint8Array[] {
    const a = s.address & 0xff;
    if (s.protocol === "huanyang") {
        // Huanyang's own functions: 0x03 control (0x01 forward, 0x11 reverse, 0x08 stop),
        // 0x05 frequency in 0.01 Hz, 0x04 status read (0x00 = set frequency, 0x01 = output)
        if (command.kind === "stop") return [frame([a, 0x03, 0x01, 0x08])];
        if (command.kind === "read") return [frame([a, 0x04, 0x03, 0x01, 0x00, 0x00])];
        const f = Math.round(rpmToHz(command.rpm, s) * 100);
        return [
            frame([a, 0x05, 0x02, (f >> 8) & 0xff, f & 0xff]),
            frame([a, 0x03, 0x01, command.reverse ? 0x11 : 0x01]),
        ];
    }
    const write = (reg: number, value: number) =>
        frame([a, 0x06, (reg >> 8) & 0xff, reg & 0xff, (value >> 8) & 0xff, value & 0xff]);
    if (command.kind === "stop") return [write(s.controlRegister, s.stop)];
    if (command.kind === "read") {
        if (s.outputRegister <= 0) return [];
        return [frame([a, 0x03, (s.outputRegister >> 8) & 0xff, s.outputRegister & 0xff, 0x00, 0x01])];
    }
    const f = Math.round(rpmToHz(command.rpm, s) * s.frequencyScale);
    return [
        write(s.frequencyRegister, Math.min(0xffff, f)),
        write(s.controlRegister, command.reverse ? s.runReverse : s.runForward),
    ];
}

/** The spindle's speed from a read reply, rpm; undefined when the reply is not one. */
export function parseSpeed(s: VfdSettings, reply: Uint8Array): number | undefined {
    if (!checkFrame(reply)) return undefined;
    let raw: number;
    let scale: number;
    if (s.protocol === "huanyang") {
        if (reply[1] !== 0x04 || reply.length < 8) return undefined;
        raw = (reply[4] << 8) | reply[5];
        scale = 100;
    } else {
        if (reply[1] !== 0x03 || reply.length < 7) return undefined;
        raw = (reply[3] << 8) | reply[4];
        scale = s.frequencyScale;
    }
    return Math.round((raw / scale / s.maxHz) * s.maxRpm);
}

/** What the VFD needs of a serial port: bytes out, bytes back (with a time limit). */
export interface VfdTransport {
    write(bytes: Uint8Array): Promise<void>;
    read(timeoutMs: number): Promise<Uint8Array | undefined>;
}

/**
 * The spindle controlled from Kern3D: the G-code's S / M3 / M4 / M5 sent to the inverter as
 * the program runs (the controller itself then needs no spindle wiring), and the speed polled.
 */
export class VfdSpindle {
    lastRpm: number | undefined;
    constructor(
        private readonly transport: VfdTransport,
        public settings: VfdSettings,
    ) {}

    /** One exchange at a time on the line: commands and speed reads queue up. */
    private queue: Promise<unknown> = Promise.resolve();

    private send(frames: Uint8Array[]): Promise<Uint8Array | undefined> {
        const next = this.queue.then(() => this.exchange(frames));
        this.queue = next.catch(() => {});
        return next;
    }

    private async exchange(frames: Uint8Array[]): Promise<Uint8Array | undefined> {
        let reply: Uint8Array | undefined;
        for (const f of frames) {
            await this.transport.write(f);
            reply = await this.transport.read(200);
        }
        return reply;
    }

    run(rpm: number, reverse = false) {
        return this.send(commandFrames(this.settings, { kind: "run", rpm, reverse }));
    }

    stop() {
        return this.send(commandFrames(this.settings, { kind: "stop" }));
    }

    async readRpm(): Promise<number | undefined> {
        const reply = await this.send(commandFrames(this.settings, { kind: "read" }));
        this.lastRpm = reply === undefined ? undefined : parseSpeed(this.settings, reply);
        return this.lastRpm;
    }

    /** A G-code line's spindle words acted on: M3 / M4 with the last S, M5 stop. */
    private s = 0;
    async onLine(line: string) {
        const code = line.replace(/\(.*?\)|;.*/g, "").toUpperCase();
        const sWord = /S\s*(-?\d+(\.\d+)?)/.exec(code);
        if (sWord) this.s = Number(sWord[1]);
        if (/M0*3(?!\d)/.test(code)) await this.run(this.s);
        else if (/M0*4(?!\d)/.test(code)) await this.run(this.s, true);
        else if (/M0*5(?!\d)|M30|M0*2(?!\d)/.test(code)) await this.stop();
    }
}
