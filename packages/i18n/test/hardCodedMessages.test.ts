// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, "scripts/check-i18n-literals.mjs");

/** Runs the check; a failure exits 1, so its stderr is the list. */
function runCheck(args: string[]): { ok: boolean; output: string } {
    try {
        return {
            ok: true,
            output: execFileSync("node", [script, ...args], { cwd: repoRoot, encoding: "utf8" }),
        };
    } catch (error) {
        return { ok: false, output: String((error as { stderr?: unknown }).stderr ?? error) };
    }
}

/**
 * A refusal (`Result.err`), a toast, an alert or a validation message is shown to the user as it
 * is, so an English literal there reads English in the Russian UI. The script walks the sources
 * of every package with a UI; the same check runs as `node scripts/check-i18n-literals.mjs`.
 */
test("no user-facing message is a hard-coded English string", () => {
    const { ok, output } = runCheck([]);
    if (!ok) throw new Error(output);
    expect(output).toContain("no hard-coded user-facing messages");
});

test("the check finds the channels it guards and lets keys, translations and sentinels through", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "i18n-literals-"));
    const file = path.join(dir, "sample.ts");
    writeFileSync(
        file,
        [
            'Result.err("Pick an edge");',
            'Result.err(flag ? `Edge ${i} not found` : I18n.translate("error.app.pathNull"));',
            'PubSub.default.pub("displayValidation", "Rectangle sides are too small");',
            'PubSub.default.pub("showToast", "error.default:{0}", "Invalid thickness");',
            'alert("Plugin failed");',
            'Result.err(I18n.translate("error.command.pickEdge"));',
            'Result.err("error.input.invalidNumber");',
            'Result.err("cancel");',
            'PubSub.default.pub("showToast", "toast.success");',
        ].join("\n"),
    );
    try {
        const { ok, output } = runCheck(["--file", file]);
        expect(ok).toBe(false);
        expect(output).toContain('sample.ts:1  "Pick an edge"');
        expect(output).toContain('sample.ts:2  "Edge {} not found"');
        expect(output).toContain('sample.ts:3  "Rectangle sides are too small"');
        expect(output).toContain('sample.ts:4  "Invalid thickness"');
        expect(output).toContain('sample.ts:5  "Plugin failed"');
        expect(output).toContain("5 hard-coded user-facing message(s)");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
