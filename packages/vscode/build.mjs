import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { readReleaseConfig } from "../../scripts/release-config.mjs";

const { updateUrl } = readReleaseConfig();
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
// Baked in at build time; an empty URL turns self-update off.
const define = {
  __DIMOSI_UPDATE_URL__: JSON.stringify(updateUrl),
  __DIMOSI_VERSION__: JSON.stringify(version),
};

await Promise.all([
  // Extension host (Node).
  build({
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["vscode"],
    sourcemap: true,
    define,
    logLevel: "info",
  }),
  // Chat panel (browser, inside the webview).
  build({
    entryPoints: ["webview/main.ts"],
    outfile: "media/chat.js",
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    logLevel: "info",
  }),
]);
