// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type CamTool, knifeOf } from "./camTools";

/**
 * A cutter's shape as a half profile turned about its axis: points (r, z) from the tip (z = 0) up
 * to the top of the shank, true to the diameter, corner radius, point angle and flute length. The
 * same profile makes the 3D cutter of the simulation (a lathe) and the side drawing of the tools
 * panel (SVG), so both always agree with the numbers.
 */
export interface ToolProfile {
    /** Half profile, tip first, as (r, z) mm; r = 0 at both ends. */
    points: { r: number; z: number }[];
    /** Cutting radius (the widest of the flutes). */
    radius: number;
    /** Height of the pointed / rounded tip part (cone, ball, corner). */
    tipLength: number;
    /** Where the flutes end (the cutting length from the tip). */
    fluteEnd: number;
    shankRadius: number;
    /** Overall stick-out, tip to shank top. */
    length: number;
}

/** A usual shank for a cutter of this size: 1/8", 6 or 8 mm, else the cutting diameter. */
export function shankDiameter(tool: CamTool): number {
    if (tool.kind === "knife") return KNIFE_HOLDER;
    if (tool.kind === "vbit" || tool.kind === "chamfer") return Math.max(tool.diameter, 3.175);
    const d = tool.diameter;
    if (d <= 3.175) return 3.175;
    if (d <= 6) return 6;
    if (d <= 8) return 8;
    return d;
}

/** A drag knife holder's body, mm (a usual one is about 11–12 mm across). */
export const KNIFE_HOLDER = 11;
/** How much of the blade shows below the holder, mm. */
export const KNIFE_BLADE = 4;

function halfAngle(tool: CamTool, fallback: number): number {
    const a = tool.angle > 0 ? tool.angle : fallback;
    return (Math.max(5, Math.min(175, a)) * Math.PI) / 360;
}

/** The half profile of a tool (see `ToolProfile`). */
export function toolProfile(tool: CamTool, arcSegments = 10): ToolProfile {
    const r = Math.max(0.005, tool.diameter / 2);
    const pts: { r: number; z: number }[] = [{ r: 0, z: 0 }];
    let tip = 0;
    const arc = (cr: number, cz: number, rad: number, a0: number, a1: number) => {
        for (let i = 1; i <= arcSegments; i++) {
            const a = a0 + ((a1 - a0) * i) / arcSegments;
            pts.push({ r: cr + rad * Math.cos(a), z: cz + rad * Math.sin(a) });
        }
    };
    switch (tool.kind) {
        case "knife": {
            // a thin blade (as if turned about the axis, for the outline): no cutting width
            const w = Math.max(0.15, knifeOf(tool).offset + 0.15);
            pts.push({ r: w, z: KNIFE_BLADE * 0.35 }, { r: w, z: KNIFE_BLADE });
            const holder = KNIFE_HOLDER / 2;
            pts.push({ r: holder * 0.45, z: KNIFE_BLADE }, { r: holder * 0.45, z: KNIFE_BLADE + 3 });
            pts.push(
                { r: holder, z: KNIFE_BLADE + 5 },
                { r: holder, z: KNIFE_BLADE + 40 },
                { r: 0, z: KNIFE_BLADE + 40 },
            );
            return {
                points: pts,
                radius: w,
                tipLength: KNIFE_BLADE * 0.35,
                fluteEnd: KNIFE_BLADE,
                shankRadius: holder,
                length: KNIFE_BLADE + 40,
            };
        }
        case "ball":
            arc(0, r, r, -Math.PI / 2, 0);
            tip = r;
            break;
        case "bull": {
            const c = Math.min(r, Math.max(0, tool.cornerRadius));
            if (c > 0) {
                if (r - c > 1e-6) pts.push({ r: r - c, z: 0 });
                arc(r - c, c, c, -Math.PI / 2, 0);
            } else pts.push({ r, z: 0 });
            tip = c;
            break;
        }
        case "vbit":
        case "chamfer":
        case "drill": {
            const half = halfAngle(tool, tool.kind === "drill" ? 118 : tool.kind === "vbit" ? 60 : 90);
            // a chamfer mill has a small flat at its tip
            const flat = tool.kind === "chamfer" ? r * 0.12 : 0;
            if (flat > 0) pts.push({ r: flat, z: 0 });
            tip = (r - flat) / Math.tan(half);
            pts.push({ r, z: tip });
            break;
        }
        default:
            pts.push({ r, z: 0 });
    }
    const fluteEnd = Math.max(tool.fluteLength, tip, 0.1);
    if (fluteEnd > tip + 1e-6) pts.push({ r, z: fluteEnd });
    const shankRadius = shankDiameter(tool) / 2;
    let z = fluteEnd;
    if (shankRadius > r + 1e-6) {
        // a short taper (neck) up to a thicker shank
        z += (shankRadius - r) * 1.5;
        pts.push({ r: shankRadius, z });
    } else if (shankRadius < r - 1e-6) {
        pts.push({ r: shankRadius, z });
    }
    const length = z + Math.max(12, shankRadius * 5);
    pts.push({ r: shankRadius, z: length }, { r: 0, z: length });
    return { points: pts, radius: r, tipLength: tip, fluteEnd, shankRadius, length };
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);

export interface ToolSvgOptions {
    width?: number;
    height?: number;
    /** Draw the dimensions (Ø, flute length, angle / radius). */
    dimensions?: boolean;
    /** Colour of the body outline and text (CSS). */
    color?: string;
}

/**
 * The tool seen from the side as an SVG string: the outline mirrored about the axis, the flutes
 * hatched like a helix, and (optionally) its dimensions. Text is numbers only, so no i18n needed.
 */
export function toolSvg(tool: CamTool, options: ToolSvgOptions = {}): string {
    if (tool.kind === "knife") return knifeSvg(tool, options);
    const p = toolProfile(tool, 12);
    const dims = options.dimensions ?? true;
    const W = options.width ?? 160;
    const H = options.height ?? 200;
    const color = options.color ?? "currentColor";
    // show the cutting end and a bit of shank; scale to fit with room for the dimensions
    const shown = dims
        ? Math.min(p.length, p.fluteEnd + Math.max(p.shankRadius * 3, p.fluteEnd * 0.5))
        : Math.min(p.length, Math.max(p.tipLength + p.radius, p.radius * 4));
    const half = Math.max(p.radius, p.shankRadius);
    const padX = dims ? 46 : 4;
    const padY = dims ? 26 : 3;
    const s = Math.min((W - 2 * padX) / (2 * half), (H - 2 * padY) / shown);
    const cx = W / 2;
    const y0 = H - padY - (dims ? 6 : 0);
    const X = (r: number) => cx + r * s;
    const Y = (z: number) => y0 - z * s;
    const clip = p.points.filter((q) => q.z <= shown + 1e-6);
    const at = p.points.find((q) => q.z > shown);
    if (at) {
        const prev = clip[clip.length - 1];
        const rr = prev.r + ((at.r - prev.r) * (shown - prev.z)) / (at.z - prev.z || 1);
        clip.push({ r: rr, z: shown });
    }
    const right = clip.map((q) => `${fmt(X(q.r))},${fmt(Y(q.z))}`);
    const left = [...clip].reverse().map((q) => `${fmt(X(-q.r))},${fmt(Y(q.z))}`);
    const outline = [...right, ...left].join(" ");
    const id = `tc${tool.id.replace(/[^a-zA-Z0-9]/g, "")}${W}`;
    const sw = dims ? 1.2 : 1;
    const parts: string[] = [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${tool.kind} Ø${fmt(tool.diameter)}">`,
        `<defs><clipPath id="${id}"><polygon points="${outline}"/></clipPath>`,
        `<linearGradient id="${id}g" x1="0" x2="1"><stop offset="0" stop-color="#868e96"/><stop offset="0.45" stop-color="#f1f3f5"/><stop offset="1" stop-color="#495057"/></linearGradient></defs>`,
        `<polygon points="${outline}" fill="url(#${id}g)" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round"/>`,
    ];
    // helical flutes: slanted bands across the cutting part
    const flutes = Math.max(1, Math.min(6, tool.flutes));
    const pitch = (2 * p.radius * s * 2.2) / flutes;
    const bands: string[] = [];
    const top = Y(Math.min(p.fluteEnd, shown));
    for (let y = y0 + 2 * p.radius * s; y > top - pitch; y -= pitch)
        bands.push(`M${fmt(X(-half))},${fmt(y)} L${fmt(X(half))},${fmt(y - p.radius * s * 1.4)}`);
    parts.push(
        `<g clip-path="url(#${id})"><rect x="0" y="${fmt(top)}" width="${W}" height="${fmt(y0 - top + 1)}" fill="#adb5bd" opacity="0.35"/>`,
        `<path d="${bands.join(" ")}" stroke="#343a40" stroke-width="${fmt(Math.max(1, pitch * 0.28))}" opacity="0.55" fill="none"/></g>`,
    );
    if (dims) {
        const dc = "#4dabf7";
        const arrow = (x1: number, y1: number, x2: number, y2: number) =>
            `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" stroke="${dc}" stroke-width="1" marker-start="url(#${id}a)" marker-end="url(#${id}a)"/>`;
        parts.push(
            `<defs><marker id="${id}a" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L6,3 L0,6 z" fill="${dc}"/></marker></defs>`,
        );
        // diameter under the tip
        const yd = y0 + 10;
        parts.push(
            arrow(X(-p.radius), yd, X(p.radius), yd),
            `<text x="${fmt(cx)}" y="${fmt(yd + 11)}" font-size="10" text-anchor="middle" fill="${color}">Ø${fmt(tool.diameter)}</text>`,
        );
        // flute length at the right
        const xl = X(half) + 12;
        const yt = Y(Math.min(p.fluteEnd, shown));
        parts.push(
            arrow(xl, y0, xl, yt),
            `<text x="${fmt(xl + 4)}" y="${fmt((y0 + yt) / 2 + 3)}" font-size="10" fill="${color}">${fmt(p.fluteEnd)}</text>`,
        );
        // angle or radius at the left
        let note = "";
        if (tool.kind === "vbit" || tool.kind === "chamfer" || tool.kind === "drill")
            note = `${fmt(tool.angle > 0 ? tool.angle : tool.kind === "drill" ? 118 : 90)}°`;
        else if (tool.kind === "ball") note = `R${fmt(p.radius)}`;
        else if (tool.kind === "bull" && tool.cornerRadius > 0)
            note = `R${fmt(Math.min(p.radius, tool.cornerRadius))}`;
        if (note !== "")
            parts.push(
                `<text x="${fmt(X(-half) - 6)}" y="${fmt(Y(p.tipLength / 2) + 3)}" font-size="10" text-anchor="end" fill="${color}">${note}</text>`,
            );
        parts.push(
            `<text x="${fmt(cx)}" y="12" font-size="9" text-anchor="middle" fill="${color}" opacity="0.7">⌀${fmt(p.shankRadius * 2)} · Z${flutes}</text>`,
        );
    }
    parts.push("</svg>");
    return parts.join("");
}

/** A small icon of the tool (no dimensions), for lists and badges. */
export function toolIconSvg(tool: CamTool, size = 18): string {
    return toolSvg(tool, { width: size, height: size, dimensions: false });
}

/**
 * A drag knife from the side: the holder's nose, the blade below it with its tip off the axis
 * (dashed) by the offset, and (optionally) the offset and the blade's angle written by it.
 */
function knifeSvg(tool: CamTool, options: ToolSvgOptions): string {
    const k = knifeOf(tool);
    const dims = options.dimensions ?? true;
    const W = options.width ?? 160;
    const H = options.height ?? 200;
    const color = options.color ?? "currentColor";
    const cx = W / 2;
    const bottom = H - (dims ? 34 : 2);
    // the offset is drawn larger than true so it can be seen: at least a tenth of the width
    const s = (bottom - (dims ? 14 : 1)) / (KNIFE_BLADE + 9);
    const off = Math.max(k.offset * s, W * (dims ? 0.08 : 0.12));
    const Y = (z: number) => bottom - z * s;
    const holder = Math.min(W * 0.42, (KNIFE_HOLDER / 2) * s);
    const nose = holder * 0.45;
    const id = `kn${tool.id.replace(/[^a-zA-Z0-9]/g, "")}${W}`;
    const parts = [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="knife ${fmt(k.offset)}">`,
        `<defs><linearGradient id="${id}g" x1="0" x2="1"><stop offset="0" stop-color="#495057"/><stop offset="0.45" stop-color="#ced4da"/><stop offset="1" stop-color="#343a40"/></linearGradient></defs>`,
        // the holder and its nose
        `<path d="M${fmt(cx - holder)},${fmt(Y(KNIFE_BLADE + 9))} L${fmt(cx + holder)},${fmt(Y(KNIFE_BLADE + 9))} L${fmt(cx + holder)},${fmt(Y(KNIFE_BLADE + 5))} L${fmt(cx + nose)},${fmt(Y(KNIFE_BLADE + 3))} L${fmt(cx + nose)},${fmt(Y(KNIFE_BLADE))} L${fmt(cx - nose)},${fmt(Y(KNIFE_BLADE))} L${fmt(cx - nose)},${fmt(Y(KNIFE_BLADE + 3))} L${fmt(cx - holder)},${fmt(Y(KNIFE_BLADE + 5))} Z" fill="url(#${id}g)" stroke="${color}" stroke-width="1" stroke-linejoin="round"/>`,
        // the blade: its back on the axis, its edge sloping down to the tip, off the axis
        `<path d="M${fmt(cx - nose * 0.35)},${fmt(Y(KNIFE_BLADE))} L${fmt(cx + nose * 0.35)},${fmt(Y(KNIFE_BLADE))} L${fmt(cx + nose * 0.35)},${fmt(Y(KNIFE_BLADE * 0.45))} L${fmt(cx - off)},${fmt(Y(0))} Z" fill="#f1f3f5" stroke="${color}" stroke-width="1" stroke-linejoin="round"/>`,
    ];
    if (dims) {
        const dc = "#4dabf7";
        parts.push(
            `<line x1="${fmt(cx)}" y1="${fmt(Y(KNIFE_BLADE + 10))}" x2="${fmt(cx)}" y2="${fmt(bottom + 12)}" stroke="${dc}" stroke-width="1" stroke-dasharray="4 3"/>`,
            `<line x1="${fmt(cx - off)}" y1="${fmt(bottom + 8)}" x2="${fmt(cx)}" y2="${fmt(bottom + 8)}" stroke="${dc}" stroke-width="1.5"/>`,
            `<text x="${fmt(cx)}" y="${fmt(bottom + 24)}" font-size="10" text-anchor="middle" fill="${color}">↤ ${fmt(k.offset)}</text>`,
        );
    }
    parts.push("</svg>");
    return parts.join("");
}
