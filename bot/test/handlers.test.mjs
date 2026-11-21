import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import {
    callbackReply,
    handleUpdate,
    parseCommand,
    questionText,
    replyFor,
    SUGGESTED,
    shouldAnswer,
} from "../src/handlers.mjs";
import { createKnowledge } from "../src/knowledge.mjs";
import { emptyState, loadState, saveState } from "../src/state.mjs";
import { createTelegram } from "../src/telegram.mjs";

const me = { id: 42, is_bot: true, username: "kern3d_bot" };
const group = { id: -100, type: "supergroup" };
const priv = { id: 7, type: "private" };
const user = { id: 7, is_bot: false, first_name: "U" };
const msg = (text, extra = {}) => ({ message_id: 1, chat: group, from: user, text, ...extra });

describe("group triggers", () => {
    it("answers every message in private", () => {
        assert.equal(shouldAnswer(msg("как вращать", { chat: priv }), me), true);
    });
    it("stays silent in groups by default", () => {
        assert.equal(shouldAnswer(msg("как вращать модель"), me), false);
        assert.equal(shouldAnswer(msg("а где? ну да"), me), false);
    });
    it("answers in groups on ?, mention or reply to the bot", () => {
        assert.equal(shouldAnswer(msg("? как вращать"), me), true);
        assert.equal(
            shouldAnswer(
                msg("@kern3d_bot как вращать", { entities: [{ type: "mention", offset: 0, length: 11 }] }),
                me,
            ),
            true,
        );
        assert.equal(shouldAnswer(msg("а это?", { reply_to_message: { from: me } }), me), true);
        assert.equal(shouldAnswer(msg("а это?", { reply_to_message: { from: user } }), me), false);
    });
    it("ignores other bots", () => {
        assert.equal(shouldAnswer(msg("? x", { from: { id: 9, is_bot: true } }), me), false);
    });
    it("strips the mention and the question mark", () => {
        assert.equal(questionText(msg("?  @kern3d_bot левая резьба"), me), "левая резьба");
    });
    it("parses commands, with and without @bot", () => {
        assert.deepEqual(parseCommand("/faq@kern3d_bot 3"), { name: "faq", target: "kern3d_bot", args: "3" });
        assert.deepEqual(parseCommand("/version"), { name: "version", target: null, args: "" });
        assert.equal(parseCommand("текст"), null);
    });
});

describe("commands", () => {
    const kb = createKnowledge({ log: () => {}, fetchImpl: () => Promise.reject(new Error("offline")) });
    before(() => kb.load());

    function context(memberStatus = "member") {
        const sent = [];
        const tg = {
            sendMessage: async (chatId, text, extra) => sent.push({ chatId, text, extra }),
            getChatMember: async () => ({ status: memberStatus }),
        };
        let saves = 0;
        const ctx = { tg, kb, state: emptyState(), me, save: async () => saves++, log: () => {} };
        return { ctx, sent, saves: () => saves };
    }

    it("/faq lists numbered entries and /faq N shows one", async () => {
        const { ctx } = context();
        const listed = await replyFor(ctx, msg("/faq"));
        const list = listed.text;
        assert.ok(listed.reply_markup.inline_keyboard.length > 0);
        assert.match(list, /^<b>Частые вопросы<\/b>/);
        assert.match(list, /\n1\. /);
        assert.match(await replyFor(ctx, msg("/faq 1")), /^<b>Где скачать Kern3D\?<\/b>/);
        assert.match(await replyFor(ctx, msg("/faq 999")), /Нет вопроса/);
    });

    it("/start shows the question buttons, each one opening its FAQ entry", async () => {
        const { ctx, sent } = context();
        const start = await replyFor(ctx, msg("/start"));
        assert.match(start.text, /О чём спросить/);
        const buttons = start.reply_markup.inline_keyboard.flat();
        // every suggested question was found in the FAQ, plus «все вопросы»
        assert.equal(buttons.length, SUGGESTED.length + 1);
        for (const button of buttons) assert.ok(callbackReply(ctx, button.callback_data));
        const thread = buttons.find((b) => b.text.includes("Резьба"));
        assert.match(callbackReply(ctx, thread.callback_data), /резьб/i);
        assert.equal(callbackReply(ctx, "evil"), null);

        const answered = [];
        ctx.tg.answerCallbackQuery = async (id) => answered.push(id);
        await handleUpdate(ctx, {
            update_id: 1,
            callback_query: {
                id: "q1",
                data: thread.callback_data,
                message: { chat: { id: 7, type: "private" } },
            },
        });
        assert.deepEqual(answered, ["q1"]);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].chatId, 7);
        assert.match(sent[0].text, /резьб/i);
    });

    it("/help shows /here and /stop only to those who can use them", async () => {
        const member = await replyFor(context("member").ctx, msg("/help"));
        assert.doesNotMatch(member.text, /\/here|\/stop/);
        const admin = await replyFor(context("administrator").ctx, msg("/help"));
        assert.match(admin.text, /\/here — присылать в эту группу/);
        const personal = await replyFor(context("member").ctx, msg("/help", { chat: priv }));
        assert.match(personal.text, /\/here — присылать мне/);
    });

    it("/changes shows the newest released section or a given version", async () => {
        const { ctx } = context();
        assert.match(await replyFor(ctx, msg("/changes")), /<b>Kern3D \d+\.\d+\.\d+<\/b>/);
        assert.match(await replyFor(ctx, msg("/changes 0.9.5")), /Kern3D 0\.9\.5/);
        assert.match(await replyFor(ctx, msg("/changes 0.0.1")), /нет в журнале/);
    });

    it("/version and /download carry the download links", async () => {
        const { ctx } = context();
        for (const command of ["/version", "/download"]) {
            const html = await replyFor(ctx, msg(command));
            assert.ok(html.includes("Kern3D-Setup.exe") && html.includes("Kern3D-x86_64.AppImage"));
        }
    });

    it("ignores commands addressed to another bot and unknown commands in groups", async () => {
        const { ctx } = context();
        assert.equal(await replyFor(ctx, msg("/faq@other_bot")), null);
        assert.equal(await replyFor(ctx, msg("/whatever")), null);
    });

    it("/here in a group needs an admin", async () => {
        const plain = context("member");
        assert.match(await replyFor(plain.ctx, msg("/here")), /только администраторы/);
        assert.deepEqual(plain.ctx.state.chats, []);

        const admin = context("administrator");
        assert.match(await replyFor(admin.ctx, msg("/here")), /Готово/);
        assert.deepEqual(admin.ctx.state.chats, [-100]);
        assert.equal(admin.saves(), 1);
        assert.match(await replyFor(admin.ctx, msg("/stop")), /отключена/);
        assert.deepEqual(admin.ctx.state.chats, []);
    });

    it("/here in private subscribes the user", async () => {
        const { ctx } = context();
        await replyFor(ctx, msg("/here", { chat: priv }));
        assert.deepEqual(ctx.state.chats, [7]);
    });

    it("answers a group question as a reply, and stays silent otherwise", async () => {
        const { ctx, sent } = context();
        await handleUpdate(ctx, { update_id: 1, message: msg("просто болтаем") });
        assert.equal(sent.length, 0);
        await handleUpdate(ctx, { update_id: 2, message: msg("? левая резьба") });
        assert.equal(sent.length, 1);
        assert.match(sent[0].text, /левую резьбу/);
        assert.equal(sent[0].extra.reply_parameters.message_id, 1);
    });
});

describe("state and telegram client", () => {
    it("saves and loads state atomically", async () => {
        const dir = await mkdtemp(join(tmpdir(), "kern3d-bot-"));
        assert.deepEqual(await loadState(dir), emptyState());
        await saveState(dir, { ...emptyState(), offset: 5, chats: [1] });
        assert.equal(JSON.parse(await readFile(join(dir, "state.json"), "utf8")).offset, 5);
        assert.deepEqual((await loadState(dir)).chats, [1]);
    });

    it("honours retry_after on 429 and keeps the token out of errors", async () => {
        const waits = [];
        let calls = 0;
        const fetchImpl = async () => {
            calls++;
            if (calls === 1) {
                return {
                    status: 429,
                    json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 3 } }),
                };
            }
            if (calls === 2)
                return {
                    status: 400,
                    json: async () => ({ ok: false, error_code: 400, description: "Bad" }),
                };
            return { status: 200, json: async () => ({ ok: true, result: {} }) };
        };
        const tg = createTelegram("SECRET:TOKEN", {
            fetchImpl,
            sleepImpl: async (ms) => waits.push(ms),
            log: () => {},
        });
        await assert.rejects(tg.sendMessage(1, "x"), (error) => {
            assert.equal(error.code, 400);
            assert.doesNotMatch(error.message, /SECRET/);
            return true;
        });
        assert.deepEqual(waits, [3000]);
    });
});
