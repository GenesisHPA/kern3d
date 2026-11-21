import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitMarkdown, lineToHtml, parseChangelog, TELEGRAM_LIMIT } from "../src/markdown.mjs";
import { checkRelease, formatRelease, LINKS, releaseNoteLines } from "../src/releases.mjs";
import { emptyState } from "../src/state.mjs";

describe("markdown → Telegram HTML", () => {
    it("bolds headings, turns bullets into •, escapes HTML", () => {
        assert.equal(lineToHtml("### Добавлено"), "<b>Добавлено</b>");
        assert.equal(lineToHtml("- Резьба: a < b & c"), "• Резьба: a &lt; b &amp; c");
        assert.equal(lineToHtml("- **Windows:** `x.exe`"), "• <b>Windows:</b> <code>x.exe</code>");
    });

    it("trims to the budget with «…и ещё N пунктов»", () => {
        const lines = [
            "### Добавлено",
            ...Array.from({ length: 200 }, (_, i) => `- Пункт номер ${i} ${"x".repeat(40)}`),
        ];
        const html = fitMarkdown(lines, 2000);
        assert.ok(html.length <= 2000);
        const shown = html.split("\n").filter((l) => l.startsWith("• ")).length;
        assert.match(html, new RegExp(`…и ещё ${200 - shown} пункт(а|ов)?$`));
    });

    it("parses CHANGELOG sections", () => {
        const sections = parseChangelog(
            "# T\n\n## 0.9.7 — готовится\n\n- a\n\n## 0.9.6 — 21.11.2026\n\n### Добавлено\n\n- b\n",
        );
        assert.deepEqual(
            sections.map((s) => [s.version, s.date]),
            [
                ["0.9.7", "готовится"],
                ["0.9.6", "21.11.2026"],
            ],
        );
    });
});

const release = (
    tag,
    body = "**Что нового в 0.9.7**\n### Добавлено\n- Новое\n\n**Установка**\n- Windows: ...",
) => ({
    tag_name: tag,
    published_at: "2026-11-21T10:00:00Z",
    html_url: `https://github.com/GenesisHPA/kern3d/releases/tag/${tag}`,
    body,
});

describe("release post", () => {
    it("has version, date, notes and all links, without the install text", () => {
        const html = formatRelease(release("v0.9.7"));
        assert.match(html, /Kern3D 0\.9\.7/);
        assert.match(html, /21\.11\.2026/);
        assert.match(html, /<b>Добавлено<\/b>\n• Новое/);
        assert.doesNotMatch(html, /Установка|Что нового в/);
        for (const url of [LINKS.windows, LINKS.linux, LINKS.online]) assert.ok(html.includes(url));
        assert.ok(html.includes("releases/tag/v0.9.7"));
    });

    it("never exceeds 4096 characters", () => {
        const body = [
            "### Добавлено",
            ...Array.from({ length: 300 }, (_, i) => `- Пункт ${i}: ${"длинный текст ".repeat(5)}`),
        ].join("\n");
        const html = formatRelease(release("v1.0.0", body));
        assert.ok(html.length <= TELEGRAM_LIMIT, String(html.length));
        assert.match(html, /…и ещё \d+ пункт/);
        assert.ok(html.includes(LINKS.windows));
    });

    it("drops the release-notes install block", () => {
        assert.deepEqual(releaseNoteLines("**Что нового в 1**\n- a\n\n**Установка**\n- b"), ["- a", ""]);
    });
});

function githubMock(sequence) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, headers: init.headers });
        const next = sequence.shift();
        if (next === 304) return { status: 304, ok: false, headers: new Map() };
        return {
            status: 200,
            ok: true,
            headers: new Map([["etag", `"etag-${next.tag_name}"`]]),
            json: async () => next,
        };
    };
    return { fetchImpl, calls };
}

describe("release diff", () => {
    it("first start stores the tag without posting; a new tag posts exactly once", async () => {
        const state = emptyState();
        const posts = [];
        const broadcast = async (html) => posts.push(html);
        const { fetchImpl, calls } = githubMock([
            release("v0.9.6"),
            304,
            release("v0.9.6"),
            release("v0.9.7"),
            release("v0.9.7"),
        ]);

        await checkRelease({ state, fetchImpl, broadcast });
        assert.equal(state.lastTag, "v0.9.6");
        assert.equal(posts.length, 0);
        assert.equal(calls[0].url, "https://api.github.com/repos/GenesisHPA/kern3d/releases/latest");
        assert.equal(calls[0].headers["user-agent"], "kern3d-bot");

        await checkRelease({ state, fetchImpl, broadcast }); // 304
        assert.equal(calls[1].headers["if-none-match"], '"etag-v0.9.6"');
        await checkRelease({ state, fetchImpl, broadcast }); // same tag
        assert.equal(posts.length, 0);

        const result = await checkRelease({ state, fetchImpl, broadcast });
        assert.equal(result.changed, true);
        assert.equal(posts.length, 1);
        assert.match(posts[0], /0\.9\.7/);
        assert.equal(state.lastTag, "v0.9.7");

        await checkRelease({ state, fetchImpl, broadcast });
        assert.equal(posts.length, 1);
    });
});
