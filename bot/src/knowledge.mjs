// Knowledge base: curated FAQ, README, CHANGELOG and the command list, searched with BM25
// over a Russian-friendly tokenizer. No AI: answers are the documents themselves.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inlineToHtml, markdownToHtml, parseChangelog, plainText } from "./markdown.mjs";
import { escapeHtml } from "./telegram.mjs";

export const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "kb");
const RAW = "https://raw.githubusercontent.com/GenesisHPA/kern3d/main/";

const STOPWORDS = new Set(
    [
        "а без бы был была были было быть в вам вас ваш во вот все всё вы где да для до его ее её если есть",
        "еще ещё же за и из или им их к как какая какие каким какой ко когда кто ли либо мне меня мой мы на",
        "над надо не нет ни но ну о об однако он она они оно от по под при про с со так там то тоже только ту",
        "тут ты у уже хочу чем что чтобы чтоб эта эти это этот я можно нужно сделать делать почему зачем свой",
        "своё свою мою моё подскажите скажите пожалуйста привет здравствуйте",
        "a an and are can do does for how i in is it of on or the to what where with",
    ]
        .join(" ")
        .split(/\s+/),
);

/** Lowercase, ё→е, split on anything but letters/digits, drop stopwords, stem to 6 chars. */
export function tokenize(text) {
    const words = String(text)
        .toLowerCase()
        .replace(/ё/g, "е")
        .split(/[^\p{L}\p{N}]+/u);
    const tokens = [];
    for (const word of words) {
        if (word === "" || STOPWORDS.has(word)) continue;
        if (word.length < 2 && !/\d/.test(word)) continue;
        tokens.push(stem(word));
    }
    return tokens;
}

// Noun/adjective endings, longest first: "эскизе"/"эскиза" and "модель"/"модели" meet.
const ENDINGS = [
    "ями",
    "ами",
    "ого",
    "его",
    "ому",
    "ему",
    "ыми",
    "ими",
    "ой",
    "ей",
    "ий",
    "ый",
    "ая",
    "яя",
    "ое",
    "ее",
    "ые",
    "ие",
    "ую",
    "юю",
    "ом",
    "ем",
    "ам",
    "ям",
    "ах",
    "ях",
    "ов",
    "ев",
    "а",
    "я",
    "о",
    "е",
    "ы",
    "и",
    "у",
    "ю",
    "ь",
];

/**
 * Crude stemming: drop one common ending (when at least 3 letters remain), then keep the first
 * 6 characters. Numbers and Latin words are only truncated.
 */
export function stem(word) {
    if (/^\d/.test(word)) return word;
    let base = word;
    if (/[а-я]$/.test(word)) {
        const ending = ENDINGS.find((e) => word.endsWith(e) && word.length - e.length >= 3);
        if (ending) base = word.slice(0, -ending.length);
    }
    return base.slice(0, 6);
}

/**
 * FAQ markdown → entries `{ question, body, keywords }`, one per `## вопрос`. An HTML comment
 * `<!-- ключи: ... -->` in the body adds search words that are not shown.
 */
export function parseFaq(markdown) {
    const entries = [];
    let current = null;
    for (const line of markdown.split(/\r?\n/)) {
        const heading = /^##\s+(.*)$/.exec(line);
        if (heading) {
            current = { question: heading[1].trim(), body: [] };
            entries.push(current);
        } else if (current) {
            current.body.push(line);
        }
    }
    return entries.map((entry) => {
        let keywords = "";
        const body = entry.body.join("\n").replace(/<!--\s*ключи:([\s\S]*?)-->/gi, (_, words) => {
            keywords += ` ${words}`;
            return "";
        });
        return { question: entry.question, body: body.trim(), keywords: keywords.trim() };
    });
}

/** README → one chunk per heading (the text before the first heading is the intro). */
export function readmeChunks(markdown) {
    const chunks = [];
    let current = { title: "Kern3D", lines: [] };
    for (const line of markdown.split(/\r?\n/)) {
        const heading = /^#{1,3}\s+(.*)$/.exec(line);
        if (heading) {
            chunks.push(current);
            current = { title: heading[1].trim(), lines: [] };
        } else {
            current.lines.push(line);
        }
    }
    chunks.push(current);
    return chunks
        .map((c) => ({
            title: c.title,
            text: c.lines
                .join("\n")
                .replace(/```[\s\S]*?```/g, "")
                .trim(),
        }))
        .filter((c) => plainText(c.text) !== "");
}

/** CHANGELOG sections → one chunk per bullet, labelled with the version and subsection. */
export function changelogChunks(sections) {
    const chunks = [];
    for (const section of sections) {
        let group = "";
        for (const line of section.lines) {
            const sub = /^###\s+(.*)$/.exec(line);
            if (sub) group = sub[1].trim();
            const item = /^\s*[-*]\s+(.*)$/.exec(line);
            if (item) chunks.push({ version: section.version, group, text: item[1].trim() });
        }
    }
    return chunks;
}

/** Builds the chunk list from the raw sources. */
export function buildChunks({ faq = "", readme = "", changelog = "", commands = [] }) {
    const chunks = [];
    parseFaq(faq).forEach((entry, index) => {
        chunks.push({
            source: "faq",
            number: index + 1,
            title: entry.question,
            text: entry.body,
            index: `${entry.question} ${entry.question} ${entry.keywords} ${entry.body}`,
        });
    });
    for (const chunk of readmeChunks(readme)) {
        chunks.push({
            source: "readme",
            title: chunk.title,
            text: chunk.text,
            index: `${chunk.title} ${chunk.text}`,
        });
    }
    for (const item of changelogChunks(parseChangelog(changelog))) {
        chunks.push({
            source: "changelog",
            title: `${item.version}${item.group ? ` · ${item.group}` : ""}`,
            version: item.version,
            text: item.text,
            index: item.text,
        });
    }
    for (const command of commands) {
        const where = [
            command.tab && `вкладка «${command.tab}»`,
            command.group && `группа «${command.group}»`,
        ]
            .filter(Boolean)
            .join(", ");
        chunks.push({
            source: "commands",
            title: command.name,
            text: `«${command.name}»${where ? ` — ${where}` : ""}`,
            index: `${command.name} ${command.name} ${where}`,
        });
    }
    return chunks;
}

const K1 = 1.2;
const B = 0.75;
const BOOST = { faq: 1.6, readme: 1, changelog: 0.9, commands: 0.8 };

/** BM25 index over chunks; FAQ entries are boosted. */
export function createIndex(chunks) {
    const docs = chunks.map((chunk) => {
        const tf = new Map();
        const tokens = tokenize(chunk.index ?? chunk.text);
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        return { chunk, tf, length: tokens.length };
    });
    const df = new Map();
    for (const doc of docs) for (const t of doc.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const avgdl = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, docs.length);
    const n = docs.length;

    function search(query, limit = 5) {
        const terms = [...new Set(tokenize(query))];
        if (terms.length === 0) return [];
        const results = [];
        for (const doc of docs) {
            let score = 0;
            for (const term of terms) {
                const tf = doc.tf.get(term);
                if (!tf) continue;
                const d = df.get(term);
                const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
                score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avgdl));
            }
            if (score > 0) results.push({ chunk: doc.chunk, score: score * (BOOST[doc.chunk.source] ?? 1) });
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, limit);
    }
    return { search, size: n };
}

const LABELS = { faq: "FAQ", readme: "README", changelog: "Изменения", commands: "Команда" };

function snippet(text, max = 300) {
    const plain = plainText(text).replace(/\s+/g, " ");
    return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

export function faqEntryHtml(chunk) {
    return `<b>${inlineToHtml(chunk.title)}</b>\n\n${markdownToHtml(chunk.text)}`;
}

/** Answer HTML for a free-text question. */
export function answer(index, query) {
    const results = index.search(query, 5);
    if (results.length === 0) {
        return `Ничего не нашёл по запросу «${escapeHtml(query.trim())}». Попробуйте сказать иначе или загляните в /faq и /help.`;
    }
    const [top, second] = results;
    if (top.chunk.source === "faq" && (!second || top.score >= second.score * 1.3)) {
        return `${faqEntryHtml(top.chunk)}\n\n<i>Другие вопросы: /faq</i>`;
    }
    const lines = results.slice(0, 3).map((r) => {
        const c = r.chunk;
        if (c.source === "commands") return `<b>[${LABELS.commands}]</b> ${escapeHtml(c.text)}`;
        const ref = c.source === "faq" ? ` (/faq ${c.number})` : "";
        return `<b>[${LABELS[c.source]}]</b> ${escapeHtml(plainText(c.title))}${ref}\n${escapeHtml(snippet(c.text))}`;
    });
    return `Вот что нашлось:\n\n${lines.join("\n\n")}`;
}

async function fetchText(fetchImpl, url) {
    const response = await fetchImpl(url, {
        headers: { "user-agent": "kern3d-bot" },
        signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
}

/** The live knowledge base: sources from GitHub main, bundled copies as a fallback. */
export function createKnowledge({ fetchImpl = fetch, kbDir = KB_DIR, log = console.error } = {}) {
    const kb = {
        index: createIndex([]),
        faq: [],
        changelog: [],
        async load({ remote = true } = {}) {
            const local = (name) => readFile(join(kbDir, name), "utf8");
            const source = async (name) => {
                if (remote) {
                    try {
                        return await fetchText(fetchImpl, RAW + name);
                    } catch (error) {
                        log(`[kb] ${name}: ${error.message}, using the bundled copy`);
                    }
                }
                return local(name).catch(() => "");
            };
            const [changelog, readme, faq, commandsJson] = await Promise.all([
                source("CHANGELOG.md"),
                source("README.md"),
                local("faq.md").catch(() => ""),
                local("commands.json").catch(() => "[]"),
            ]);
            const chunks = buildChunks({ faq, readme, changelog, commands: JSON.parse(commandsJson) });
            kb.index = createIndex(chunks);
            kb.faq = chunks.filter((c) => c.source === "faq");
            kb.changelog = parseChangelog(changelog);
            log(`[kb] ${chunks.length} chunks, FAQ ${kb.faq.length}`);
            return kb;
        },
        answer: (query) => answer(kb.index, query),
    };
    return kb;
}
