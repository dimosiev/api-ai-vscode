// Local release settings. release.config.json is NOT committed: it holds the
// secret update address. Copy release.config.example.json to start.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function readReleaseConfig() {
  const file = join(root, "release.config.json");
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const updateUrl = process.env.DIMOSI_UPDATE_URL ?? cfg.updateUrl ?? "";
  if (updateUrl && !/^https:\/\/.+\/$/.test(updateUrl)) {
    throw new Error("updateUrl must start with https:// and end with /");
  }
  return { updateUrl, ssh: cfg.ssh ?? "", remoteDir: cfg.remoteDir ?? "" };
}
