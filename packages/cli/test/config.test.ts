import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptKeys } from "@dimosi/core";
import { loadTrustDecisions, saveConfig, secureConfigDir } from "../src/config";
import { EncryptedFileKeyStore } from "../src/keystore";
import { fileSink } from "../src/log";
import { npmInstallInvocation } from "../src/update";

const mode = (p: string) => statSync(p).mode & 0o777;
let home: string;
const saved = process.env.DIMOSI_HOME;

beforeEach(() => {
  home = path.join(mkdtempSync(path.join(os.tmpdir(), "dimosi-cfg-")), "dimosi");
  process.env.DIMOSI_HOME = home;
});

afterEach(() => {
  if (saved === undefined) delete process.env.DIMOSI_HOME;
  else process.env.DIMOSI_HOME = saved;
});

describe.skipIf(process.platform === "win32")("the dimosi settings folder", () => {
  it("is created private, and every file in it too", async () => {
    await saveConfig({ provider: "ollama", models: {}, baseUrls: {}, mode: "ask" });
    await (await loadTrustDecisions()).set("h", true);
    await (await EncryptedFileKeyStore.open("pw")).set("polza", "pz-secret");
    fileSink()("info", "hello");
    expect(mode(home)).toBe(0o700);
    for (const f of ["config.json", "trusted-rules.json", "keys.aienc", "dimosi.log"]) expect(mode(path.join(home, f)), f).toBe(0o600);
    // Written through a temporary file and a rename: nothing is left behind.
    expect(readdirSync(home).sort()).toEqual(["config.json", "dimosi.log", "keys.aienc", "trusted-rules.json"]);
  });

  it("an existing folder and its files are made private on start", async () => {
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    const files = ["config.json", "trusted-rules.json", "update-check.json", "keys.aienc", "dimosi.log", "rules.md"];
    for (const f of files) writeFileSync(path.join(home, f), "{}", { mode: 0o644 });
    await secureConfigDir();
    expect(mode(home)).toBe(0o700);
    for (const f of files) expect(mode(path.join(home, f)), f).toBe(0o600);
  });

  it("keys.aienc is replaced whole, so it opens after every save", async () => {
    const store = await EncryptedFileKeyStore.open("pw");
    for (let i = 0; i < 5; i++) await store.set(`k${i}`, `v${i}`);
    const text = (await import("node:fs")).readFileSync(path.join(home, "keys.aienc"), "utf8");
    expect(Object.keys(decryptKeys(text, "pw"))).toHaveLength(5);
  }, 30_000); // every save derives the key anew (scrypt): about a second alone, much longer on a busy machine
});

describe("installing a CLI update", () => {
  it("runs npm from the download folder, so a project's own npm.cmd is never picked up on Windows", () => {
    const file = "C:\\Users\\Ivan Petrov\\AppData\\Local\\Temp\\dimosi-update-x\\dimosi-cli-0.4.7.tgz";
    const win = npmInstallInvocation(file, "C:\\Users\\Ivan Petrov\\AppData\\Local\\Temp\\dimosi-update-x", "win32");
    expect(win.args).toEqual(["install", "-g", `"${file}"`]);
    expect(win.options).toMatchObject({ cwd: "C:\\Users\\Ivan Petrov\\AppData\\Local\\Temp\\dimosi-update-x", shell: true });
    const mac = npmInstallInvocation("/tmp/x/dimosi-cli-0.4.7.tgz", "/tmp/x", "darwin");
    expect(mac.args).toEqual(["install", "-g", "/tmp/x/dimosi-cli-0.4.7.tgz"]);
    expect(mac.options).toMatchObject({ cwd: "/tmp/x", shell: false });
  });
});

