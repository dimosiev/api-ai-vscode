// Publishes a new version to the update server; installed copies pick it up on their own.
//
//   npm run release                       # 0.3.0 -> 0.3.1
//   npm run release -- 0.4.0 --notes "Что нового"
//
// Needs release.config.json (see release.config.example.json).
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readReleaseConfig, root } from "./release-config.mjs";

const args = process.argv.slice(2);
const notesIndex = args.indexOf("--notes");
const notes = notesIndex >= 0 ? args[notesIndex + 1] ?? "" : "";
const versionArg = args.find((a, i) => !a.startsWith("--") && i !== notesIndex + 1);

const cfg = readReleaseConfig();
if (!cfg.updateUrl || !cfg.ssh || !cfg.remoteDir) {
  console.error("Заполните release.config.json (образец — release.config.example.json).");
  process.exit(1);
}

const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });
const PACKAGES = ["package.json", "packages/core/package.json", "packages/cli/package.json", "packages/vscode/package.json"];

// 1. Version
const current = JSON.parse(readFileSync(join(root, "packages/vscode/package.json"), "utf8")).version;
const next = versionArg ?? current.replace(/\d+$/, (n) => String(Number(n) + 1));
if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`Неверная версия: ${next}`);
const [a, b] = [next.split(".").map(Number), current.split(".").map(Number)];
const newer = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
if (newer <= 0) throw new Error(`Новая версия ${next} должна быть больше текущей ${current}.`);
for (const p of PACKAGES) {
  const file = join(root, p);
  const text = readFileSync(file, "utf8");
  writeFileSync(file, text.replace(/"version": "[^"]+"/, `"version": "${next}"`));
}
run("npm install --package-lock-only --ignore-scripts --silent");
console.log(`\n▶ Версия ${current} → ${next}\n`);

// 2. Checks and build (the update URL is baked in from release.config.json)
run("npm test");
run("npm run typecheck");
run("npm run package");

// 3. Manifest
const dist = join(root, "dist");
const files = { vsix: `dimosi-${next}.vsix`, cli: `dimosi-cli-${next}.tgz` };
const hash = (f) => createHash("sha256").update(readFileSync(join(dist, f))).digest("hex");
const manifest = {
  version: next,
  date: new Date().toISOString().slice(0, 10),
  ...(notes ? { notes } : {}),
  vsix: { file: files.vsix, sha256: hash(files.vsix) },
  cli: { file: files.cli, sha256: hash(files.cli) },
};
writeFileSync(join(dist, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");

// 4. Upload: release files first, latest.json last (renamed into place), so
//    clients never see a manifest that points at a missing file.
const remote = cfg.remoteDir.replace(/\/$/, "");
execFileSync("rsync", ["-az", join(dist, files.vsix), join(dist, files.cli), `${cfg.ssh}:${remote}/`], { stdio: "inherit" });
execFileSync("rsync", ["-az", join(dist, "latest.json"), `${cfg.ssh}:${remote}/latest.json.tmp`], { stdio: "inherit" });
execFileSync("ssh", [cfg.ssh, `mv ${remote}/latest.json.tmp ${remote}/latest.json && cd ${remote} && ls -t dimosi-*.vsix | tail -n +6 | xargs -r rm -- && ls -t dimosi-cli-*.tgz | tail -n +6 | xargs -r rm --`], { stdio: "inherit" });

// 5. Verify through the public address, as an installed extension would.
const live = await (await fetch(cfg.updateUrl + "latest.json", { headers: { "cache-control": "no-cache" } })).json();
if (live.version !== next) throw new Error(`Сервер отдаёт версию ${live.version}, ожидалась ${next}.`);
const vsix = new Uint8Array(await (await fetch(cfg.updateUrl + files.vsix)).arrayBuffer());
if (createHash("sha256").update(vsix).digest("hex") !== manifest.vsix.sha256) throw new Error("Скачанный с сервера .vsix не совпал по контрольной сумме.");

console.log(`\n✔ dimosi ${next} опубликован. Установленные расширения обновятся сами в течение 6 часов`);
console.log(`  (сразу — командой «dimosi: Проверить обновления»). CLI: dimosi update.`);
console.log(`  Не забудьте закоммитить смену версии: git commit -am "Release ${next}"`);
