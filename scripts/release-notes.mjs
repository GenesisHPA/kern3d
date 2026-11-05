// Release notes for GitHub: the version's section of CHANGELOG.md, then the install text
// (desktop/release-notes/default.md). Usage: node scripts/release-notes.mjs 0.9.4
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!version) {
    console.error("usage: node scripts/release-notes.mjs <version>");
    process.exit(1);
}
const lines = readFileSync(resolve(root, "CHANGELOG.md"), "utf8").split(/\r?\n/);
const heading = (l) => l.startsWith("## ") && l.slice(3).trim().split(/\s+/)[0] === version;
const start = lines.findIndex(heading);
const items = [];
if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
        if (line.startsWith("## ")) break;
        if (line.trim() !== "") items.push(line);
    }
}
const install = readFileSync(resolve(root, "desktop/release-notes/default.md"), "utf8").trim();
const parts = [];
if (items.length > 0) parts.push(`**Что нового в ${version}**\n${items.join("\n")}`);
parts.push(install);
parts.push(
    "Все изменения по версиям: [CHANGELOG.md](https://github.com/GenesisHPA/kern3d/blob/main/CHANGELOG.md)",
);
process.stdout.write(`${parts.join("\n\n")}\n`);
