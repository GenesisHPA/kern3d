// Kern3D Telegram bot: long polling (no open ports), release announcements, FAQ search.
import { COMMANDS, handleUpdate } from "./handlers.mjs";
import { createKnowledge } from "./knowledge.mjs";
import { checkRelease } from "./releases.mjs";
import { loadState, saveState } from "./state.mjs";
import { createTelegram } from "./telegram.mjs";

const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set");
    process.exit(1);
}
const dataDir = process.env.DATA_DIR || "/data";
const pollMinutes = Math.max(1, Number(process.env.RELEASE_POLL_MINUTES) || 10);

const stopping = new AbortController();
const tg = createTelegram(token, { log });
const state = await loadState(dataDir);
const kb = createKnowledge({ log });

// Saves are chained so the update loop and the release poller never write at the same time.
let saving = Promise.resolve();
const save = () => {
    saving = saving
        .then(() => saveState(dataDir, state))
        .catch((e) => log(`[state] save failed: ${e.message}`));
    return saving;
};

const sleep = (ms) =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        stopping.signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });

async function broadcast(html) {
    for (const chatId of [...state.chats]) {
        try {
            await tg.sendMessage(chatId, html);
        } catch (error) {
            const migrated = error.parameters?.migrate_to_chat_id;
            if (migrated) {
                state.chats = state.chats.map((id) => (id === chatId ? migrated : id));
                await tg.sendMessage(migrated, html).catch((e) => log(`[release] ${migrated}: ${e.message}`));
            } else if (error.code === 403 || /chat not found/i.test(error.description ?? "")) {
                state.chats = state.chats.filter((id) => id !== chatId);
                log(`[release] chat ${chatId} is gone, unsubscribed`);
            } else {
                log(`[release] chat ${chatId}: ${error.message}`);
            }
        }
    }
}

async function releaseLoop() {
    while (!stopping.signal.aborted) {
        try {
            const result = await checkRelease({ state, broadcast });
            if (result.release) {
                log(`[release] latest ${result.release.tag_name}${result.posted ? " — announced" : ""}`);
                await save();
            }
            if (result.changed) await kb.load();
        } catch (error) {
            log(`[release] ${error.message}`);
        }
        await sleep(pollMinutes * 60_000);
    }
}

async function updateLoop(me) {
    const ctx = { tg, kb, state, me, save, log };
    let delay = 1000;
    while (!stopping.signal.aborted) {
        let updates;
        try {
            updates = await tg.getUpdates(state.offset, stopping.signal);
            delay = 1000;
        } catch (error) {
            if (stopping.signal.aborted) break;
            log(`[updates] ${error.message}, retry in ${delay} ms`);
            await sleep(delay);
            delay = Math.min(delay * 2, 60_000);
            continue;
        }
        for (const update of updates) {
            state.offset = update.update_id + 1;
            try {
                await handleUpdate(ctx, update);
            } catch (error) {
                log(`[updates] update ${update.update_id}: ${error.message}`);
            }
        }
        if (updates.length > 0) await save();
    }
}

async function shutdown(signal) {
    if (stopping.signal.aborted) return;
    log(`${signal}: stopping`);
    stopping.abort();
    await save();
    process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const me = await tg.getMe();
log(`started as @${me.username}, data in ${dataDir}, ${state.chats.length} subscribed chat(s)`);
await kb.load();
tg.setMyCommands(COMMANDS.map(([command, description]) => ({ command, description }))).catch((e) =>
    log(`[bot] setMyCommands: ${e.message}`),
);
releaseLoop();
await updateLoop(me);
