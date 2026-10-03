import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
  // Like a real address with a saved token: the token must never be printed.
  git("remote", "add", "origin", `https://owner:${TOKEN}@github.com/example/dimosi.git`);
  return { dir, bin, git };
}

const TOKEN = "ghp_notARealTokenNotARealTokenNotAReal00";
type Run = { name: string; status: string; conclusion: string | null; html_url: string };
const ciRun = (status: string, conclusion: string | null, name = "CI"): Run => ({ name, status, conclusion, html_url: "https://github.com/example/dimosi/actions/runs/1" });

/** Runs the release script against a fake GitHub on 127.0.0.1 that answers with `runs` ("down": an error; "limit": no requests left this hour). */
async function release(f: ReturnType<typeof fixture>, args: string[], runs: Run[] | "down" | "limit") {
  const asked: string[] = [];
  const github = createServer((req, res) => {
    asked.push(req.url ?? "");
    if (runs === "limit") {
      res.writeHead(403, { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791000000" });
      res.end(JSON.stringify({ message: "API rate limit exceeded" }));
      return;
    }
    res.writeHead(runs === "down" ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(runs === "down" ? { message: "unavailable" } : { workflow_runs: runs }));
  });
  await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", resolve));
  try {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/release.mjs", ...args], {
      cwd: f.dir,
      env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, DIMOSI_SIGNING_KEY: "not-a-real-key", DIMOSI_GITHUB_API: `http://127.0.0.1:${(github.address() as AddressInfo).port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { status, out, asked, log: readFileSync(path.join(f.dir, "log.txt"), "utf8") };
  } finally {
    await new Promise((resolve) => github.close(resolve));
  }
}

describe.skipIf(process.platform === "win32")("release script", () => {
  it("runs tests and the build before asking for the key, and never passes the key on", async () => {
    const f = fixture();
    const r = await release(f, ["9.9.9"], [ciRun("completed", "success")]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/ключ не подходит/);
    expect(r.log).toMatch(/^npm test /m);
    expect(r.log).toMatch(/^npm run package /m);
    expect(r.log).not.toContain("not-a-real-key");
    expect(r.log).not.toMatch(/^(rsync|ssh) /m);
    // The version is put back: nothing was released.
    expect(f.git("status", "--porcelain")).toBe("");
  }, 30_000);

  it("asks GitHub about exactly the commit being released, and goes on when its CI is green", async () => {
    const f = fixture();
    const r = await release(f, ["9.9.9"], [ciRun("completed", "success")]);
    const sha = f.git("rev-parse", "HEAD").trim();
    expect(r.asked).toEqual([`/repos/example/dimosi/actions/runs?head_sha=${sha}`]);
    expect(r.out).toContain(`CI для коммита ${sha.slice(0, 7)} зелёный`);
    expect(r.out).not.toContain(TOKEN);
    expect(r.log).toMatch(/^npm test /m);
  }, 30_000);

  it.each<[string, Run[] | "down" | "limit", RegExp]>([
    ["the commit is not on GitHub (no CI run)", [], /нет проверки CI[^]*git push/],
    ["CI is still running", [ciRun("in_progress", null)], /ещё идёт/],
    ["CI failed", [ciRun("completed", "failure")], /не зелёный \(CI: failure\)/],
    ["one of several runs failed", [ciRun("completed", "success"), ciRun("completed", "cancelled", "Other")], /не зелёный \(Other: cancelled\)/],
    ["GitHub can't be asked", "down", /Не удалось узнать статус CI: GitHub ответил 503/],
    // Audit after 0.5.0, Р-5: 60 requests an hour per address, shared with everyone behind the same VPN.
    ["GitHub's hourly limit of requests is used up", "limit", /исчерпан лимит запросов[^]*Интернет в порядке[^]*после \d\d:\d\d/],
  ])("stops before anything else when %s", async (_name, runs, message) => {
    const f = fixture();
    const r = await release(f, ["9.9.9"], runs);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(message);
    expect(r.out).not.toContain(TOKEN);
    // Nothing ran: no tests, no build, no upload, and the version was not touched.
    expect(r.log).toBe("");
    expect(f.git("status", "--porcelain")).toBe("");
    expect(JSON.parse(readFileSync(path.join(f.dir, "package.json"), "utf8")).version).not.toBe("9.9.9");
  }, 30_000);

  it("takes the version from the command line, with or without --notes", async () => {
    for (const args of [["9.9.9"], ["9.9.9", "--notes", "Что нового"], ["--notes", "Что нового", "9.9.9"], ["--skip-ci", "9.9.9"]]) {
      const r = await release(fixture(), args, [ciRun("completed", "success")]);
      expect(r.out, args.join(" ")).toMatch(/Версия \d+\.\d+\.\d+ → 9\.9\.9/);
    }
  }, 60_000);

  it("--skip-ci releases without asking GitHub, and says so", async () => {
    const f = fixture();
    const r = await release(f, ["9.9.9", "--skip-ci"], [ciRun("completed", "failure")]);
    expect(r.asked).toEqual([]);
    expect(r.out).toContain("Проверка CI пропущена");
    expect(r.log).toMatch(/^npm test /m);
  }, 30_000);

  it("refuses a repository that is not on GitHub", async () => {
    const f = fixture();
    f.git("remote", "set-url", "origin", "https://example.org/some/repo.git");
    const r = await release(f, ["9.9.9"], [ciRun("completed", "success")]);
    expect(r.status).toBe(1);
    expect(r.asked).toEqual([]);
    expect(r.out).toMatch(/Не удалось определить репозиторий на GitHub/);
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

describe("CI workflow", () => {
  it("runs the unit tests and the test in a real VS Code on Linux and macOS", () => {
    const yml = readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8");
    expect(yml).toMatch(/os: \[ubuntu-latest, macos-latest\]/);
    expect(yml).toMatch(/run: npm test\n/);
    expect(yml).toMatch(/xvfb-run -a npm run test:vscode/);
    expect(JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).scripts["test:vscode"]).toBe("node packages/vscode/test/real/run.mjs");
  });

  it("pins every action to a full commit hash, with the version in a comment", () => {
    const yml = readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8");
    const uses = [...yml.matchAll(/uses:\s*(\S+)(.*)/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) {
      expect(ref, ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(rest, ref).toMatch(/#\s*v\d+\.\d+\.\d+/);
    }
  });
});
