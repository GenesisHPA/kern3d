// Command routing and the "when do we answer" rules.
import { faqEntryHtml, GUIDES, guideUrl } from "./knowledge.mjs";
import { fitMarkdown, latestReleased, TELEGRAM_LIMIT } from "./markdown.mjs";
import { formatDate, LINKS, linksHtml, versionOf } from "./releases.mjs";
import { escapeHtml } from "./telegram.mjs";

export const COMMANDS = [
    // /kern3d is ours alone: in a group /start and /help reach every bot there
    ["kern3d", "Вопросы о Kern3D — кнопки"],
    ["help", "Что умеет бот"],
    ["version", "Последняя версия и ссылки"],
    ["download", "Скачать Kern3D"],
    ["changes", "Что нового (можно указать версию)"],
    ["faq", "Частые вопросы"],
    ["guide", "Подробные руководства"],
    ["search", "Поиск по документации"],
];

/** Only for those who can use them: anyone in private, admins in groups (the command menu's scopes). */
export const SUBSCRIPTION_COMMANDS = [
    ["here", "Присылать сюда новости о релизах"],
    ["stop", "Не присылать новости о релизах"],
];

/**
 * The question buttons shown under the greeting: a short label and the words that find its FAQ
 * entry by title (the numbers follow the FAQ file, so they are looked up, not hard-coded).
 */
export const SUGGESTED = [
    ["📥 Где скачать", "где скачать"],
    ["🖱 Вращать и приближать", "мышью"],
    ["✏️ Редактировать эскиз", "отредактировать готовый эскиз"],
    ["📏 Размер в эскизе", "диаметр окружности"],
    ["⬆️ Выдавить эскиз", "выдавить эскиз"],
    ["🕳 Отверстие", "сделать отверстие"],
    ["🔩 Резьба", "сделать резьбу"],
    ["📦 Импорт STL", "импортировать stl"],
    ["🧊 STL и сканы → модель", "скан"],
    ["📐 Чертёж", "сделать чертёж"],
    ["🐞 Сообщить об ошибке", "сообщить об ошибке"],
];

/** Inline keyboard of the suggested questions (two per row) and «все вопросы». */
export function questionKeyboard(faq) {
    const buttons = [];
    for (const [label, words] of SUGGESTED) {
        const entry = faq.find((c) => c.title.toLowerCase().includes(words));
        if (entry) buttons.push({ text: label, callback_data: `faq:${entry.number}` });
    }
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    rows.push([{ text: "📚 Все вопросы", callback_data: "faq:list" }]);
    return { inline_keyboard: rows };
}

/** A reply that carries the question buttons. */
const withQuestions = (ctx, text) => ({ text, reply_markup: questionKeyboard(ctx.kb.faq) });

const isGroup = (chat) => chat?.type === "group" || chat?.type === "supergroup";

/** `/cmd@bot args` → `{ name, target, args }`, or null when the text is not a command. */
export function parseCommand(text) {
    const match = /^\/([a-zA-Z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(String(text ?? "").trim());
    if (!match) return null;
    return { name: match[1].toLowerCase(), target: match[2] ?? null, args: (match[3] ?? "").trim() };
}

/** Does the bot's username appear as a mention in the message? */
function mentionsMe(message, me) {
    const username = me?.username?.toLowerCase();
    if (!username) return false;
    const text = message.text ?? "";
    for (const entity of message.entities ?? []) {
        if (entity.type === "mention") {
            const value = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
            if (value === `@${username}`) return true;
        }
        if (entity.type === "text_mention" && entity.user?.id === me.id) return true;
    }
    return text.toLowerCase().includes(`@${username}`);
}

/**
 * Should a plain (non-command) message be answered? In private: always. In groups only when the
 * bot is @mentioned, the message replies to the bot, or the text starts with "?".
 */
export function shouldAnswer(message, me) {
    if (!message?.text) return false;
    if (message.from?.is_bot) return false;
    if (!isGroup(message.chat)) return message.chat?.type === "private";
    if (message.text.trimStart().startsWith("?")) return true;
    if (message.reply_to_message?.from?.id === me?.id) return true;
    return mentionsMe(message, me);
}

/** The question itself: without the bot mention and the leading "?". */
export function questionText(message, me) {
    let text = message.text ?? "";
    if (me?.username) text = text.replace(new RegExp(`@${me.username}\\b`, "gi"), " ");
    return text
        .replace(/^\s*\?+/, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * `where`: "private" (anyone subscribes themselves), "admin" (a group admin: the group's
 * subscription) or "member" (a group member: no subscription lines — they could not use them).
 */
function helpText(me, where = "private") {
    const name = me?.username ? `@${me.username}` : "бота";
    return [
        "<b>Бот Kern3D</b> — подсказки по программе, ссылки на скачивание и новости о релизах.",
        "",
        "/kern3d — вопросы кнопками (в группе вызывает только этого бота)",
        "/version — последняя версия и ссылки",
        "/download — скачать для Windows и Linux, онлайн-версия",
        "/changes — что нового; <code>/changes 0.9.5</code> — изменения версии",
        "/faq — частые вопросы; <code>/faq 3</code> — один ответ",
        "/guide — подробные руководства (STL и сканы → CAD…)",
        "/search <i>текст</i> — поиск по документации и руководствам",
        ...(where === "private"
            ? ["/here — присылать мне новости о релизах", "/stop — не присылать новости"]
            : where === "admin"
              ? ["/here — присылать в эту группу новости о релизах", "/stop — не присылать новости в группу"]
              : []),
        "",
        "В личке просто напишите вопрос, например: <i>как вращать модель</i>.",
        `В группе бот отвечает, если упомянуть ${escapeHtml(name)}, ответить на его сообщение или начать сообщение со знака «?».`,
        "",
        `Нашли ошибку? <a href="${LINKS.issues}">GitHub Issues</a> или напишите в группу.`,
    ].join("\n");
}

function guideText() {
    return [
        "<b>Руководства Kern3D</b>",
        "",
        ...GUIDES.map((g) => `📖 <a href="${guideUrl(g.file)}">${escapeHtml(g.title)}</a>`),
        "",
        "Поиск идёт и по ним: просто напишите вопрос, например <i>карта отклонений</i>.",
    ].join("\n");
}

function downloadText() {
    return [
        "<b>Скачать Kern3D</b>",
        linksHtml(),
        "",
        "<b>Windows:</b> запустите Kern3D-Setup.exe. Если появится окно «Система Windows защитила ваш компьютер», нажмите «Подробнее» → «Выполнить в любом случае».",
        "<b>Linux:</b> сделайте файл исполняемым — <code>chmod +x Kern3D-x86_64.AppImage</code> — и запустите.",
        "Установленная программа обновляется сама.",
    ].join("\n");
}

function versionText(ctx) {
    const latest = ctx.state.latest;
    const section = latestReleased(ctx.kb.changelog);
    const version = latest?.tag ? versionOf(latest.tag) : section?.version;
    const date = latest?.published_at ? formatDate(latest.published_at) : (section?.date ?? "");
    if (!version) return downloadText();
    return [
        `<b>Kern3D ${escapeHtml(version)}</b>${date ? ` от ${escapeHtml(date)}` : ""}`,
        "",
        linksHtml(latest?.html_url ?? LINKS.releases),
        "",
        "Что нового: /changes",
    ].join("\n");
}

function changesText(ctx, args) {
    const sections = ctx.kb.changelog;
    if (sections.length === 0) return "Журнал изменений сейчас недоступен.";
    const wanted = versionOf(args.split(/\s+/)[0] ?? "");
    const section = wanted ? sections.find((s) => s.version === wanted) : latestReleased(sections);
    if (!section) {
        const known = sections
            .slice(0, 12)
            .map((s) => s.version)
            .join(", ");
        return `Версии ${escapeHtml(wanted)} нет в журнале. Есть: ${escapeHtml(known)}.`;
    }
    const header = `<b>Kern3D ${escapeHtml(section.version)}</b>${section.date ? ` — ${escapeHtml(section.date)}` : ""}\n\n`;
    return header + fitMarkdown(section.lines, TELEGRAM_LIMIT - header.length);
}

function faqText(ctx, args) {
    const faq = ctx.kb.faq;
    if (faq.length === 0) return "Список частых вопросов пока пуст.";
    if (args) {
        const n = Number.parseInt(args, 10);
        const entry = faq[n - 1];
        if (!entry)
            return `Нет вопроса с номером ${escapeHtml(args)}. Всего вопросов: ${faq.length}, список — /faq`;
        return faqEntryHtml(entry);
    }
    const lines = faq.map((c) => `${c.number}. ${escapeHtml(c.title)}`);
    const out = ["<b>Частые вопросы</b> — ответ: <code>/faq номер</code>", ""];
    for (const line of lines) {
        if (out.join("\n").length + line.length + 1 > TELEGRAM_LIMIT - 10) break;
        out.push(line);
    }
    return out.join("\n");
}

async function canManageSubscription(ctx, message) {
    if (!isGroup(message.chat)) return true;
    if (message.sender_chat?.id === message.chat.id) return true; // anonymous admin
    if (!message.from) return false;
    try {
        const member = await ctx.tg.getChatMember(message.chat.id, message.from.id);
        return member?.status === "creator" || member?.status === "administrator";
    } catch (error) {
        ctx.log(`[bot] getChatMember: ${error.message}`);
        return false;
    }
}

async function subscribe(ctx, message, on) {
    if (!(await canManageSubscription(ctx, message))) {
        return "Подписку группы меняют только администраторы.";
    }
    const id = message.chat.id;
    const chats = new Set(ctx.state.chats);
    const had = chats.has(id);
    if (on) chats.add(id);
    else chats.delete(id);
    ctx.state.chats = [...chats];
    // a forum group: releases go to the topic /here was sent in (none → "General")
    const threads = { ...(ctx.state.threads ?? {}) };
    const thread = on && message.is_topic_message ? message.message_thread_id : undefined;
    const threadChanged = (threads[id] ?? undefined) !== thread;
    if (thread) threads[id] = thread;
    else delete threads[id];
    ctx.state.threads = threads;
    if (had !== on || threadChanged) await ctx.save();
    const where = !isGroup(message.chat) ? "вам" : thread ? "в эту тему" : "в этот чат";
    if (on)
        return had
            ? `${threadChanged ? "Готово" : "Уже подписано"}: новости о релизах приходят ${where}.`
            : `Готово: новости о релизах Kern3D будут приходить ${where}.`;
    return had ? "Подписка отключена: новостей о релизах больше не будет." : "Подписки и не было.";
}

/** Who is asking for help: in private anyone; in a group an admin or a member. */
async function audience(ctx, message) {
    if (!isGroup(message.chat)) return "private";
    return (await canManageSubscription(ctx, message)) ? "admin" : "member";
}

/** Builds the reply HTML for a message, or null when the bot should stay silent. */
export async function replyFor(ctx, message) {
    const text = message.text ?? "";
    const command = parseCommand(text);
    if (command) {
        const mine = ctx.me?.username?.toLowerCase();
        if (command.target && command.target.toLowerCase() !== mine) return null;
        switch (command.name) {
            case "start":
            case "kern3d":
            case "help":
                return withQuestions(
                    ctx,
                    `${helpText(ctx.me, await audience(ctx, message))}

<b>О чём спросить:</b>`,
                );
            case "version":
                return versionText(ctx);
            case "download":
                return downloadText();
            case "changes":
                return changesText(ctx, command.args);
            case "faq":
                return command.args ? faqText(ctx, command.args) : withQuestions(ctx, faqText(ctx, ""));
            case "guide":
                return guideText();
            case "search":
                return command.args
                    ? ctx.kb.answer(command.args)
                    : "Напишите, что искать: <code>/search левая резьба</code>";
            case "here":
                return subscribe(ctx, message, true);
            case "stop":
                return subscribe(ctx, message, false);
            default:
                return isGroup(message.chat) ? null : "Не знаю такой команды. Список команд — /help";
        }
    }
    if (!shouldAnswer(message, ctx.me)) return null;
    const question = questionText(message, ctx.me);
    if (question === "") return withQuestions(ctx, "Задайте вопрос о Kern3D или выберите:");
    return ctx.kb.answer(question);
}

/** A pressed question button: its FAQ entry (or the list), sent to the chat the button is in. */
export function callbackReply(ctx, data) {
    const match = /^faq:(\d+|list)$/.exec(String(data ?? ""));
    if (!match) return null;
    return match[1] === "list" ? withQuestions(ctx, faqText(ctx, "")) : faqText(ctx, match[1]);
}

async function handleCallback(ctx, query) {
    const reply = callbackReply(ctx, query.data);
    await ctx.tg.answerCallbackQuery(query.id).catch(() => {});
    const message = query.message;
    if (!reply || !message?.chat) return;
    const { text, reply_markup } = typeof reply === "string" ? { text: reply } : reply;
    const extra = reply_markup ? { reply_markup } : {};
    if (message.message_thread_id && message.is_topic_message)
        extra.message_thread_id = message.message_thread_id;
    await ctx.tg.sendMessage(message.chat.id, text, extra);
}

/** Handles one update: computes the reply and sends it (in groups as a reply to the question). */
export async function handleUpdate(ctx, update) {
    if (update.callback_query) return handleCallback(ctx, update.callback_query);
    const message = update.message;
    if (!message?.text || !message.chat) return;
    const result = await replyFor(ctx, message);
    if (!result) return;
    const { text: reply, reply_markup } = typeof result === "string" ? { text: result } : result;
    const extra = isGroup(message.chat)
        ? { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } }
        : {};
    if (reply_markup) extra.reply_markup = reply_markup;
    if (message.message_thread_id && message.is_topic_message)
        extra.message_thread_id = message.message_thread_id;
    await ctx.tg.sendMessage(message.chat.id, reply, extra);
}
