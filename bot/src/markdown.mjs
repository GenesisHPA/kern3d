// Markdown (the subset CHANGELOG/README/FAQ use) → Telegram HTML.
import { escapeHtml } from "./telegram.mjs";

export const TELEGRAM_LIMIT = 4096;

/** Inline markdown of one line: `code`, **bold**, [text](url). Raw HTML tags are dropped. */
export function inlineToHtml(text) {
    let html = escapeHtml(String(text).replace(/<[^>]+>/g, ""));
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    return html;
}

/** Markdown text without formatting, for search snippets and indexing. */
export function plainText(text) {
    return String(text)
        .replace(/<[^>]+>/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[*`]/g, "")
        .replace(/^#+\s*/gm, "")
        .trim();
}

/** One markdown line → one HTML line: headings bold, list items with "•". */
export function lineToHtml(line) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) return `<b>${inlineToHtml(heading[1].trim())}</b>`;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) return `• ${inlineToHtml(bullet[1])}`;
    return inlineToHtml(line);
}

/** Markdown block → HTML, collapsing runs of blank lines; a blank line goes before a heading. */
export function markdownToHtml(markdown) {
    return blockLines(markdown.split(/\r?\n/)).join("\n");
}

function blockLines(lines) {
    const out = [];
    for (const raw of lines) {
        const line = raw.trimEnd();
        if (line.trim() === "") {
            if (out.length > 0 && out[out.length - 1] !== "") out.push("");
            continue;
        }
        if (/^#{1,6}\s/.test(line) && out.length > 0 && out[out.length - 1] !== "") out.push("");
        out.push(lineToHtml(line));
    }
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    return out;
}

/** 1 пункт, 2 пункта, 5 пунктов. */
export function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

/**
 * Markdown lines → HTML that fits `budget` characters. Lines that do not fit are dropped from
 * the end and replaced by "…и ещё N пунктов" (N = dropped list items).
 */
export function fitMarkdown(lines, budget) {
    const html = blockLines(lines);
    const isItem = (l) => l.startsWith("• ");
    const total = html.join("\n");
    if (total.length <= budget) return total;
    const reserve = 40;
    const kept = [];
    let length = 0;
    let i = 0;
    for (; i < html.length; i++) {
        const add = html[i].length + (kept.length > 0 ? 1 : 0);
        if (length + add > budget - reserve) break;
        kept.push(html[i]);
        length += add;
    }
    while (kept.length > 0 && (kept[kept.length - 1] === "" || kept[kept.length - 1].startsWith("<b>")))
        kept.pop();
    const rest = html.slice(kept.length).filter(isItem).length;
    if (rest > 0) kept.push(`…и ещё ${rest} ${plural(rest, "пункт", "пункта", "пунктов")}`);
    else kept.push("…");
    return kept.join("\n");
}

/**
 * CHANGELOG.md → sections `{ version, date, lines }` in file order (newest first).
 * Section heading: `## <версия> — <дата | готовится>`.
 */
export function parseChangelog(markdown) {
    const sections = [];
    let current = null;
    for (const line of markdown.split(/\r?\n/)) {
        const heading = /^##\s+(\d+\.\d+\.\d+\S*)\s*(?:[—–-]\s*(.*))?$/.exec(line);
        if (heading) {
            current = { version: heading[1], date: (heading[2] ?? "").trim(), lines: [] };
            sections.push(current);
            continue;
        }
        if (/^##\s/.test(line)) {
            current = null;
            continue;
        }
        if (current) current.lines.push(line);
    }
    for (const section of sections) {
        while (section.lines.length > 0 && section.lines[0].trim() === "") section.lines.shift();
        while (section.lines.length > 0 && section.lines[section.lines.length - 1].trim() === "")
            section.lines.pop();
    }
    return sections;
}

/** The newest released section (skips one whose date is "готовится"). */
export function latestReleased(sections) {
    return sections.find((s) => /\d/.test(s.date)) ?? sections[0] ?? null;
}
