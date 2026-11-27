// /stats for the owner: Kern3D usage (the site's /kern3d/api/summary) and installer downloads.
import { escapeHtml } from "./telegram.mjs";

export const SUMMARY_URL = "https://genesistactical.net/kern3d/api/summary";
export const DASHBOARD_URL = "https://genesistactical.net/kern3d/stats/";

const PLATFORMS = { web: "онлайн", windows: "Windows", linux: "Linux", mac: "Mac", desktop: "ПК" };

/** «1 ч 5 мин» from minutes. */
export function hours(minutes) {
    const m = Math.round(minutes || 0);
    return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

function platformsLine(platforms = {}) {
    const parts = Object.entries(platforms)
        .sort((a, b) => b[1] - a[1])
        .map(([p, n]) => `${PLATFORMS[p] ?? escapeHtml(p)} ${n}`);
    return parts.length ? parts.join(" · ") : "—";
}

/** The summary JSON → Telegram HTML. */
export function formatStats(s) {
    const lines = [`<b>Kern3D — статистика</b> · ${escapeHtml(s.today ?? "")}`, ""];
    const names = { day: "Сегодня", week: "7 дней", month: "30 дней" };
    for (const key of ["day", "week", "month"]) {
        const p = s.periods?.[key];
        if (!p) continue;
        lines.push(
            `<b>${names[key]}:</b> пользователей ${p.users} (новых ${p.new}), запусков ${p.opens}, в работе ${hours(p.minutes)}`,
            `   ${platformsLine(p.platforms)}`,
        );
    }
    lines.push("", `Всего установок за всё время: ${s.all_installs ?? 0}`);
    if (s.versions?.length) {
        lines.push(`Версии (30 дней): ${s.versions.map((v) => `${escapeHtml(v.version)} — ${v.users}`).join(", ")}`);
    }
    const downloads = s.downloads ?? [];
    if (downloads.length) {
        const total = { exe: 0, appimage: 0 };
        for (const d of downloads) {
            if (/\.exe$/i.test(d.name)) total.exe += d.count;
            else if (/\.appimage$/i.test(d.name)) total.appimage += d.count;
        }
        const latest = downloads[0]?.release;
        const last = downloads
            .filter((d) => d.release === latest)
            .map((d) => `${/\.exe$/i.test(d.name) ? "Windows" : "Linux"} ${d.count}`)
            .join(", ");
        lines.push(
            "",
            "<b>Скачивания с GitHub</b>",
            `Всего: Windows ${total.exe}, Linux ${total.appimage}`,
            `${escapeHtml(latest ?? "")}: ${last || "—"}`,
        );
    } else {
        lines.push("", "Скачивания с GitHub сейчас недоступны.");
    }
    lines.push("", `<a href="${DASHBOARD_URL}">Подробно на сайте</a>`);
    return lines.join("\n");
}

/** Fetches and formats; a short message on failure. */
export async function statsText({ token, fetchImpl = fetch, url = SUMMARY_URL }) {
    if (!token) return "Статистика не настроена: нет K3_STATS_TOKEN.";
    try {
        const r = await fetchImpl(url, { headers: { "X-Stats-Token": token }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) return `Сайт статистики ответил ${r.status}.`;
        return formatStats(await r.json());
    } catch (error) {
        return `Не удалось получить статистику: ${escapeHtml(error.message)}`;
    }
}
