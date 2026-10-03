// End-to-end: the bundled CLI answers through stdin, against a fake model server.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, promises as fs, realpathSync } from "node:fs";
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

  it("--read-dir and --write-dir open extra folders; config.json keeps a permanent list", async () => {
    const tmp = (name: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), `dimosi-cli-${name}-`)));
    const [root, home, readOnly, writable, fromConfig] = ["root", "home", "ro", "rw", "cfg"].map(tmp);
    await fs.writeFile(path.join(readOnly, "notes.md"), "заметка\n");
    await fs.writeFile(path.join(fromConfig, "list.md"), "список\n");
    await fs.writeFile(path.join(home, "config.json"), JSON.stringify({ extraFolders: [{ path: fromConfig }] }));
    server = await startFakeServer([
      {
        toolCalls: [
          { name: "read_file", args: { path: path.join(readOnly, "notes.md") } },
          { name: "read_file", args: { path: path.join(fromConfig, "list.md") } },
          { name: "write_file", args: { path: path.join(readOnly, "new.md"), content: "x\n" } },
          { name: "write_file", args: { path: path.join(writable, "new.md"), content: "x\n" } },
        ],
      },
      { text: "Готово." },
    ]);
    const { code, out } = await runCli(
      ["--provider", "custom", "--base-url", server.url, "--model", "fake-model", "--read-dir", readOnly, "--write-dir", writable, "работай"],
      root,
      home,
      "y\n",
    );
    expect(code).toBe(0);
    expect(out).toContain("Доступ: проект + 3 папки");
    expect(out).toContain(`${readOnly} — только чтение`);
    expect(out).toContain(`${writable} — чтение и запись`);
    expect(out).toContain(`Создать файл ${writable}/new.md`);
    expect(existsSync(path.join(writable, "new.md"))).toBe(true);
    expect(existsSync(path.join(readOnly, "new.md"))).toBe(false);
    const results = server.requests[1].body.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(results[0]).toContain("заметка");
    expect(results[1]).toContain("список");
    expect(results[2]).toMatch(/reading only/);
  }, 30_000);

  it("«always» for a command is kept for the project between runs, outside the project, and /allowed takes it back", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-root-"));
    const home = mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-home-"));
    const args = (task: string) => ["--provider", "custom", "--base-url", server!.url, "--model", "fake-model", "--no-sandbox", task];
    const command = (c: string) => [{ toolCalls: [{ name: "run_command", args: { command: c } }] }, { text: "Готово." }];

    server = await startFakeServer(command("echo hello one"));
    const first = await runCli(args("скажи привет"), root, home, "a\n");
    expect(first.out).toContain("больше не спрашивать в этом проекте про команды «echo hello …»");
    const file = path.join(home, "allowed-commands.json");
    expect(await fs.readFile(file, "utf8")).toContain("echo hello");
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(root, ".dimosi"))).toBe(false);
    await server.close();

    // A new run: the same beginning is not asked about, a chain is.
    server = await startFakeServer([...command("echo hello two"), ...command("echo hello three && echo more")]);
    const second = await runCli(args("ещё раз"), root, home, "и ещё\nn\n/allowed\n/allowed remove 1\n/allowed\n");
    expect(second.out.match(/Выполнить команду:/g)).toHaveLength(1);
    expect(second.out).toContain("$ echo hello three && echo more");
    expect(second.out).toContain("1. команды, которые начинаются с «echo hello»");
    expect(second.out).toContain("Запомненных команд в этом проекте нет");
    await server.close();

    server = await startFakeServer(command("echo hello four"));
    const third = await runCli(args("снова"), root, home, "y\n");
    expect(third.out).toContain("Выполнить команду:");
  }, 60_000);

  it("--plan: the agent changes nothing until /go", async () => {
    const write = { toolCalls: [{ name: "write_file", args: { path: "page.html", content: "<h1>hi</h1>\n" } }] };
    server = await startFakeServer([write, { text: "План: создать page.html." }, write, { text: "Готово." }]);
    const root = mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-root-"));
    const home = mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-home-"));
    const { code, out } = await runCli(["--provider", "custom", "--base-url", server.url, "--model", "fake-model", "--plan", "сделай страницу"], root, home, "/go\ny\n");
    expect(code).toBe(0);
    expect(out).toContain("План готов, ничего не изменено");
    // One question only: the write of the planning turn was refused without asking.
    expect(out.match(/Создать файл page\.html/g)).toHaveLength(1);
    expect(String(server.requests[1].body.messages.find((m) => m.role === "tool")!.content)).toMatch(/Plan mode is on/);
    expect(await fs.readFile(path.join(root, "page.html"), "utf8")).toBe("<h1>hi</h1>\n");
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

  it("a command with hidden characters shows them and has no «always» answer", async () => {
    server = await startFakeServer([
      { toolCalls: [{ name: "run_command", args: { command: "echo ok\u202E" } }] },
      { toolCalls: [{ name: "run_command", args: { command: "echo ok\u202E" } }] },
      { text: "Готово." },
    ]);
    const root = mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-root-"));
    const home = mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-home-"));
    const { code, out } = await runCli(["--provider", "custom", "--base-url", server.url, "--model", "fake-model", "--no-sandbox", "проверь"], root, home, "a\nn\n");
    expect(code).toBe(0);
    expect(out).toContain("$ echo ok⟦U+202E⟧");
    expect(out).toContain("скрытые символы");
    expect(out).not.toContain("\u202E");
    // «a» counted only once: the same command is asked about again.
    expect(out.match(/Разрешить\?/g)).toHaveLength(2);
  }, 30_000);

  it("--base-url is accepted only for custom and ollama", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-root-"));
    const home = mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-home-"));
    for (const args of [
      ["--provider", "polza", "--base-url", "https://evil.example/v1", "привет"],
      ["use", "anthropic", "claude-opus-5-5", "--base-url", "https://evil.example"],
    ]) {
      const { code, out } = await runCli(args, root, home, "");
      expect(code, args.join(" ")).not.toBe(0);
      expect(out).toContain("--base-url");
      expect(out).toMatch(/custom.*ollama/);
    }
    const { code, out } = await runCli(["use", "custom", "m", "--base-url", "http://example.com/v1"], root, home, "");
    expect(code).not.toBe(0);
    expect(out).toContain("https://");
  }, 30_000);
});

