// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** A "### " group of a version: "Добавлено", "Изменено", "Исправлено". */
export interface ChangelogSection {
    title: string;
    items: string[];
}

/** One version of CHANGELOG.md: "## 0.9.3 — 05.11.2026" and its groups. */
export interface ChangelogRelease {
    version: string;
    /** What follows the dash: the date, or "готовится" for the version being made. */
    date: string;
    sections: ChangelogSection[];
}

/**
 * Reads CHANGELOG.md: "## " opens a version, "### " a group in it, "- " is an item (a line
 * indented under it continues it). Items before any group go into an untitled one.
 */
export function parseChangelog(markdown: string): ChangelogRelease[] {
    const releases: ChangelogRelease[] = [];
    let release: ChangelogRelease | undefined;
    let section: ChangelogSection | undefined;
    for (const raw of markdown.split(/\r?\n/)) {
        const line = raw.trimEnd();
        const version = /^##\s+(.+)$/.exec(line);
        if (version !== null) {
            const [name, ...rest] = version[1].split(/\s+[—–-]\s+/);
            release = { version: name.trim(), date: rest.join(" — ").trim(), sections: [] };
            section = undefined;
            releases.push(release);
            continue;
        }
        if (release === undefined) continue;
        const group = /^###\s+(.+)$/.exec(line);
        if (group !== null) {
            section = { title: group[1].trim(), items: [] };
            release.sections.push(section);
            continue;
        }
        const item = /^\s*[-*]\s+(.*)$/.exec(line);
        if (item !== null) {
            if (section === undefined) {
                section = { title: "", items: [] };
                release.sections.push(section);
            }
            section.items.push(stripMarkdown(item[1]));
        } else if (/^\s{2,}\S/.test(line) && section !== undefined && section.items.length > 0) {
            section.items[section.items.length - 1] += ` ${stripMarkdown(line.trim())}`;
        }
    }
    for (const r of releases) r.sections = r.sections.filter((s) => s.items.length > 0);
    return releases;
}

function stripMarkdown(text: string): string {
    return text
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/`(.+?)`/g, "$1")
        .replace(/\[(.+?)\]\((.+?)\)/g, "$1");
}
