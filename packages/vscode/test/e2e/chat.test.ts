// End-to-end: the real chat panel logic (ChatViewProvider, agent, tools,
// OpenAI SDK) against a fake VS Code API and a fake model server over HTTP.
import { existsSync, mkdtempSync, promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProposedContentProvider, WebviewApproval } from "../../src/approval";
import { ChatViewProvider } from "../../src/chatView";
import { SecretKeyStore } from "../../src/keyStore";
import { log } from "../../src/log";
import type { FromWebview, ToWebview } from "../../src/protocol";
import { sentText, startFakeServer, type FakeServer } from "./fakeServer";
import { stub, Uri, workspace } from "./vscode";

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

describe("extension start and problem report", () => {
  it("starts with a journal, and the report carries versions and the journal but no key", async () => {
    const { activate } = await import("../../src/extension");
    await context.secrets.store("dimosi.key.polza", KEY);
    context.globalState.update("dimosi.keyNames", ["polza"]);
    context.globalState.update("dimosi.welcomed", true);
    stub.config = { "dimosi.provider": "polza", "dimosi.model": "anthropic/claude-opus-5.5" };
    activate(context as never);
    expect(stub.output[0]).toMatch(/^\[info\] dimosi 0\.0\.0-test started: VS Code 1\.140\.0/);
    expect(stub.output[1]).toBe("[info] settings: provider polza, model anthropic/claude-opus-5.5, approvals ask, max steps 50");

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
});
