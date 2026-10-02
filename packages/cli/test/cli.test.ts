// End-to-end: the bundled CLI answers through stdin, against a fake model server.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startFakeServer, type FakeServer } from "../../vscode/test/e2e/fakeServer";

const KEY = "sk-cli-e2e-0123456789abcdef";
let cli: string;
let server: FakeServer | undefined;

beforeAll(async () => {
  // Built fresh and without an update address: the test must never contact the update server.
  cli = path.join(mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-build-")), "cli.js");
  await build({
    entryPoints: [path.join(__dirname, "../src/index.ts")],
    outfile: cli,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    define: { __DIMOSI_UPDATE_URL__: '""', __DIMOSI_VERSION__: '"0.0.0-test"' },
    logLevel: "silent",
  });
}, 30_000);

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Runs `dimosi <args>` in `cwd`, typing `input` into stdin. */
function runCli(args: string[], cwd: string, home: string, input: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, DIMOSI_HOME: home, NO_COLOR: "1", CUSTOM_API_KEY: KEY },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

describe("CLI, end to end", () => {
  it("does a task with an approval typed into stdin, logs it, and never logs the key", async () => {
    server = await startFakeServer([
      { text: "Создаю.", toolCalls: [{ name: "write_file", args: { path: "hello.txt", content: "hi\n" } }] },
      { text: "Готово." },
    ]);
    const root = mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-root-"));
    const home = mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-home-"));
    const { code, out } = await runCli(
      ["--provider", "custom", "--base-url", server.url, "--model", "fake-model", "создай hello.txt"],
      root,
      home,
      "y\n",
    );
    expect(code).toBe(0);
    expect(out).toContain("Создать файл hello.txt");
    expect(out).toContain("+hi");
    expect(out).toContain("Готово.");
    expect(await fs.readFile(path.join(root, "hello.txt"), "utf8")).toBe("hi\n");
    expect(server.requests[0].auth).toBe(`Bearer ${KEY}`);

    const journal = await fs.readFile(path.join(home, "dimosi.log"), "utf8");
    expect(journal).toMatch(/\[info\] dimosi 0\.0\.0-test started: chat/);
    expect(journal).toMatch(/\[info\] request custom\/fake-model .*: ok in/);
    expect(journal).toMatch(/\[info\] tool write_file: ok in/);
    expect(journal).not.toContain(KEY);
    expect(journal).not.toContain("создай hello.txt");
  }, 30_000);

  it("a denied change is not written, and the model is told", async () => {
    server = await startFakeServer([
      { toolCalls: [{ name: "write_file", args: { path: "package.json", content: "{}" } }] },
      { text: "Хорошо, не буду." },
    ]);
    const root = mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-root-"));
    const home = mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-home-"));
    // --auto: package.json is still asked about, with a warning.
    const { code, out } = await runCli(["--provider", "custom", "--base-url", server.url, "--model", "fake-model", "--auto", "поправь package.json"], root, home, "n\n");
    expect(code).toBe(0);
    expect(out).toContain("postinstall");
    expect(out).toContain("Хорошо, не буду.");
    expect(existsSync(path.join(root, "package.json"))).toBe(false);
    expect(JSON.stringify(server.requests[1].body.messages)).toContain("The user rejected this change.");
  }, 30_000);
  it("a dangerous command is asked about even with --auto", async () => {
    server = await startFakeServer([
      { toolCalls: [{ name: "run_command", args: { command: "rm -f keep.txt" } }] },
      { text: "Не удаляю." },
    ]);
    const root = mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-root-"));
    const home = mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-home-"));
    await fs.writeFile(path.join(root, "keep.txt"), "x");
    const { code, out } = await runCli(["--provider", "custom", "--base-url", server.url, "--model", "fake-model", "--auto", "убери keep.txt"], root, home, "n\n");
    expect(code).toBe(0);
    expect(out).toContain("Удаление файлов");
    expect(existsSync(path.join(root, "keep.txt"))).toBe(true);
    expect(JSON.stringify(server.requests[1].body.messages)).toContain("The user rejected this command.");
  }, 30_000);
});
