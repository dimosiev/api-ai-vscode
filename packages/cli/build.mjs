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

// Everything (core, SDKs) is bundled into one file, so the packed CLI has no runtime dependencies.
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  banner: { js: "#!/usr/bin/env node" },
  define,
  logLevel: "info",
});
