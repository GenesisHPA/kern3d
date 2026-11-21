// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.
//
// The BJJCZ LMC protocol (the board EzCAD 2 drives: USB 0x9588:0x9899), ported to TypeScript
// from the MIT-licensed MeerK40t projects — `meerk40t/balormk` (controller.py, usb_connection.py,
// Copyright (c) 2021 meerk40t) and `galvoplotter` (galvo/consts.py, galvo/controller.py,
// Copyright (c) 2023 MeerK40t). Their licence text is in THIRD_PARTY_NOTICES.md. Opcodes,
// packet layout, unit conversions and the correction-file format follow those sources; the
// code is our own.

/** USB identity and bulk endpoints of the board (usb_connection.py). */
export const LMC_VENDOR_ID = 0x9588;
export const LMC_PRODUCT_ID = 0x9899;
export const LMC_ENDPOINT_OUT = 0x02;
export const LMC_ENDPOINT_IN = 0x88;

/** A single command is 12 bytes, a list packet 0xC00 bytes = 256 list commands. */
export const LMC_COMMAND_SIZE = 12;
export const LMC_LIST_SIZE = 0xc00;
export const LMC_LIST_COMMANDS = LMC_LIST_SIZE / LMC_COMMAND_SIZE;

/** Galvo coordinates are 16 bits with the centre of the field at 0x8000. */
export const GALVO_CENTER = 0x8000;
export const GALVO_MAX = 0xffff;

/** Status word bits (the fourth word of every reply). */
export const STATUS_BUSY = 0x04;
export const STATUS_READY = 0x20;

/** List commands: queued in packets, run by the board's list executor. */
export const List = {
    JumpTo: 0x8001,
    EndOfList: 0x8002,
    LaserOnPoint: 0x8003,
    DelayTime: 0x8004,
    MarkTo: 0x8005,
    JumpSpeed: 0x8006,
    LaserOnDelay: 0x8007,
    LaserOffDelay: 0x8008,
    MarkFreq: 0x800a,
    MarkPowerRatio: 0x800b,
    MarkSpeed: 0x800c,
    JumpDelay: 0x800d,
    PolygonDelay: 0x800f,
    WritePort: 0x8011,
    MarkCurrent: 0x8012,
    QSwitchPeriod: 0x801b,
    SetCo2Fpk: 0x801e,
    FiberOpenMO: 0x8021,
    FiberYLPMPulseWidth: 0x8026,
    ReadyMark: 0x8051,
} as const;

/** Single (realtime) commands: answered at once with four status words. */
export const Cmd = {
    DisableLaser: 0x0002,
    EnableLaser: 0x0004,
    ExecuteList: 0x0005,
    SetPwmPulseWidth: 0x0006,
    GetVersion: 0x0007,
    GetSerialNo: 0x0009,
    GetListStatus: 0x000a,
    GetPositionXY: 0x000c,
    GotoXY: 0x000d,
    WriteCorLine: 0x0010,
    ResetList: 0x0012,
    RestartList: 0x0013,
    WriteCorTable: 0x0015,
    SetControlMode: 0x0016,
    SetDelayMode: 0x0017,
    SetEndOfList: 0x0019,
    SetFirstPulseKiller: 0x001a,
    SetLaserMode: 0x001b,
    SetTiming: 0x001c,
    SetStandby: 0x001d,
    SetPwmHalfPeriod: 0x001e,
    StopExecute: 0x001f,
    StopList: 0x0020,
    WritePort: 0x0021,
    WriteAnalogPort1: 0x0022,
    ReadPort: 0x0025,
    SetFpkParam2: 0x002e,
    FiberSetMo: 0x0033,
    DisableZ: 0x0039,
    EnableZ: 0x003a,
    Reset: 0x0040,
    GetMarkTime: 0x0041,
} as const;

/** A command and up to five 16-bit parameters. */
export type LmcCommand = [op: number, v1?: number, v2?: number, v3?: number, v4?: number, v5?: number];

/** The 12 bytes of a command: six little-endian 16-bit words (struct "<6H"). */
export function encodeCommand(command: LmcCommand, into?: Uint8Array, offset = 0): Uint8Array {
    const out = into ?? new Uint8Array(LMC_COMMAND_SIZE);
    for (let i = 0; i < 6; i++) {
        const v = Math.trunc(command[i] ?? 0) & 0xffff;
        out[offset + 2 * i] = v & 0xff;
        out[offset + 2 * i + 1] = v >> 8;
    }
    return out;
}

/** The four little-endian words of an 8-byte reply. */
export function decodeReply(bytes: ArrayLike<number>): [number, number, number, number] {
    const w = (i: number) => (bytes[2 * i] ?? 0) | ((bytes[2 * i + 1] ?? 0) << 8);
    return [w(0), w(1), w(2), w(3)];
}

/**
 * Commands packed into 0xC00-byte list packets, the unused tail filled with "end of list"
 * (0x8002) as the sources do.
 */
export function packLists(commands: readonly LmcCommand[]): Uint8Array[] {
    const packets: Uint8Array[] = [];
    for (let start = 0; start < commands.length; start += LMC_LIST_COMMANDS) {
        const packet = new Uint8Array(LMC_LIST_SIZE);
        for (let k = 0; k < LMC_LIST_COMMANDS; k++) {
            const c = commands[start + k] ?? [List.EndOfList];
            encodeCommand(c, packet, k * LMC_COMMAND_SIZE);
        }
        packets.push(packet);
    }
    return packets;
}

// ---- unit conversions ---------------------------------------------------------------------------

/** Python's round(): halves to even, so the numbers match the reference byte for byte. */
export function roundHalfEven(v: number): number {
    const r = Math.round(v);
    return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** mm/s to galvo units per millisecond (truncated, at most 0xFFFF). */
export function speedWord(mmPerSecond: number, galvosPerMm: number): number {
    return Math.min(0xffff, Math.abs(Math.trunc((mmPerSecond * Math.abs(galvosPerMm)) / 1000)));
}

/** Fiber Q-switch period from the pulse frequency in kHz (base 20000, as in the sources). */
export function qSwitchPeriod(frequencyKhz: number): number {
    return roundHalfEven(20000 / frequencyKhz) & 0xffff;
}

/** Fiber power % to the 12-bit mark current. */
export function markCurrent(powerPercent: number): number {
    return roundHalfEven((Math.max(0, Math.min(100, powerPercent)) * 0xfff) / 100);
}

/** A signed delay in µs as the board takes it: magnitude, then 0x8000 for a negative one. */
export function delayWords(delay: number): [number, number] {
    return [Math.abs(Math.trunc(delay)), delay >= 0 ? 0 : 0x8000];
}

// ---- list commands as the reference builds them -------------------------------------------------

export function jumpTo(x: number, y: number, fromX: number, fromY: number): LmcCommand {
    return [List.JumpTo, x, y, 0, Math.min(0xffff, Math.trunc(Math.hypot(x - fromX, y - fromY)))];
}

export function markTo(x: number, y: number, fromX: number, fromY: number): LmcCommand {
    return [List.MarkTo, x, y, 0, Math.min(0xffff, Math.trunc(Math.hypot(x - fromX, y - fromY)))];
}

export function listDelay(command: number, delay: number): LmcCommand {
    return [command, ...delayWords(delay)];
}

// ---- correction files ---------------------------------------------------------------------------

/** A 65 × 65 grid of corrections, as the board's WriteCorLine takes them. */
export type CorrectionTable = [dx: number, dy: number][];

function corWord(v: number): number {
    return (v >= 0 ? v : -v + 0x8000) & 0xffff;
}

/**
 * An EzCAD .cor file: "LMC1COR_1.0" (UTF-16 label, then a 0x1FA-byte header and 65 × 65 pairs of
 * doubles) or the older integer form (a 0xE-byte header after the label, pairs of int32).
 */
export function parseCorrectionFile(bytes: Uint8Array): CorrectionTable | undefined {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let label = "";
    for (let i = 0; i + 1 < Math.min(0x16, bytes.length); i += 2)
        label += String.fromCharCode(view.getUint16(i, true));
    const isFloat = label.replace(/\0+$/, "") === "LMC1COR_1.0";
    const start = 0x16 + (isFloat ? 0x1fa : 0xe);
    const size = isFloat ? 16 : 8;
    if (bytes.length < start + 65 * 65 * size) return undefined;
    const table: CorrectionTable = [];
    for (let k = 0; k < 65 * 65; k++) {
        const at = start + k * size;
        const dx = isFloat ? roundHalfEven(view.getFloat64(at, true)) : view.getInt32(at, true);
        const dy = isFloat
            ? roundHalfEven(view.getFloat64(at + size / 2, true))
            : view.getInt32(at + 4, true);
        table.push([corWord(dx), corWord(dy)]);
    }
    return table;
}

/** The commands that load a table (or none: a blank, identity correction). */
export function correctionCommands(table: CorrectionTable | undefined): LmcCommand[] {
    if (table === undefined) return [[Cmd.WriteCorTable, 0]];
    return [
        [Cmd.WriteCorTable, 1],
        ...table.map(([dx, dy], i): LmcCommand => [Cmd.WriteCorLine, dx, dy, i === 0 ? 0 : 1]),
    ];
}
