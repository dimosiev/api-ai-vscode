import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.join(__dirname, "../../..");

/** A throwaway copy of what scripts/release.mjs needs, with fake npm, rsync and ssh that only log. */
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dimosi-release-"));
  for (const f of [
    "scripts/release.mjs", "scripts/release-config.mjs", "packages/core/src/update.ts", "packages/core/src/update-key.ts",
    "package.json", "packages/core/package.json", "packages/cli/package.json", "packages/vscode/package.json", "package-lock.json",
  ]) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    cpSync(path.join(REPO, f), path.join(dir, f));
  }
  writeFileSync(path.join(dir, ".gitignore"), "release.config.json\nbin/\nlog.txt\n");
  // Not a real address: nothing may reach the update server.
  writeFileSync(path.join(dir, "release.config.json"), JSON.stringify({ updateUrl: "https://updates.invalid/", ssh: "nobody@host.invalid", remoteDir: "/nowhere" }));
  writeFileSync(path.join(dir, "log.txt"), "");
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  for (const tool of ["npm", "rsync", "ssh"]) {
    writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $* key=\${DIMOSI_SIGNING_KEY:-none}" >> "${dir}/log.txt"\n${tool === "npm" ? "exit 0" : "exit 1"}\n`);
    chmodSync(path.join(bin, tool), 0o755);
  }
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return { dir, bin, git };
}

describe.skipIf(process.platform === "win32")("release script", () => {
  it("runs tests and the build before asking for the key, and never passes the key on", () => {
    const { dir, bin, git } = fixture();
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/release.mjs", "9.9.9"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DIMOSI_SIGNING_KEY: "not-a-real-key" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = readFileSync(path.join(dir, "log.txt"), "utf8");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ключ не подходит/);
    expect(log).toMatch(/^npm test /m);
    expect(log).toMatch(/^npm run package /m);
    expect(log).not.toContain("not-a-real-key");
    expect(log).not.toMatch(/^(rsync|ssh) /m);
    // The version is put back: nothing was released.
    expect(git("status", "--porcelain")).toBe("");
  }, 30_000);
});

describe.skipIf(process.platform === "win32")("signing key creation", () => {
  it("writes the private key to a private temporary folder, not to the Desktop (which may sync to iCloud)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dimosi-keygen-"));
    for (const f of ["scripts/signing-key.mjs", "scripts/release-config.mjs"]) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      cpSync(path.join(REPO, f), path.join(dir, f));
    }
    mkdirSync(path.join(dir, "packages/core/src"), { recursive: true });
    writeFileSync(path.join(dir, "packages/core/src/update-key.ts"), "export const UPDATE_PUBLIC_KEYS: string[] = [];\n");
    const home = path.join(dir, "home");
    const tmp = path.join(dir, "tmp");
    mkdirSync(path.join(home, "Desktop"), { recursive: true });
    mkdirSync(tmp);
    const r = spawnSync(process.execPath, ["scripts/signing-key.mjs"], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: home, TMPDIR: tmp } });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(path.join(home, "Desktop/dimosi-signing-key.txt"))).toBe(false);
    const file = r.stdout.match(/(\/\S+dimosi-signing-key\.txt)/)?.[1];
    expect(file && file.startsWith(tmp)).toBe(true);
    expect(statSync(path.dirname(file!)).mode & 0o777).toBe(0o700);
    expect(statSync(file!).mode & 0o777).toBe(0o600);
    expect(readFileSync(file!, "utf8")).toMatch(/^[A-Za-z0-9+/=]{40,}$/m);
    expect(readFileSync(path.join(dir, "packages/core/src/update-key.ts"), "utf8")).toMatch(/"[A-Za-z0-9+/=]{40,}",/);
  });
});
