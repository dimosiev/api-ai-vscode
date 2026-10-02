// Builds both packages and puts the portable files into ./dist:
//   dimosi-<version>.vsix      — the VS Code extension
//   dimosi-cli-<version>.tgz   — the terminal agent (npm install -g <file>)
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: "inherit" });

mkdirSync(dist, { recursive: true });
// Old build outputs (version 0.1 used other names).
for (const f of readdirSync(dist)) {
  if (f.startsWith("api-ai-")) rmSync(join(dist, f));
}

run("npm run build");

const ext = JSON.parse(readFileSync(join(root, "packages/vscode/package.json"), "utf8"));
const vsix = join(dist, `dimosi-${ext.version}.vsix`);
run(`npx vsce package --no-dependencies --allow-missing-repository --out "${vsix}"`, join(root, "packages/vscode"));

// npm names the scoped package "dimosi-cli-<version>.tgz".
run(`npm pack -w @dimosi/cli --pack-destination "${dist}"`);

console.log(`\nГотово. Файлы для переноса лежат в ${dist}:`);
for (const f of readdirSync(dist)) console.log("  " + f);
