// Bot state in DATA_DIR/state.json: subscribed chats, the last announced release tag, the
// GitHub ETag and the getUpdates offset. Written atomically (temp file + rename).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function emptyState() {
    return { offset: 0, lastTag: null, etag: null, latest: null, chats: [] };
}

export async function loadState(dir) {
    try {
        const raw = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
        return { ...emptyState(), ...raw, chats: Array.isArray(raw.chats) ? raw.chats : [] };
    } catch (error) {
        if (error.code !== "ENOENT")
            console.error(`[state] unreadable state.json, starting fresh: ${error.message}`);
        return emptyState();
    }
}

export async function saveState(dir, state) {
    await mkdir(dir, { recursive: true });
    const file = join(dir, "state.json");
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, file);
}
