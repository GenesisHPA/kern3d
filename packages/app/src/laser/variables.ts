// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Variables in a text or a barcode's data, filled in when the job is laid out:
 * `{N}` — the serial number (zero-padded to `digits`), `{date}` — dd.mm.yyyy, `{time}` — hh:mm,
 * `{year}`, `{month}`, `{day}`. After every finished marking the serial moves on by `step`.
 */
export interface SerialSettings {
    /** The number the next marking gets. */
    next: number;
    step: number;
    /** Zero-padded to this many digits (0 — as it is). */
    digits: number;
}

export function defaultSerial(): SerialSettings {
    return { next: 1, step: 1, digits: 4 };
}

export function parseSerial(raw: any): SerialSettings | undefined {
    if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
    const int = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : d);
    return {
        next: int(raw.next, 1),
        step: int(raw.step, 1),
        digits: Math.min(12, Math.max(0, int(raw.digits, 4))),
    };
}

const PATTERN = /\{(N|date|time|year|month|day)\}/g;

export function hasVariables(text: string): boolean {
    PATTERN.lastIndex = 0;
    return PATTERN.test(text);
}

function pad(n: number, digits: number): string {
    const s = String(Math.abs(n)).padStart(digits, "0");
    return n < 0 ? `-${s}` : s;
}

/** The text with its variables filled in (unknown `{…}` stay as they are). */
export function expandVariables(text: string, serial: SerialSettings | undefined, now = new Date()): string {
    if (!text.includes("{")) return text;
    const s = serial ?? defaultSerial();
    const two = (n: number) => pad(n, 2);
    return text.replace(PATTERN, (_, name: string) => {
        switch (name) {
            case "N":
                return pad(s.next, s.digits);
            case "date":
                return `${two(now.getDate())}.${two(now.getMonth() + 1)}.${now.getFullYear()}`;
            case "time":
                return `${two(now.getHours())}:${two(now.getMinutes())}`;
            case "year":
                return String(now.getFullYear());
            case "month":
                return two(now.getMonth() + 1);
            default:
                return two(now.getDate());
        }
    });
}

/** The serial the editor lays the job out with (set before its figures are regenerated). */
let current: SerialSettings | undefined;

export function setCurrentSerial(value: SerialSettings | undefined) {
    current = value;
}

export function expandCurrent(text: string): string {
    return expandVariables(text, current);
}
