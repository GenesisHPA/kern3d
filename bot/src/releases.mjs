// Release watcher: polls the latest GitHub release and posts a new one to subscribed chats.
import { fitMarkdown, TELEGRAM_LIMIT } from "./markdown.mjs";
import { escapeHtml } from "./telegram.mjs";

export const REPO = "GenesisHPA/kern3d";
export const LINKS = {
    windows: `https://github.com/${REPO}/releases/latest/download/Kern3D-Setup.exe`,
    linux: `https://github.com/${REPO}/releases/latest/download/Kern3D-x86_64.AppImage`,
    online: "https://genesishpa.github.io/kern3d/",
    releases: `https://github.com/${REPO}/releases/latest`,
    issues: `https://github.com/${REPO}/issues`,
    wiki: `https://github.com/${REPO}/wiki`,
};
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

/** "v0.9.6" → "0.9.6". */
export function versionOf(tag) {
    return String(tag ?? "").replace(/^v/i, "");
}

/** ISO timestamp → ДД.ММ.ГГГГ (UTC). */
export function formatDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`;
}

export function linksHtml(releaseUrl = LINKS.releases) {
    return [
        `• <a href="${LINKS.windows}">Windows — Kern3D-Setup.exe</a>`,
        `• <a href="${LINKS.linux}">Linux — Kern3D-x86_64.AppImage</a>`,
        `• <a href="${LINKS.online}">Онлайн-версия (без установки)</a>`,
        `• <a href="${escapeHtml(releaseUrl)}">Страница релиза</a>`,
        `• <a href="${LINKS.wiki}">📖 Справка (вики): все функции, FAQ, указатель команд</a>`,
    ].join("\n");
}

/**
 * The "what's new" lines of a release body: the CHANGELOG section. The install text that
 * scripts/release-notes.mjs appends is dropped — the post carries its own links.
 */
export function releaseNoteLines(body) {
    const lines = [];
    for (const line of String(body ?? "").split(/\r?\n/)) {
        if (/^\*\*Установка\*\*/.test(line.trim()) || /^Все изменения по версиям/.test(line.trim())) break;
        if (/^\*\*Что нового в /.test(line.trim())) continue;
        lines.push(line);
    }
    return lines;
}

/** Telegram HTML announcement of a release, at most 4096 characters. */
export function formatRelease(release) {
    const version = versionOf(release.tag_name);
    const date = formatDate(release.published_at ?? release.created_at);
    const header = `<b>Вышла Kern3D ${escapeHtml(version)}</b>${date ? ` · ${date}` : ""}\n\n`;
    const footer = `\n\n<b>Скачать</b>\n${linksHtml(release.html_url ?? LINKS.releases)}`;
    const budget = TELEGRAM_LIMIT - header.length - footer.length;
    const body = fitMarkdown(releaseNoteLines(release.body), budget);
    return `${header}${body || "Описание изменений — на странице релиза."}${footer}`;
}

/** GET releases/latest with If-None-Match. → `{ status: 304 }` or `{ status: 200, release, etag }`. */
export async function fetchLatest(fetchImpl, etag) {
    const headers = { "user-agent": "kern3d-bot", accept: "application/vnd.github+json" };
    if (etag) headers["if-none-match"] = etag;
    const response = await fetchImpl(LATEST_URL, { headers, signal: AbortSignal.timeout(30_000) });
    if (response.status === 304) return { status: 304 };
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const release = await response.json();
    return { status: 200, release, etag: response.headers.get("etag") };
}

/**
 * One poll. Mutates `state` (etag, latest, lastTag). On the very first run only the current tag
 * is stored; afterwards a different tag is announced once through `broadcast(html)`.
 * @returns {Promise<{ changed: boolean, posted: boolean, release?: object }>}
 */
export async function checkRelease({ state, fetchImpl = fetch, broadcast }) {
    const result = await fetchLatest(fetchImpl, state.etag);
    if (result.status === 304) return { changed: false, posted: false };
    const { release } = result;
    state.etag = result.etag ?? null;
    state.latest = {
        tag: release.tag_name,
        published_at: release.published_at,
        html_url: release.html_url,
    };
    if (!release.tag_name || release.draft || release.prerelease) return { changed: false, posted: false };
    if (state.lastTag === release.tag_name) return { changed: false, posted: false };
    const first = state.lastTag === null || state.lastTag === undefined;
    state.lastTag = release.tag_name;
    if (first) return { changed: false, posted: false, release };
    await broadcast(formatRelease(release));
    return { changed: true, posted: true, release };
}
