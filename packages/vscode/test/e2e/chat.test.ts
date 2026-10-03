// End-to-end: the real chat panel logic (ChatViewProvider, agent, tools,
// OpenAI SDK) against a fake VS Code API and a fake model server over HTTP.
import { existsSync, mkdtempSync, promises as fs, readFileSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProposedContentProvider, WebviewApproval } from "../../src/approval";
import { ChatViewProvider } from "../../src/chatView";
import { SecretKeyStore } from "../../src/keyStore";
import { log } from "../../src/log";
import type { FromWebview, ToWebview } from "../../src/protocol";
import { sentText, startFakeServer, type FakeServer } from "./fakeServer";
import { stub, Uri, window, workspace } from "./vscode";

const KEY = "sk-e2e-0123456789abcdefghij";

/** The parts of ExtensionContext the panel uses; state survives a "reload". */
function fakeContext(storage: string) {
  const state = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  return {
    extensionUri: Uri.file(path.join(__dirname, "../..")),
    storageUri: Uri.file(storage),
    globalStorageUri: Uri.file(path.join(storage, "global")),
    subscriptions: [] as Array<{ dispose(): unknown }>,
    extension: { packageJSON: { version: "0.0.0-test" } },
    globalState: {
      get: <T>(k: string, fallback?: T) => (state.has(k) ? (state.get(k) as T) : fallback),
      update: async (k: string, v: unknown) => void state.set(k, v),
    },
    secrets: {
      get: async (k: string) => secrets.get(k),
      store: async (k: string, v: string) => void secrets.set(k, v),
      delete: async (k: string) => void secrets.delete(k),
    },
  };
}

/** A chat panel as VS Code would host it, with a webview we can talk to. */
class Panel {
  posted: ToWebview[] = [];
  private receive?: (msg: FromWebview) => void;
  private dispose?: () => void;
  readonly provider: ChatViewProvider;

  constructor(context: ReturnType<typeof fakeContext>) {
    const ctx = context as never;
    this.provider = new ChatViewProvider(ctx, new SecretKeyStore(ctx), (ui) => new WebviewApproval(ui, new ProposedContentProvider()));
    this.provider.resolveWebviewView({
      visible: true,
      show: () => undefined,
      onDidDispose: (fn: () => void) => void (this.dispose = fn),
      webview: {
        options: {},
        html: "",
        cspSource: "vscode-resource:",
        asWebviewUri: (u: Uri) => u,
        postMessage: async (m: ToWebview) => void this.posted.push(structuredClone(m)),
        onDidReceiveMessage: (fn: (m: FromWebview) => void) => void (this.receive = fn),
      },
    } as never);
  }

  send(msg: FromWebview): void {
    this.receive!(msg);
  }

  /** Simulates closing the window: the webview goes away. */
  close(): void {
    this.dispose?.();
  }

  async waitFor<T extends ToWebview>(match: (m: ToWebview) => m is T, from = 0, timeout = 15_000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const found = this.posted.slice(from).find(match);
      if (found) return found;
      if (Date.now() - start > timeout) throw new Error(`timed out; posted: ${JSON.stringify(this.posted.map((m) => m.type))}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Sends a task and answers approvals with `decide` until the agent is done. */
  async task(text: string, decide: (m: Extract<ToWebview, { type: "approval_request" }>) => "allow" | "deny" = () => "allow"): Promise<ToWebview[]> {
    const from = this.posted.length;
    this.send({ type: "send", text });
    const answered = new Set<string>();
    const start = Date.now();
    for (;;) {
      const fresh = this.posted.slice(from);
      for (const m of fresh) {
        if (m.type === "approval_request" && !answered.has(m.id)) {
          answered.add(m.id);
          this.send({ type: "approval_response", id: m.id, decision: decide(m) });
        }
      }
      if (fresh.some((m) => m.type === "busy" && !m.busy)) return fresh;
      if (Date.now() - start > 20_000) throw new Error(`task timed out; posted: ${JSON.stringify(fresh.map((m) => m.type))}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

const isType =
  <K extends ToWebview["type"]>(type: K) =>
  (m: ToWebview): m is Extract<ToWebview, { type: K }> =>
    m.type === type;

/** Polls a condition: background saves take longer on a busy machine (CI). */
async function eventually(check: () => boolean, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

let root: string;
let storage: string;
let server: FakeServer | undefined;
let context: ReturnType<typeof fakeContext>;

async function setup(script: Parameters<typeof startFakeServer>[0], approvalMode: "ask" | "auto" = "ask"): Promise<Panel> {
  server = await startFakeServer(script);
  stub.config = { "dimosi.provider": "custom", "dimosi.customBaseUrl": server.url, "dimosi.model": "fake-model", "dimosi.approvalMode": approvalMode };
  await context.secrets.store("dimosi.key.custom", KEY);
  const panel = new Panel(context);
  panel.send({ type: "ready" });
  await panel.waitFor(isType("status"));
  return panel;
}

beforeEach(() => {
  stub.reset();
  root = mkdtempSync(path.join(os.tmpdir(), "dimosi-e2e-root-"));
  storage = mkdtempSync(path.join(os.tmpdir(), "dimosi-e2e-storage-"));
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: "p", index: 0 }];
  context = fakeContext(storage);
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("VS Code chat, end to end", () => {
  it("task → approve the write → revert", async () => {
    const panel = await setup([
      { text: "Создаю файл.", toolCalls: [{ name: "write_file", args: { path: "hello.txt", content: "Привет\n" } }] },
      { text: "Готово." },
    ]);
    const events = await panel.task("создай hello.txt");

    const request = events.find(isType("approval_request"))!;
    expect(request).toMatchObject({ kind: "write", relPath: "hello.txt", created: true });
    expect(events).toContainEqual({ type: "approval_resolved", id: request.id, decision: "allow" });
    expect(await fs.readFile(path.join(root, "hello.txt"), "utf8")).toBe("Привет\n");
    expect(events.filter(isType("text")).map((e) => e.text).join("")).toBe("Создаю файл.Готово.");
    const changes = events.find(isType("changes"))!;
    expect(changes.files).toEqual([{ relPath: "hello.txt", added: 1, removed: 0, created: true, reverted: false, unavailable: false }]);
    // The key went to the server and nowhere else.
    expect(server!.requests[0].auth).toBe(`Bearer ${KEY}`);

    const from = panel.posted.length;
    panel.send({ type: "revert", turn: changes.turn, relPath: "hello.txt" });
    const after = await panel.waitFor(isType("changes"), from);
    expect(after.files[0].reverted).toBe(true);
    expect(existsSync(path.join(root, "hello.txt"))).toBe(false);
    expect(log.recent().join("\n")).not.toContain(KEY);
  });

  it("Stop during a running command ends it quickly", async () => {
    const panel = await setup([{ toolCalls: [{ name: "run_command", args: { command: "sleep 30" } }] }], "auto");
    const from = panel.posted.length;
    panel.send({ type: "send", text: "запусти долгую команду" });
    await panel.waitFor((m): m is ToWebview => m.type === "tool_start" && m.name === "run_command", from);
    await new Promise((r) => setTimeout(r, 300)); // let the command start
    const stoppedAt = Date.now();
    panel.send({ type: "stop" });
    await panel.waitFor((m): m is ToWebview => m.type === "busy" && !m.busy, from);
    expect(Date.now() - stoppedAt).toBeLessThan(8000);
    const fresh = panel.posted.slice(from);
    expect(fresh.find(isType("tool_end"))?.result).toMatch(/Cancelled by the user/);
    expect(fresh).toContainEqual({ type: "error", message: "Остановлено." });
  }, 20_000);

  it.runIf(process.platform === "darwin")("commands run in the sandbox unless the setting turns it off", async () => {
    const probe = path.join(os.homedir(), `dimosi-e2e-sandbox-probe-${process.pid}-${Date.now()}.txt`);
    const command = `echo x > "${probe}"`;
    try {
      // The fake server takes replies from this array as they are asked for.
      const script: Parameters<typeof startFakeServer>[0] = [{ toolCalls: [{ name: "run_command", args: { command } }] }, { text: "ok" }];
      const panel = await setup(script, "auto");
      let from = panel.posted.length;
      panel.send({ type: "send", text: "запиши файл" });
      expect((await panel.waitFor(isType("tool_end"), from)).result).toMatch(/sandbox/);
      expect(existsSync(probe)).toBe(false);
      await panel.waitFor((m): m is ToWebview => m.type === "busy" && !m.busy, from);

      script.push({ toolCalls: [{ name: "run_command", args: { command } }] }, { text: "ok" });
      stub.config["dimosi.sandbox"] = false;
      from = panel.posted.length;
      panel.send({ type: "send", text: "ещё раз" });
      expect((await panel.waitFor(isType("tool_end"), from)).result).toContain("Exit code: 0");
      expect(existsSync(probe)).toBe(true);
    } finally {
      await fs.rm(probe, { force: true });
    }
  }, 20_000);

  it("a 429 from the service is retried and the task finishes", async () => {
    const panel = await setup([{ status: 429, error: "Rate limit reached" }, { text: "Ответ после повтора." }]);
    const events = await panel.task("привет");
    expect(server!.requests).toHaveLength(2);
    expect(events.filter(isType("text")).map((e) => e.text).join("")).toBe("Ответ после повтора.");
    expect(events.some(isType("error"))).toBe(false);
  });

  it("context overflow: old tool output is dropped and the request is repeated", async () => {
    await fs.writeFile(path.join(root, "big.txt"), "строка данных\n".repeat(3000));
    const panel = await setup([
      { toolCalls: [{ name: "read_file", args: { path: "big.txt" } }] },
      { text: "Прочитал." },
      // The next request still carries the big file: the "model" says it is too long.
      (body) => (sentText(body).includes("строка данных") ? { status: 400, error: "This model's maximum context length is 8000 tokens" } : { text: "Всё ещё здесь." }),
      { text: "Всё ещё здесь." },
    ]);
    await panel.task("прочитай big.txt");
    const events = await panel.task("что дальше?");
    expect(events.filter(isType("text")).map((e) => e.text).join("")).toBe("Всё ещё здесь.");
    expect(events.some(isType("error"))).toBe(false);
    const last = server!.requests.at(-1)!.body;
    expect(sentText(last)).not.toContain("строка данных");
    expect(sentText(last)).toContain("Output removed to free context space");
  });

  it("the chat survives a window reload and the conversation goes on", async () => {
    const panel = await setup([
      { text: "План готов.", toolCalls: [{ name: "update_plan", args: { items: [{ title: "Создать файл", status: "done" }] } }, { name: "write_file", args: { path: "a.txt", content: "A\n" } }] },
      { text: "Файл создан." },
      { text: "Помню: мы создали a.txt." },
    ]);
    await panel.task("создай a.txt");
    // Wait for the background save, then "reload": a fresh provider and webview on the same storage.
    const saved = () => {
      try {
        const text = readFileSync(path.join(storage, "chat.json"), "utf8");
        return text.includes('"interrupted":false') && text.includes("Файл создан.");
      } catch {
        return false;
      }
    };
    expect(await eventually(saved)).toBe(true);
    panel.close();

    const reloaded = new Panel(context);
    reloaded.send({ type: "ready" });
    const restore = await reloaded.waitFor(isType("restore"));
    const types = restore.items.map((m) => m.type);
    expect(types).toEqual(expect.arrayContaining(["user", "plan", "text", "approval_request", "approval_resolved", "changes"]));
    expect(restore.items.find(isType("user"))?.text).toBe("создай a.txt");
    const changes = restore.items.find(isType("changes"))!;
    expect(changes.files[0]).toMatchObject({ relPath: "a.txt", reverted: false, unavailable: false });

    // Continue the conversation: the model gets the earlier history.
    const events = await reloaded.task("что мы сделали?");
    expect(events.filter(isType("text")).map((e) => e.text).join("")).toBe("Помню: мы создали a.txt.");
    const history = sentText(server!.requests.at(-1)!.body);
    expect(history).toContain("создай a.txt");
    expect(history).toContain("Файл создан.");

    // Revert still works after the reload.
    const from = reloaded.posted.length;
    reloaded.send({ type: "revert", turn: changes.turn, relPath: "a.txt" });
    expect((await reloaded.waitFor(isType("changes"), from)).files[0].reverted).toBe(true);
    expect(existsSync(path.join(root, "a.txt"))).toBe(false);

    // "New chat" forgets the saved chat.
    reloaded.provider.newChat();
    expect(await eventually(() => !existsSync(path.join(storage, "chat.json")))).toBe(true);
  });
});

describe("messages from the panel are checked", () => {
  it("only the panel's own commands run, and without arguments", async () => {
    const panel = await setup([]);
    for (const command of ["dimosi.selectModel", "dimosi.toggleApproval", "dimosi.importKeys", "dimosi.showRules", "dimosi.setApiKey", "workbench.action.files.openFolder"]) {
      panel.send({ type: "command", command });
    }
    panel.send({ type: "command", command: "dimosi.fixDiagnostic", args: [Uri.file("/etc/hosts")] } as never);
    panel.send({ type: "command", command: "dimosi.selectModel", args: ["x"] } as never);
    panel.send({ type: "command", command: "workbench.action.terminal.sendSequence", args: [{ text: "rm -rf ~\n" }] } as never);
    expect(await eventually(() => stub.executed.length >= 6)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(stub.executed).toEqual(
      ["dimosi.selectModel", "dimosi.toggleApproval", "dimosi.importKeys", "dimosi.showRules", "dimosi.setApiKey", "workbench.action.files.openFolder"].map((id) => ({ id, args: [] })),
    );
  });

  it("files are opened and attached only from inside the project", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "dimosi-e2e-outside-"));
    await fs.writeFile(path.join(outside, "private.txt"), "PRIVATE");
    await fs.symlink(outside, path.join(root, "link"));
    await fs.writeFile(path.join(root, "ok.txt"), "ok");
    const panel = await setup([]);
    panel.send({ type: "open_path", path: path.join(outside, "private.txt") } as never);
    panel.send({ type: "open_file", relPath: "../" + path.basename(outside) + "/private.txt" });
    panel.send({ type: "open_file", relPath: "link/private.txt" });
    panel.send({ type: "attach_path", relPath: "link/private.txt" });
    panel.send({ type: "attach_path", relPath: "../" + path.basename(outside) + "/private.txt" });
    panel.send({ type: "open_file", relPath: "ok.txt" });
    expect(await eventually(() => stub.opened.length > 0)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(stub.opened).toEqual([path.join(root, "ok.txt")]);
    expect(JSON.stringify(panel.posted.filter(isType("attachments")))).not.toContain("private");
  });

  it("an unknown approval decision counts as «no»", async () => {
    const panel = await setup([
      { toolCalls: [{ name: "write_file", args: { path: "a.txt", content: "x" } }] },
      { text: "Понял." },
    ]);
    await panel.task("создай a.txt", () => "allow_everything" as never);
    expect(existsSync(path.join(root, "a.txt"))).toBe(false);
    expect(JSON.stringify(server!.requests[1].body.messages)).toContain("The user rejected this change.");
  });
});

describe("approval cards", () => {
  it("show hidden characters as visible marks", async () => {
    const posted: ToWebview[] = [];
    const approval = new WebviewApproval({ post: (m: ToWebview) => void posted.push(m), reveal: () => undefined } as never, new ProposedContentProvider());
    void approval.approve({ kind: "command", command: "echo ok\u202E", cwd: root, warning: "w" });
    void approval.approve({ kind: "write", path: path.join(root, "a\u200B.ts"), relPath: "a\u200B.ts", oldContent: null, newContent: "x\u2066y\n", warning: "w" });
    const [cmd, write] = posted as Array<Extract<ToWebview, { type: "approval_request" }>>;
    expect(cmd.kind === "command" && cmd.command).toBe("echo ok⟦U+202E⟧");
    expect(write.kind === "write" && write.relPath).toBe("a⟦U+200B⟧.ts");
    expect(JSON.stringify(write)).toContain("x⟦U+2066⟧y");
    approval.cancelAll();
  });
});

describe("files with secrets in the panel", () => {
  it("are not offered by the «+ файл» chip or in the @ list, and are not attached", async () => {
    const findFiles = workspace.findFiles;
    try {
      await fs.writeFile(path.join(root, ".env"), "API_KEY=sk-very-secret\n");
      await fs.writeFile(path.join(root, "app.ts"), "x");
      workspace.findFiles = async () => [Uri.file(path.join(root, ".env")), Uri.file(path.join(root, "app.ts")), Uri.file(path.join(root, "certs/env.pem"))];
      window.activeTextEditor = { document: { uri: Uri.file(path.join(root, ".env")) } };
      const panel = await setup([]);
      expect(panel.posted.filter(isType("active_file")).at(-1)?.label).toBeNull();
      panel.send({ type: "mention_query", query: "" });
      expect((await panel.waitFor(isType("mentions"))).items).toEqual(["app.ts"]);
      panel.send({ type: "attach_path", relPath: ".env" });
      expect((await panel.waitFor(isType("error"))).message).toMatch(/\.env не прикреплён/);
    } finally {
      workspace.findFiles = findFiles;
      window.activeTextEditor = undefined;
    }
  });
});

describe("extension start and problem report", () => {
  it("starts with a journal, and the report carries versions and the journal but no key", async () => {
    const { activate } = await import("../../src/extension");
    await context.secrets.store("dimosi.key.polza", KEY);
    context.globalState.update("dimosi.keyNames", ["polza"]);
    context.globalState.update("dimosi.welcomed", true);
    stub.config = { "dimosi.provider": "polza", "dimosi.model": "anthropic/claude-opus-5.5" };
    activate(context as never);
    expect(stub.output[0]).toMatch(/^\[info\] dimosi 0\.0\.0-test started: VS Code 1\.140\.0/);
    expect(stub.output[1]).toBe("[info] settings: provider polza, model anthropic/claude-opus-5.5, approvals ask, max steps 50, extra folders 0");

    log.error(`task failed: Неверный API-ключ (401). (${KEY})`);
    stub.answer = (_msg, items) => items.find((i) => i.startsWith("Скопировать"));
    const { env } = await import("./vscode");
    await stub.commands.get("dimosi.reportProblem")!();
    expect(env.clipboard.text).toContain("# Отчёт о проблеме dimosi");
    expect(env.clipboard.text).toContain("- dimosi: 0.0.0-test");
    expect(env.clipboard.text).toContain("- Сохранены ключи для: polza");
    expect(env.clipboard.text).toMatch(/## Последняя ошибка\n\S+ \[error\] task failed: Неверный API-ключ/);
    expect(env.clipboard.text).not.toContain(KEY);
    expect(stub.output.join("\n")).not.toContain(KEY);
    for (const d of context.subscriptions) d.dispose();
  });

  it("project rules created from the template are trusted without asking", async () => {
    const { activate } = await import("../../src/extension");
    const { trustDecisions } = await import("../../src/ruleTrust");
    const { loadRules, rememberingTrust } = await import("@dimosi/core");
    context.globalState.update("dimosi.welcomed", true);
    activate(context as never);
    await stub.commands.get("dimosi.createProjectRules")!();
    expect(stub.opened).toEqual([path.join(root, ".dimosi/rules.md")]);
    const rules = await loadRules(root, path.join(root, "none.md"), rememberingTrust(trustDecisions(context as never)));
    expect(rules.sources.map((s) => [s.label, s.skipped])).toEqual([[".dimosi/rules.md", undefined]]);
    for (const d of context.subscriptions) d.dispose();
  });
});

describe("extra folders", () => {
  let extra: string;

  beforeEach(async () => {
    extra = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dimosi-e2e-extra-")));
    await fs.writeFile(path.join(extra, "notes.md"), "old\n");
  });

  it("the panel shows what is opened; the agent changes a file there and the change can be reverted", async () => {
    const file = path.join(extra, "notes.md");
    const panel = await setup([
      { toolCalls: [{ name: "edit_file", args: { path: file, old_string: "old", new_string: "new" } }] },
      { text: "Готово." },
    ]);
    stub.config["dimosi.extraFolders"] = [{ path: extra, access: "write" }];
    await panel.provider.postStatus();
    expect(panel.posted.filter(isType("status")).at(-1)).toMatchObject({ access: "проект + 1 папка", accessDetail: expect.stringContaining(`${extra} — чтение и запись`) });

    const events = await panel.task("поправь заметки");
    expect(events.find(isType("approval_request"))).toMatchObject({ kind: "write", relPath: file });
    expect(await fs.readFile(file, "utf8")).toBe("new\n");
    // The model was told about the folder.
    expect(JSON.stringify(server!.requests[0].body.messages[0].content)).toContain(`${extra} (read and write)`);

    panel.send({ type: "open_file", relPath: file });
    expect(await eventually(() => stub.opened.includes(file))).toBe(true);

    const changes = events.find(isType("changes"))!;
    const from = panel.posted.length;
    panel.send({ type: "revert", turn: changes.turn, relPath: file });
    expect((await panel.waitFor(isType("changes"), from)).files[0].reverted).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("old\n");
  });

  it("a folder opened for reading is not changed, and one that is not opened is not reached", async () => {
    const closed = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dimosi-e2e-closed-")));
    await fs.writeFile(path.join(closed, "a.txt"), "closed\n");
    const panel = await setup([
      {
        toolCalls: [
          { name: "read_file", args: { path: path.join(extra, "notes.md") } },
          { name: "write_file", args: { path: path.join(extra, "notes.md"), content: "x" } },
          { name: "read_file", args: { path: path.join(closed, "a.txt") } },
        ],
      },
      { text: "Готово." },
    ]);
    stub.config["dimosi.extraFolders"] = [{ path: extra, access: "read" }];
    const results = (await panel.task("прочитай")).filter(isType("tool_end"));
    expect(results.map((r) => r.isError)).toEqual([false, true, true]);
    expect(results[1].result).toMatch(/reading only/);
    expect(results[2].result).toMatch(/outside the project root/);
    expect(await fs.readFile(path.join(extra, "notes.md"), "utf8")).toBe("old\n");

    panel.send({ type: "open_file", relPath: path.join(closed, "a.txt") });
    panel.send({ type: "open_file", relPath: path.join(extra, "notes.md") });
    expect(await eventually(() => stub.opened.length > 0)).toBe(true);
    expect(stub.opened).toEqual([path.join(extra, "notes.md")]);
  });

  it("the Change button adds a folder, changes its access and removes it", async () => {
    const { editAccess } = await import("../../src/access");
    const answers = (...labels: Array<string | RegExp>) => {
      stub.pick = (items) => {
        const want = labels.shift();
        return want === undefined ? undefined : items.find((i) => (typeof want === "string" ? i.label === want : want.test(i.label)));
      };
    };

    stub.openDialog = () => [Uri.file(extra)];
    answers(/Открыть агенту ещё одну папку/, "Только чтение");
    await editAccess(root);
    expect(stub.config["dimosi.extraFolders"]).toEqual([{ path: extra, access: "read" }]);

    // The same folder is not added twice.
    answers(/Открыть агенту ещё одну папку/);
    await editAccess(root);
    expect(stub.messages.at(-1)).toMatch(/уже есть в списке/);

    answers(new RegExp(path.basename(extra)), "Разрешить запись");
    await editAccess(root);
    expect(stub.config["dimosi.extraFolders"]).toEqual([{ path: extra, access: "write" }]);

    answers(new RegExp(path.basename(extra)), "Убрать из списка");
    await editAccess(root);
    expect(stub.config["dimosi.extraFolders"]).toEqual([]);
  });

  it("the Change button refuses the whole home folder and folders with keys", async () => {
    const { editAccess } = await import("../../src/access");
    const pickAdd = () => {
      let asked = false;
      stub.pick = (items) => (asked ? undefined : ((asked = true), items.find((i) => i.label.includes("ещё одну папку"))));
    };
    stub.openDialog = () => [Uri.file(os.homedir())];
    pickAdd();
    await editAccess(root);
    expect(stub.messages.at(-1)).toMatch(/слишком широко/);
    stub.openDialog = () => [Uri.file(path.join(os.homedir(), ".ssh"))];
    pickAdd();
    await editAccess(root);
    expect(stub.messages.at(-1)).toMatch(/закрытая папка|не найдена/);
    expect(stub.config["dimosi.extraFolders"]).toBeUndefined();
  });
});

describe("«Always» for a command", () => {
  const always = () => "allow_always" as never;

  it("is remembered by the beginning of the command, survives a window reload, and can be taken back", async () => {
    const script: Parameters<typeof startFakeServer>[0] = [
      { toolCalls: [{ name: "run_command", args: { command: "echo hello one" } }] },
      { text: "Готово." },
      { toolCalls: [{ name: "run_command", args: { command: "echo hello two" } }, { name: "run_command", args: { command: "echo hello three && echo more" } }] },
      { text: "Готово." },
      { toolCalls: [{ name: "run_command", args: { command: "echo hello four" } }] },
      { text: "Готово." },
    ];
    let panel = await setup(script);
    const first = await panel.task("скажи привет", always);
    expect(first.find(isType("approval_request"))).toMatchObject({ kind: "command", always: { kind: "prefix", text: "echo hello" } });
    // Kept in VS Code's storage, not in the project.
    expect(existsSync(path.join(root, ".dimosi"))).toBe(false);
    expect(JSON.stringify(context.globalState.get("dimosi.commandRules"))).toContain("echo hello");

    // The window is reloaded: a new panel, the same storage.
    panel.close();
    panel = new Panel(context);
    panel.send({ type: "ready" });
    await panel.waitFor(isType("status"));
    const second = await panel.task("ещё раз");
    // Only the chained command is asked about.
    expect(second.filter(isType("approval_request")).map((r) => r.kind === "command" && r.command)).toEqual(["echo hello three && echo more"]);
    expect(second.filter(isType("tool_end")).map((r) => r.isError)).toEqual([false, false]);

    // The user takes the permission back.
    const { showCommandRules } = await import("../../src/commandRules");
    let picked = false;
    stub.pick = (items) => (picked ? undefined : ((picked = true), items.find((i) => i.label.includes("echo hello"))));
    stub.answer = (_msg, items) => items.find((i) => i === "Забыть");
    await showCommandRules(context as never, root);
    expect(stub.messages.some((m) => m.includes("начинаются с «echo hello»"))).toBe(true);
    const third = await panel.task("и ещё");
    expect(third.filter(isType("approval_request"))).toHaveLength(1);
  }, 30_000);

  it("the list of remembered commands opens from the panel, and says so when it is empty", async () => {
    const { activate } = await import("../../src/extension");
    context.globalState.update("dimosi.welcomed", true);
    activate(context as never);
    const panel = await setup([]);
    panel.send({ type: "command", command: "dimosi.showCommandRules" });
    expect(await eventually(() => stub.messages.some((m) => m.includes("нет запомненных команд")))).toBe(true);
    for (const d of context.subscriptions) d.dispose();
  });
});
