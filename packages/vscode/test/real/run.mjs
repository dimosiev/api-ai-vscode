// Starts a real VS Code with the freshly built extension and runs suite.ts
// inside it:  npm run test:vscode
//
// VS Code is downloaded once into .vscode-test/ (a download of about 150 MB, close to 900 MB unpacked). It runs with
// its own empty profile and no other extensions, so the user's VS Code, its
// settings and keys are not touched. The build has no update address: the
// test never contacts the update server. The model is the fake server on
// 127.0.0.1.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "../..");
const repo = join(pkg, "../..");
const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));

// A short path: VS Code's sockets live under the profile folder, and macOS limits their length.
const work = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "dimosi-vsc-"));
const ext = join(work, "ext");
const workspace = join(work, "project");

for (const f of ["package.json", "README.md", "LICENSE", "media/chat.css", "media/brand"]) cpSync(join(pkg, f), join(ext, f), { recursive: true });
cpSync(join(here, "workspace"), workspace, { recursive: true });

const node = { bundle: true, platform: "node", target: "node22", format: "cjs", external: ["vscode"], logLevel: "warning" };
await Promise.all([
  build({
    ...node,
    entryPoints: [join(pkg, "src/extension.ts")],
    outfile: join(ext, "dist/extension.js"),
    define: { __DIMOSI_UPDATE_URL__: '""', __DIMOSI_VERSION__: JSON.stringify(manifest.version) },
  }),
  build({ entryPoints: [join(pkg, "webview/main.ts")], outfile: join(ext, "media/chat.js"), bundle: true, platform: "browser", target: "es2022", format: "iife", logLevel: "warning" }),
  build({ ...node, entryPoints: [join(here, "suite.ts")], outfile: join(work, "suite.js") }),
]);

// The oldest VS Code dimosi supports, unless another one is asked for ("stable", "1.141.0"...).
const version = process.env.DIMOSI_VSCODE_VERSION ?? manifest.engines.vscode.replace(/^[^\d]*/, "");
console.log(`dimosi ${manifest.version} in VS Code ${version}`);

// Started from a VS Code terminal or extension, the new VS Code would inherit
// that window's variables and run as plain Node or talk to the wrong window.
for (const name of Object.keys(process.env)) {
  if (name === "ELECTRON_RUN_AS_NODE" || name.startsWith("VSCODE_")) delete process.env[name];
}

let code = 0;
try {
  await runTests({
    version,
    cachePath: join(repo, ".vscode-test"),
    extensionDevelopmentPath: ext,
    extensionTestsPath: join(work, "suite.js"),
    launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--user-data-dir", join(work, "profile")],
    // dimosi's own folder (global rules, journal) is a temporary one too.
    extensionTestsEnv: { DIMOSI_HOME: join(work, "dimosi-home") },
  });
  console.log("\n✔ dimosi works in the real VS Code");
} catch (e) {
  console.error(`\n✖ ${e instanceof Error ? e.message : e}`);
  code = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(code);
