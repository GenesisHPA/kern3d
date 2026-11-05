// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "@rstest/core";
import { parseChangelog } from "../src/home/changelog";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("changelog", () => {
    test("versions with their dates, groups and items, markdown stripped", () => {
        const markdown = [
            "# Title",
            "",
            "intro",
            "",
            "## 1.1 — готовится",
            "",
            "### Добавлено",
            "",
            "- **New** thing",
            "- wrapped",
            "  item",
            "### Исправлено",
            "- bug",
            "",
            "## 1.0 — 01.01.2026",
            "- `first`",
        ].join("\n");
        expect(parseChangelog(markdown)).toEqual([
            {
                version: "1.1",
                date: "готовится",
                sections: [
                    { title: "Добавлено", items: ["New thing", "wrapped item"] },
                    { title: "Исправлено", items: ["bug"] },
                ],
            },
            { version: "1.0", date: "01.01.2026", sections: [{ title: "", items: ["first"] }] },
        ]);
    });

    test("CHANGELOG.md: the released version is in it, newest first, every group a standard one", () => {
        const root = path.resolve(HERE, "../../..");
        const releases = parseChangelog(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"));
        const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
        expect(releases.map((r) => r.version)).toContain(version);
        const groups = new Set(["Добавлено", "Изменено", "Исправлено"]);
        for (const r of releases) {
            expect(r.sections.length).toBeGreaterThan(0);
            for (const s of r.sections)
                expect([r.version, s.title, groups.has(s.title)]).toEqual([r.version, s.title, true]);
        }
        const numbers = releases.map((r) => r.version.split(".").map(Number));
        for (let k = 1; k < numbers.length; k++) {
            const [a, b] = [numbers[k - 1], numbers[k]];
            expect(a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).toBeGreaterThan(0);
        }
    });
});
