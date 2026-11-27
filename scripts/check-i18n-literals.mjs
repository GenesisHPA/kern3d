// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Fails when a hard-coded English message is handed to a channel that shows it to the user
 * as it is: `Result.err(…)` (a feature's error row, a toast, the «Ошибки» log, an input's tip),
 * `alert`/`confirm`, `Toast.error`/`Toast.warn`, and the `displayError` / `displayValidation` /
 * `showToast "error.default:{0}"` events. Such a message must go through an i18n key
 * (`I18n.translate("error.…")`), so that it reads in the user's language.
 *
 * Not checked, by design: `throw new Error(…)` (programmer errors, kept English for bug
 * reports), the assistant (`packages/ai`, `parametric/src/program` — messages for the model,
 * not for a person), logs, and tests.
 *
 * Usage: node scripts/check-i18n-literals.mjs   (exit 1 and a list when something is found)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["app", "builder", "core", "element", "parametric", "storage", "three", "ui", "wasm", "web"];
const SKIPPED = [/\/parametric\/src\/program\//];
/** Sentinels compared by code, never shown: a cancelled file or font pick. */
const ALLOWED = new Set(["cancel"]);

function sourceFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) sourceFiles(file, out);
        else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(file);
    }
    return out;
}

const isKey = (text) => /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9{}:]+)+$/.test(text);
const isEnglish = (text) => /[A-Za-z]{2,}/.test(text) && !isKey(text) && !ALLOWED.has(text);

/** The literals an argument can evaluate to: itself, either side of a ternary, the fallback of `??`/`||`. */
function literalsOf(node, out = []) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push([node, node.text]);
    else if (ts.isTemplateExpression(node)) {
        out.push([
            node,
            node.head.text + node.templateSpans.map((span) => `{}${span.literal.text}`).join(""),
        ]);
    } else if (ts.isConditionalExpression(node)) {
        literalsOf(node.whenTrue, out);
        literalsOf(node.whenFalse, out);
    } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
        literalsOf(node.expression, out);
    else if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken)
            literalsOf(node.right, out);
        if (op === ts.SyntaxKind.PlusToken) {
            literalsOf(node.left, out);
            literalsOf(node.right, out);
        }
    }
    return out;
}

/** The argument of a user-facing call that carries the message, if `call` is one. */
function messageArgument(call, sf) {
    const callee = call.expression.getText(sf);
    const args = call.arguments;
    if (
        callee === "Result.err" ||
        /^(window\.)?(alert|confirm)$/.test(callee) ||
        /^Toast\.(error|warn)$/.test(callee)
    ) {
        return args[0];
    }
    if (/(^|\.)PubSub\.default\.pub$/.test(callee) && args.length >= 2) {
        const channel = args[0].getText(sf);
        if (channel === '"displayError"' || channel === '"displayValidation"') return args[1];
        if (channel === '"showToast"' && args[1].getText(sf) === '"error.default:{0}"') return args[2];
    }
    return undefined;
}

/** The hard-coded messages in one source text, as `name:line  "text"`. */
export function messagesIn(source, name) {
    const found = [];
    const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
        if (ts.isCallExpression(node)) {
            const argument = messageArgument(node, sf);
            for (const [literal, text] of argument ? literalsOf(argument) : []) {
                if (!isEnglish(text)) continue;
                const { line } = sf.getLineAndCharacterOfPosition(literal.getStart(sf));
                found.push(`${name}:${line + 1}  ${JSON.stringify(text)}`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
}

export function findHardCodedMessages() {
    const found = [];
    for (const pkg of PACKAGES) {
        for (const file of sourceFiles(path.join(repoRoot, "packages", pkg, "src"))) {
            const rel = path.relative(repoRoot, file).replaceAll("\\", "/");
            if (SKIPPED.some((re) => re.test(`/${rel}`))) continue;
            found.push(...messagesIn(readFileSync(file, "utf8"), rel));
        }
    }
    return found;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    // `--file <path>` checks one file instead of the packages (the suite proves the check bites).
    const only = process.argv.indexOf("--file");
    const found =
        only > 0
            ? messagesIn(readFileSync(process.argv[only + 1], "utf8"), path.basename(process.argv[only + 1]))
            : findHardCodedMessages();
    if (found.length > 0) {
        console.error(`${found.length} hard-coded user-facing message(s) — give each an i18n key (en + ru):`);
        for (const line of found) console.error(`  ${line}`);
        process.exit(1);
    }
    console.log("no hard-coded user-facing messages");
}
