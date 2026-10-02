import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Agent, Log, SECRET_MASK, type AgentEvent, type ChatRequest, type Provider, type StreamEvent } from "../src";

const KEY = "pz-live-7f3a9c2e1b8d4f6a0c5e";
const USER_TEXT = "мой секретный план захвата мира";
const FILE_TEXT = "PASSWORD=hunter2-in-a-file";

class FakeProvider implements Provider {
  readonly id = "polza";
  constructor(private turns: Array<(req: ChatRequest) => StreamEvent[]>) {}
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const turn = this.turns.shift();
    if (!turn) throw new Error("no more scripted turns");
    for (const ev of turn(req)) yield ev;
  }
  async listModels() {
    return [];
  }
}

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

async function collect(gen: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("Log", () => {
  it("masks known keys and anything that looks like one", () => {
    const log = new Log();
    log.addSecret(KEY);
    log.error(`401 Incorrect API key provided: ${KEY}`);
    log.warn("Authorization: Bearer abcdefghijklmnop1234 was rejected");
    log.info("OpenAI said: Incorrect API key sk-proj-AbCdEf0123456789xyz");
    log.info('{"api_key": "qwertyuiop12345"}');
    const text = log.recent().join("\n");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("abcdefghijklmnop1234");
    expect(text).not.toContain("sk-proj-AbCdEf0123456789xyz");
    expect(text).not.toContain("qwertyuiop12345");
    expect(text.split(SECRET_MASK).length - 1).toBe(4);
    expect(log.lastError).toContain("[error] 401 Incorrect API key provided");
  });

  it("keeps only the latest lines and survives a broken sink", () => {
    const log = new Log(() => {
      throw new Error("disk full");
    }, 3);
    for (let i = 1; i <= 5; i++) log.info(`line ${i}`);
    expect(log.recent().map((l) => l.replace(/^\S+ /, ""))).toEqual(["[info] line 3", "[info] line 4", "[info] line 5"]);
  });
});

describe("agent journal", () => {
  it("records requests, retries and tools, but never the key, the chat or file contents", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dimosi-log-"));
    const lines: string[] = [];
    const log = new Log((level, msg) => lines.push(`${level} ${msg}`));
    log.addSecret(KEY);
    const provider = new FakeProvider([
      () => {
        throw httpError(429, `Rate limit for key ${KEY}`);
      },
      () => [
        {
          type: "done",
          stopReason: "tool_use",
          usage: { inputTokens: 1200, outputTokens: 40 },
          message: {
            role: "assistant",
            parts: [
              { type: "tool_call", id: "c1", name: "write_file", input: { path: "secret.env", content: FILE_TEXT } },
              { type: "tool_call", id: "c2", name: "read_file", input: { path: "missing.txt" } },
            ],
          },
        },
      ],
      () => [
        {
          type: "done",
          stopReason: "end_turn",
          usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 50 },
          message: { role: "assistant", parts: [{ type: "text", text: "Готово" }] },
        },
      ],
    ]);
    const agent = new Agent({
      provider,
      model: "anthropic/claude-opus-5.5",
      root,
      approval: { approve: async () => "allow" },
      globalRulesPath: path.join(root, "none.md"),
      log,
    });
    // Speed up the retry pause for the test.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout;
    try {
      await collect(agent.run(USER_TEXT));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    const text = lines.join("\n");
    expect(text).toMatch(/warn request polza\/anthropic\/claude-opus-5\.5 \(1 messages, ≈\d+ tok\): failed in [\d.]+s with 429 .*retrying in 2s/);
    expect(text).toMatch(/info request polza\/.*attempt 2\): ok in [\d.]+s, stop tool_use, in 1200 out 40/);
    expect(text).toMatch(/stop end_turn, in 1000 \(cache read 900, write 50, hit 90%\) out 5/);
    expect(text).toMatch(/info tool write_file: ok in \d+ ms/);
    expect(text).toMatch(/warn tool read_file: failed in \d+ ms — ENOENT/);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(USER_TEXT);
    expect(text).not.toContain(FILE_TEXT);
    expect(text).not.toContain("Готово");
  });

  it("records context trimming and the final error", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dimosi-log-"));
    const log = new Log();
    const provider = new FakeProvider([
      () => {
        throw httpError(400, "prompt is too long: 250000 tokens > 200000 maximum");
      },
    ]);
    const agent = new Agent({ provider, model: "m", root, approval: { approve: async () => "allow" }, globalRulesPath: path.join(root, "none.md"), log });
    agent.messages = [
      { role: "assistant", parts: [{ type: "tool_call", id: "t", name: "read_file", input: {} }] },
      { role: "user", parts: [{ type: "tool_result", toolCallId: "t", content: "x".repeat(60_000) }] },
    ];
    agent.contextWindow = 20_000;
    await collect(agent.run("дальше"));
    const text = log.recent().join("\n");
    expect(text).toMatch(/context trimmed: ≈\d+ → ≈\d+ tok \(window 20000\)/);
    expect(text).toMatch(/\[error\] task failed: Разговор стал слишком длинным/);
  });
});
