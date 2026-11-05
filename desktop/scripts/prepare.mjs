// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Copies the web build (../dist) into desktop/app and keeps the desktop version equal to the
// root package version, so the installer, the in-app version and the update feed agree.

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(desktop, "..");
const dist = join(root, "dist");
const target = join(desktop, "app");

if (!existsSync(join(dist, "index.html"))) {
    console.error("[desktop] ../dist/index.html not found — run `npm run build` in the repo root first.");
    process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(dist, target, { recursive: true });

const rootVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const pkgPath = join(desktop, "package.json");
const pkgText = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(pkgText);
if (pkg.version !== rootVersion) {
    pkg.version = rootVersion;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 4)}\n`);
    console.log(`[desktop] version -> ${rootVersion}`);
}
console.log(`[desktop] web build copied to desktop/app (v${rootVersion})`);
