// Publishes a new version to the update server; installed copies pick it up on their own.
//
//   npm run release                       # 0.3.0 -> 0.3.1
//   npm run release -- 0.4.0 --notes "Что нового"
//   npm run release -- --skip-ci          # only if GitHub itself is down
//
// The commit being released must be on GitHub with a green CI run.
//
// Needs release.config.json (see release.config.example.json) and the signing
// key from the password manager, pasted when asked after the checks pass.
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readReleaseConfig, root } from "./release-config.mjs";

const { MAX_NOTES_CHARS, parseManifest, signManifest, verifyManifest } = await import("../packages/core/src/update.ts");
const { UPDATE_PUBLIC_KEYS } = await import("../packages/core/src/update-key.ts");

// A key given in the environment is taken once and hidden from everything this
// script starts: tests, npm scripts and dependencies must never see it.
const envKey = process.env.DIMOSI_SIGNING_KEY;
delete process.env.DIMOSI_SIGNING_KEY;

const args = process.argv.slice(2);
const notesIndex = args.indexOf("--notes");
const notes = notesIndex >= 0 ? args[notesIndex + 1] ?? "" : "";
// The text after --notes is not a version; without --notes there is nothing to skip.
const versionArg = args.find((a, i) => !a.startsWith("--") && (notesIndex < 0 || i !== notesIndex + 1));

const fail = (message) => {
  console.error(`\n✖ ${message}`);
  process.exit(1);
};

const cfg = readReleaseConfig();
if (!cfg.updateUrl || !cfg.ssh || !cfg.remoteDir) fail("Заполните release.config.json (образец — release.config.example.json).");
if (!UPDATE_PUBLIC_KEYS.length) fail("Нет ключа подписи. Создайте его один раз: npm run signing-key");
if (notes.length > MAX_NOTES_CHARS) fail(`Описание длиннее ${MAX_NOTES_CHARS} символов.`);

const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const PACKAGES = ["package.json", "packages/core/package.json", "packages/cli/package.json", "packages/vscode/package.json"];

// 0. The release must match a commit, so it can be found and rebuilt later.
if (git("status", "--porcelain")) fail("Есть незакоммиченные изменения. Сначала закоммитьте их (git commit), потом выпускайте.");

// 0a. ...and that commit must have passed CI: Linux and macOS, including the test in a real VS Code.
if (args.includes("--skip-ci")) console.log("\n⚠ Проверка CI пропущена (--skip-ci). Этот выпуск не проверен на GitHub.");
else await requireGreenCi();

const revertVersion = () => execFileSync("git", ["checkout", "--", ...PACKAGES, "package-lock.json"], { cwd: root });

// 1. Version
const current = JSON.parse(readFileSync(join(root, "packages/vscode/package.json"), "utf8")).version;
const next = versionArg ?? current.replace(/\d+$/, (n) => String(Number(n) + 1));
if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`Неверная версия: ${next}`);
const [a, b] = [next.split(".").map(Number), current.split(".").map(Number)];
const newer = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
if (newer <= 0) fail(`Новая версия ${next} должна быть больше текущей ${current}.`);
for (const p of PACKAGES) {
  const file = join(root, p);
  const text = readFileSync(file, "utf8");
  writeFileSync(file, text.replace(/"version": "[^"]+"/, `"version": "${next}"`));
}
console.log(`\n▶ Версия ${current} → ${next}\n`);

// 2. Checks and build (the update URL is baked in from release.config.json).
//    They run before the key is asked for: the key lives in memory only for
//    the few seconds of signing, and no package script runs while it is there.
try {
  run("npm install --package-lock-only --ignore-scripts --silent");
  run("npm test");
  run("npm run typecheck");
  run("npm run package");
} catch {
  revertVersion();
  fail("Проверки или сборка не прошли — ничего не опубликовано, версия возвращена.");
}

// 3. Signing key, checked before use.
const privateKey = (envKey ?? (await askHidden("Проверки прошли. Вставьте ключ подписи из Bitwarden и нажмите Enter: "))).replace(/[^A-Za-z0-9+/=]/g, "");
try {
  const probe = { version: "0.0.0", vsix: { file: "probe.vsix", sha256: "0".repeat(64) } };
  verifyManifest({ ...probe, signature: signManifest(probe, privateKey) }, UPDATE_PUBLIC_KEYS);
} catch {
  revertVersion();
  fail("Этот ключ не подходит к открытому ключу в packages/core/src/update-key.ts. Проверьте, что скопировали ключ целиком. Версия возвращена, запустите выпуск заново.");
}

// 4. Signed manifest
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
manifest.signature = signManifest(manifest, privateKey);
verifyManifest(parseManifest(JSON.parse(JSON.stringify(manifest))), UPDATE_PUBLIC_KEYS);
writeFileSync(join(dist, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");

// 5. Upload: release files first, latest.json last (renamed into place), so
//    clients never see a manifest that points at a missing file.
const remote = cfg.remoteDir.replace(/\/$/, "");
execFileSync("rsync", ["-az", join(dist, files.vsix), join(dist, files.cli), `${cfg.ssh}:${remote}/`], { stdio: "inherit" });
execFileSync("rsync", ["-az", join(dist, "latest.json"), `${cfg.ssh}:${remote}/latest.json.tmp`], { stdio: "inherit" });
execFileSync("ssh", [cfg.ssh, `mv ${remote}/latest.json.tmp ${remote}/latest.json && cd ${remote} && ls -t dimosi-*.vsix | tail -n +6 | xargs -r rm -- && ls -t dimosi-cli-*.tgz | tail -n +6 | xargs -r rm --`], { stdio: "inherit" });

// 6. Verify through the public address, as an installed extension would.
const live = parseManifest(await (await fetch(cfg.updateUrl + "latest.json", { headers: { "cache-control": "no-cache" } })).json());
if (live.version !== next) fail(`Сервер отдаёт версию ${live.version}, ожидалась ${next}.`);
verifyManifest(live, UPDATE_PUBLIC_KEYS);
const vsix = new Uint8Array(await (await fetch(cfg.updateUrl + files.vsix)).arrayBuffer());
if (createHash("sha256").update(vsix).digest("hex") !== manifest.vsix.sha256) fail("Скачанный с сервера .vsix не совпал по контрольной сумме.");

// 7. Remember which commit this release is.
execFileSync("git", ["add", ...PACKAGES, "package-lock.json"], { cwd: root });
execFileSync("git", ["commit", "-m", `Release ${next}`], { cwd: root, stdio: "inherit" });
execFileSync("git", ["tag", `v${next}`], { cwd: root });

console.log(`\n✔ dimosi ${next} опубликован и подписан. Установленные расширения обновятся сами в течение 6 часов`);
console.log(`  (сразу — командой «dimosi: Проверить обновления»). CLI: dimosi update.`);
console.log(`  Создан коммит «Release ${next}» и метка v${next}. Отправьте их на GitHub: git push && git push --tags`);

/** Stops unless GitHub Actions has finished for the current commit and every run is green. */
async function requireGreenCi() {
  const sha = git("rev-parse", "HEAD");
  // Only owner/name is taken: the address itself may hold a token and is never printed.
  const repo = /github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/.exec(git("remote", "get-url", "origin"))?.[1];
  if (!repo) fail("Не удалось определить репозиторий на GitHub (git remote origin). Выпуск возможен только из репозитория с CI.");
  const api = process.env.DIMOSI_GITHUB_API ?? "https://api.github.com";
  let runs;
  let limitedUntil;
  try {
    const res = await fetch(`${api}/repos/${repo}/actions/runs?head_sha=${sha}`, { headers: { accept: "application/vnd.github+json", "user-agent": "dimosi-release" } });
    // Without a login GitHub answers 60 requests an hour per address; behind a VPN the address is shared.
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
      limitedUntil = new Date(Number(res.headers.get("x-ratelimit-reset")) * 1000);
    }
    if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
    runs = (await res.json()).workflow_runs ?? [];
  } catch (e) {
    if (limitedUntil) {
      const at = Number.isNaN(limitedUntil.getTime()) ? "через час" : `после ${limitedUntil.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
      fail(`Не удалось узнать статус CI: у GitHub исчерпан лимит запросов с вашего адреса (60 в час; с VPN адрес общий с другими людьми). Интернет в порядке. Запустите выпуск снова ${at}.`);
    }
    fail(`Не удалось узнать статус CI: ${e.message}. Проверьте интернет и повторите. Если GitHub не работает, а выпуск срочный: npm run release -- --skip-ci`);
  }
  const short = sha.slice(0, 7);
  if (!runs.length) fail(`Для коммита ${short} на GitHub нет проверки CI. Сначала отправьте коммиты (git push), дождитесь зелёной галочки и запустите выпуск снова.`);
  if (runs.some((r) => r.status !== "completed")) fail(`CI для коммита ${short} ещё идёт. Подождите несколько минут и запустите выпуск снова: ${runs[0].html_url}`);
  const red = runs.filter((r) => r.conclusion !== "success");
  if (red.length) fail(`CI для коммита ${short} не зелёный (${red.map((r) => `${r.name}: ${r.conclusion}`).join(", ")}). Выпуск остановлен: ${red[0].html_url}`);
  console.log(`\n✔ CI для коммита ${short} зелёный`);
}

/** Reads a line without showing it on screen. */
function askHidden(question) {
  if (!process.stdin.isTTY) {
    revertVersion();
    fail("Нет терминала для ввода ключа. Запустите выпуск в обычном терминале.");
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          return resolve(value);
        }
        if (ch === "\u0003") {
          cleanup();
          fail("Отменено.");
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    process.stdin.on("data", onData);
  });
}
