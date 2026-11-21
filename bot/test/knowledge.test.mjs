import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
    answer,
    buildChunks,
    createIndex,
    createKnowledge,
    parseFaq,
    stem,
    tokenize,
} from "../src/knowledge.mjs";

describe("tokenizer", () => {
    it("lowercases, maps ё to е, drops stopwords and punctuation", () => {
        assert.deepEqual(tokenize("Как сделать ЧЕРТЁЖ?"), ["чертеж"]);
    });
    it("stems by dropping an ending and truncating to 6 characters", () => {
        assert.equal(stem("окружности"), "окружн");
        assert.equal(stem("окружность"), "окружн");
        assert.equal(stem("эскизе"), stem("эскиз"));
        assert.equal(stem("модели"), stem("модель"));
        assert.equal(stem("левая"), stem("левую"));
    });
    it("keeps numbers and latin words", () => {
        assert.deepEqual(tokenize("M8 stl 0.9.6"), ["m8", "stl", "0", "9", "6"]);
    });
});

describe("FAQ parsing", () => {
    it("splits on ## and hides the keyword comment", () => {
        const [entry] = parseFaq("# T\n\n## Вопрос?\n\nОтвет.\n<!-- ключи: слово -->\n");
        assert.equal(entry.question, "Вопрос?");
        assert.equal(entry.body, "Ответ.");
        assert.equal(entry.keywords, "слово");
    });
});

describe("search over the bundled knowledge base", () => {
    const kb = createKnowledge({ log: () => {}, fetchImpl: () => Promise.reject(new Error("offline")) });
    before(() => kb.load());

    const cases = [
        ["как вращать модель", /вращать, двигать и приближать модель/],
        ["как поменять диаметр окружности в эскизе", /диаметр окружности/],
        ["левая резьба", /левую резьбу/],
        ["где скачать для линукса", /Linux/],
        ["как импортировать stl", /импортировать STL/],
    ];
    for (const [query, title] of cases) {
        it(`"${query}" → the right FAQ entry, answered in full`, () => {
            const [top] = kb.index.search(query, 1);
            assert.equal(top.chunk.source, "faq");
            assert.match(top.chunk.title, title);
            const html = kb.answer(query);
            assert.ok(html.startsWith("<b>"), html.slice(0, 80));
            assert.match(html, title);
        });
    }

    it("reports nothing found", () => {
        assert.match(kb.answer("абракадабра ыыыы"), /Ничего не нашёл/);
    });

    it("has a sensible FAQ and the CHANGELOG", () => {
        assert.ok(kb.faq.length >= 25 && kb.faq.length <= 40, `FAQ entries: ${kb.faq.length}`);
        assert.ok(kb.changelog.length > 0);
        for (const c of kb.faq) assert.doesNotMatch(`${c.title} ${c.text}`, /fusion/i);
    });
});

describe("snippet answers", () => {
    it("lists up to three labelled snippets when no FAQ entry is clearly ahead", () => {
        const chunks = buildChunks({
            changelog: "## 1.0.0 — 01.01.2026\n\n### Добавлено\n\n- Резьба: дюймовая\n- Резьба: трубная\n",
            commands: [{ name: "Резьба", tab: "Тело", group: "Создать" }],
        });
        const html = answer(createIndex(chunks), "резьба");
        assert.match(html, /^Вот что нашлось/);
        assert.equal(html.match(/<b>\[/g).length, 3);
        assert.match(html, /\[Команда\]<\/b> «Резьба» — вкладка «Тело», группа «Создать»/);
    });

    it("uses the remote sources when they load", async () => {
        const fetchImpl = async (url) => ({
            ok: true,
            text: async () =>
                url.endsWith("CHANGELOG.md")
                    ? "## 9.9.9 — 01.01.2030\n\n### Добавлено\n\n- Новинка: телепорт\n"
                    : "",
        });
        const kb = createKnowledge({ log: () => {}, fetchImpl });
        await kb.load();
        assert.equal(kb.changelog[0].version, "9.9.9");
        assert.match(kb.answer("телепорт"), /\[Изменения\]<\/b> 9\.9\.9/);
    });
});
