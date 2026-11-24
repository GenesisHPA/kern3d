// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Where «Сообщить о проблеме» files its report: a new GitHub issue, filled in beforehand. */
const ISSUES = "https://github.com/GenesisHPA/kern3d/issues/new";
/** The last errors kept for the report (only in memory, sent only when the user opens it). */
const KEEP = 15;
/** GitHub refuses very long links: the body is cut to this. */
const MAX_BODY = 6000;

const recent: string[] = [];

function remember(text: string) {
    const line = `${new Date().toISOString().slice(11, 19)} ${text}`.slice(0, 400);
    recent.push(line);
    if (recent.length > KEEP) recent.shift();
}

function describe(value: unknown): string {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return typeof value === "string" ? value : String(value);
}

let installed = false;

/** Starts keeping the last errors (window errors, unhandled rejections, console.error). */
export function watchErrors() {
    if (installed || typeof window === "undefined") return;
    installed = true;
    window.addEventListener("error", (e) => remember(describe(e.error ?? e.message)));
    window.addEventListener("unhandledrejection", (e) => remember(describe(e.reason)));
    const original = console.error.bind(console);
    console.error = (...args: unknown[]) => {
        remember(args.map(describe).join(" "));
        original(...args);
    };
}

/** The pre-filled issue link: version, system, the last errors; the user writes what happened. */
export function problemReportUrl(version: string): string {
    const errors = recent.length === 0 ? "—" : recent.join("\n");
    let body = [
        "**Что случилось / What happened:**",
        "",
        "",
        "**Как повторить / Steps:**",
        "1. ",
        "",
        "---",
        `Kern3D ${version}`,
        `${navigator.userAgent}`,
        "",
        "Последние ошибки / Recent errors:",
        "```",
        errors,
        "```",
    ].join("\n");
    if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY - 4)}\n\`\`\``;
    const q = new URLSearchParams({ title: `[${version}] `, body });
    return `${ISSUES}?${q.toString()}`;
}
