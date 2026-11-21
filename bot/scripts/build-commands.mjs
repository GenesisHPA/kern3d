// Generates bot/kb/commands.json — every command's Russian name with its ribbon tab and group —
// and refreshes the bundled copies of CHANGELOG.md and README.md (the offline fallback).
// Run from anywhere: node bot/scripts/build-commands.mjs
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const bot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(bot, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

/** `"key": "value"` pairs of a locale file (single-line entries only — enough for commands). */
function translations(path) {
    const map = new Map();
    for (const match of read(path).matchAll(/"([\w.{}]+)":\s*"((?:[^"\\]|\\.)*)"/g)) {
        map.set(match[1], match[2].replace(/\\"/g, '"'));
    }
    return map;
}

const ru = translations("packages/i18n/src/ru.ts");
const en = translations("packages/i18n/src/en.ts");
const label = (key) => ru.get(key) ?? en.get(key);

const names = new Map();
for (const [key, value] of ru) if (key.startsWith("command.")) names.set(key.slice(8), value);
for (const [key, value] of en)
    if (key.startsWith("command.") && !names.has(key.slice(8))) names.set(key.slice(8), value);

// Ribbon layouts: a loose scan — tabName / groupName set the context, and every quoted string
// that names a known command is placed there. When a command sits in several tabs, the tab
// the user meets first wins.
const TAB_PRIORITY = [
    "ribbon.tab.sketch",
    "ribbon.tab.parametric",
    "ribbon.tab.drawing",
    "ribbon.tab.basic",
    "ribbon.tab.manager",
];
const placements = new Map();
for (const file of ["packages/builder/src/ribbon.ts", "packages/parametric/src/sketch/ribbon.ts"]) {
    let tab = null;
    let group = null;
    for (const match of read(file).matchAll(
        /(tabName|groupName):\s*"([^"]+)"|"([a-zA-Z][\w]*(?:\.[\w]+)*)"/g,
    )) {
        if (match[1] === "tabName") {
            tab = match[2];
            group = null;
        } else if (match[1] === "groupName") {
            group = match[2];
        } else if (tab && group && names.has(match[3])) {
            const list = placements.get(match[3]) ?? [];
            list.push({ tab, group });
            placements.set(match[3], list);
        }
    }
}

const rank = (tab) => {
    const i = TAB_PRIORITY.indexOf(tab);
    return i < 0 ? TAB_PRIORITY.length : i;
};

const seen = new Set();
const commands = [];
for (const [key, name] of [...names].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (key.startsWith("test.")) continue;
    const place = (placements.get(key) ?? []).sort((a, b) => rank(a.tab) - rank(b.tab))[0];
    const entry = { key, name };
    if (place) {
        const tab = label(place.tab);
        const group = label(place.group);
        if (tab) entry.tab = tab;
        if (group) entry.group = group;
    }
    const id = `${entry.name}|${entry.tab ?? ""}|${entry.group ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    commands.push(entry);
}

writeFileSync(resolve(bot, "kb/commands.json"), `${JSON.stringify(commands, null, 4)}\n`);
copyFileSync(resolve(root, "CHANGELOG.md"), resolve(bot, "kb/CHANGELOG.md"));
copyFileSync(resolve(root, "README.md"), resolve(bot, "kb/README.md"));
console.log(
    `commands.json: ${commands.length} commands (${commands.filter((c) => c.tab).length} on the ribbon)`,
);
