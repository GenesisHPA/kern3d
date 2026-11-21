// Minimal Telegram Bot API client: plain fetch, retries on 429 (retry_after) and on
// network/5xx errors with exponential backoff. The token never appears in logs or errors.

/** Escapes text for parse_mode "HTML". */
export function escapeHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class TelegramError extends Error {
    constructor(method, code, description, parameters) {
        super(`Telegram ${method}: ${code} ${description}`);
        this.code = code;
        this.description = description;
        this.parameters = parameters ?? {};
    }
}

const sleep = (ms, signal) =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });

/**
 * @param {string} token
 * @param {{ fetchImpl?: typeof fetch, sleepImpl?: typeof sleep, maxAttempts?: number, log?: (m: string) => void }} [options]
 */
export function createTelegram(token, options = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const wait = options.sleepImpl ?? sleep;
    const maxAttempts = options.maxAttempts ?? 6;
    const log = options.log ?? ((m) => console.error(m));
    const base = `https://api.telegram.org/bot${token}/`;

    async function call(method, params = {}, { signal, timeoutMs = 30_000 } = {}) {
        let delay = 1000;
        for (let attempt = 1; ; attempt++) {
            let response;
            let body;
            try {
                const timeout = AbortSignal.timeout(timeoutMs);
                response = await fetchImpl(base + method, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(params),
                    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
                });
                body = await response.json();
            } catch (error) {
                if (signal?.aborted) throw error;
                // Network error or a non-JSON reply: retry, without echoing the URL (it holds the token).
                if (attempt >= maxAttempts) throw new TelegramError(method, 0, error?.name ?? "network");
                log(`[telegram] ${method}: ${error?.name ?? "error"}, retry in ${delay} ms`);
                await wait(delay, signal);
                delay = Math.min(delay * 2, 60_000);
                continue;
            }
            if (body?.ok) return body.result;
            const code = body?.error_code ?? response.status;
            const description = body?.description ?? "";
            if (code === 429 && attempt < maxAttempts) {
                const retryAfter = Number(body?.parameters?.retry_after ?? 1);
                log(`[telegram] ${method}: 429, retry after ${retryAfter} s`);
                await wait(retryAfter * 1000, signal);
                continue;
            }
            if (code >= 500 && attempt < maxAttempts) {
                log(`[telegram] ${method}: ${code}, retry in ${delay} ms`);
                await wait(delay, signal);
                delay = Math.min(delay * 2, 60_000);
                continue;
            }
            throw new TelegramError(method, code, description, body?.parameters);
        }
    }

    return {
        call,
        getMe: () => call("getMe"),
        getUpdates: (offset, signal) =>
            call(
                "getUpdates",
                { offset, timeout: 50, allowed_updates: ["message", "callback_query"] },
                { signal, timeoutMs: 65_000 },
            ),
        sendMessage: (chatId, text, extra = {}) =>
            call("sendMessage", {
                chat_id: chatId,
                text,
                parse_mode: "HTML",
                link_preview_options: { is_disabled: true },
                ...extra,
            }),
        answerCallbackQuery: (id, text) =>
            call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }),
        getChatMember: (chatId, userId) => call("getChatMember", { chat_id: chatId, user_id: userId }),
        setMyCommands: (commands) => call("setMyCommands", { commands }),
    };
}
