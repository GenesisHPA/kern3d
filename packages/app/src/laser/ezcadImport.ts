// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type JczPen, type JczSettings, normalizePen } from "./jczSettings";

/**
 * Reading a JCZ machine's settings from EzCAD 2's own files, so a machine set up in EzCAD works
 * the same here: `plug/markcfgN` (the board: field, offset, angle, galvo wiring and scale,
 * laser type, frequency range, red pointer) and `PARAM/MarkParam.lib` (the pens). Both are INI
 * text: `[SECTION]` and `KEY=value` lines. Nothing is written back to EzCAD.
 */

export type IniSections = Map<string, Map<string, string>>;

export function parseIni(text: string): IniSections {
    const sections: IniSections = new Map();
    let current = new Map<string, string>();
    sections.set("", current);
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === "" || line.startsWith(";")) continue;
        const section = /^\[(.*)\]$/.exec(line);
        if (section !== null) {
            current = sections.get(section[1]) ?? new Map();
            sections.set(section[1], current);
            continue;
        }
        const eq = line.indexOf("=");
        if (eq > 0) current.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    return sections;
}

export interface EzcadImport {
    /** The settings with every value the files had replaced. */
    jcz: JczSettings;
    /** The EzCAD keys that were applied. */
    applied: string[];
    /** The correction file markcfg names when it is switched on (to be loaded separately). */
    correctionFile?: string;
    /** Values read but not applied: the board has no command for them (EzCAD's distortion terms). */
    notApplied: string[];
}

function number(values: Map<string, string>, key: string): number | undefined {
    const v = values.get(key);
    if (v === undefined || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

/** EzCAD's `plug/markcfgN` (section [LMC_CFG]) onto `base`. */
export function importMarkcfg(text: string, base: JczSettings): EzcadImport {
    const cfg = parseIni(text).get("LMC_CFG") ?? new Map<string, string>();
    const jcz: JczSettings = { ...base, distortion: [...base.distortion] as [number, number] };
    const applied: string[] = [];
    const notApplied: string[] = [];
    const take = (key: string, apply: (v: number) => void) => {
        const v = number(cfg, key);
        if (v === undefined) return;
        apply(v);
        applied.push(key);
    };
    take("FIELDSIZE", (v) => {
        if (v > 0) jcz.field = v;
    });
    take("FIELDOFFSETX", (v) => (jcz.offsetX = v));
    take("FIELDOFFSETY", (v) => (jcz.offsetY = v));
    take("FIELDANGLE", (v) => (jcz.angle = v));
    // GALVOX names the galvo that moves along X: 1 means the board's channels are swapped
    take("GALVOX", (v) => (jcz.swapXY = v === 1));
    take("GALVONEGATE0", (v) => (jcz.negate0 = v !== 0));
    take("GALVONEGATE1", (v) => (jcz.negate1 = v !== 0));
    take("GALVOASPECT0", (v) => {
        if (v > 0) jcz.scale0 = v;
    });
    take("GALVOASPECT1", (v) => {
        if (v > 0) jcz.scale1 = v;
    });
    take("LASERTYPE", (v) => (jcz.laserType = v));
    take("MINPWMFREQ", (v) => (jcz.minFrequency = v / 1000));
    take("MAXPWMFREQ", (v) => (jcz.maxFrequency = v / 1000));
    take("REDLIGHTSPEED", (v) => {
        if (v > 0) jcz.lightSpeed = v;
    });
    take("REDLIGHTOFFSETX", (v) => (jcz.lightOffsetX = v));
    take("REDLIGHTOFFSETY", (v) => (jcz.lightOffsetY = v));
    take("m_nIPGOpenMoDelayTimeMs", (v) => (jcz.openMoDelay = v));
    const d0 = number(cfg, "GALVODISTOR0");
    const d1 = number(cfg, "GALVODISTOR1");
    if (d0 !== undefined || d1 !== undefined) jcz.distortion = [d0 ?? 1, d1 ?? 1];
    for (const key of [
        "GALVODISTOR0",
        "GALVODISTOR1",
        "GALVOHORVER0",
        "GALVOHORVER1",
        "GALVOTRAPEDISTOR0",
        "GALVOTRAPEDISTOR1",
    ]) {
        const v = number(cfg, key);
        if (v !== undefined && v !== 1) notApplied.push(`${key}=${v}`);
    }
    const corEnabled = number(cfg, "ENABLECORFILE") === 1;
    const corFile = cfg.get("CORFILE");
    return {
        jcz,
        applied,
        notApplied,
        correctionFile: corEnabled && corFile !== undefined && corFile !== "" ? corFile : undefined,
    };
}

/** EzCAD's `PARAM/MarkParam.lib`: one section per pen ([LASERMODE] is not a pen). */
export function importMarkParam(text: string, base: JczSettings): EzcadImport {
    const sections = parseIni(text);
    const pens: JczPen[] = [];
    const jcz: JczSettings = { ...base };
    const applied: string[] = [];
    for (const [name, values] of sections) {
        if (name === "" || name === "LASERMODE") continue;
        const v = (key: string) => number(values, key);
        const pen = normalizePen({
            name,
            speed: v("MARKSPEED"),
            power: v("POWERRATIO"),
            frequency: v("FREQ") === undefined ? undefined : (v("FREQ") as number) / 1000,
            pulseWidth: v("QPULSEWIDTH"),
            laserOnDelay: v("STARTTC"),
            laserOffDelay: v("LASEROFFTC"),
            polygonDelay: v("POLYTC"),
        });
        pens.push(pen);
        applied.push(name);
        // the first pen's travel values are the machine's jumps
        if (pens.length === 1) {
            const jump = v("JUMPSPEED");
            if (jump !== undefined && jump > 0) jcz.jumpSpeed = jump;
            const short = v("m_nMinJumpDelayTCUs") ?? v("JUMPPOSTC");
            const long = v("m_nMaxJumpDelayTCUs") ?? v("JUMPDISTTC");
            const limit = v("m_dJumpLengthLimit");
            if (short !== undefined) jcz.jumpDelayShort = short;
            if (long !== undefined) jcz.jumpDelayLong = long;
            if (limit !== undefined && limit > 0) jcz.jumpLongDistance = limit;
        }
    }
    if (pens.length > 0) jcz.pens = pens;
    return { jcz, applied, notApplied: [] };
}
