import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { downloadVerified, fetchManifest, isNewerVersion } from "@dimosi/core";
import { configDir } from "./config";
import { c } from "./ui";

export const VERSION = __DIMOSI_VERSION__;
const UPDATE_URL = __DIMOSI_UPDATE_URL__;
const DAY = 24 * 60 * 60 * 1000;
const stampFile = () => path.join(configDir(), "update-check.json");

/** Once a day, a short non-blocking hint that a newer version exists. */
export async function notifyIfOutdated(): Promise<void> {
  if (!UPDATE_URL) return;
  try {
    const stamp = JSON.parse(await fs.readFile(stampFile(), "utf8").catch(() => "{}"));
    if (stamp.at && Date.now() - stamp.at < DAY) {
      if (stamp.latest && isNewerVersion(stamp.latest, VERSION)) printHint(stamp.latest);
      return;
    }
    const manifest = await fetchManifest(UPDATE_URL, 3000);
    await fs.mkdir(configDir(), { recursive: true });
    await fs.writeFile(stampFile(), JSON.stringify({ at: Date.now(), latest: manifest.version }));
    if (manifest.cli && isNewerVersion(manifest.version, VERSION)) printHint(manifest.version);
  } catch {
    // offline or server unavailable: stay quiet
  }
}

function printHint(version: string): void {
  console.log(c.yellow(`Доступна новая версия dimosi ${version} (у вас ${VERSION}). Обновить: dimosi update`));
}

export async function cmdUpdate(): Promise<void> {
  if (!UPDATE_URL) throw new Error("Эта сборка dimosi собрана без адреса обновлений.");
  const manifest = await fetchManifest(UPDATE_URL);
  if (!manifest.cli || !isNewerVersion(manifest.version, VERSION)) {
    console.log(`У вас последняя версия dimosi (${VERSION}).`);
    return;
  }
  console.log(`Скачиваю dimosi ${manifest.version}…`);
  const data = await downloadVerified(UPDATE_URL, manifest.cli);
  const file = path.join(os.tmpdir(), manifest.cli.file);
  await fs.writeFile(file, data);
  console.log("Контрольная сумма совпала. Устанавливаю…");
  const code = await new Promise<number>((resolve) => {
    const child = spawn("npm", ["install", "-g", file], { stdio: "inherit", shell: process.platform === "win32" });
    child.on("close", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(1));
  });
  await fs.rm(file, { force: true });
  if (code !== 0) {
    throw new Error(
      "npm не смог установить обновление. Если дело в правах, выполните: sudo dimosi update",
    );
  }
  await fs.rm(stampFile(), { force: true });
  console.log(c.green(`Готово: dimosi ${manifest.version}.${manifest.notes ? " " + manifest.notes : ""}`));
}
