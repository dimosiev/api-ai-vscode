import { mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type ChatRequest, type Message, type Provider, type StreamEvent } from "../src";

/** Replays scripted assistant turns and records what it was sent. */
class FakeProvider implements Provider {
  readonly id = "fake";
  requests: Message[][] = [];
  constructor(private turns: Array<(req: ChatRequest) => StreamEvent[] | Promise<StreamEvent[]>>) {}
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone(req.messages));
    const turn = this.turns.shift();
    if (!turn) throw new Error("no more scripted turns");
    for (const ev of await turn(req)) yield ev;
  }
  async listModels() {
    return ["fake-model"];
  }
}

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "dimosi-agent-"));
const NO_GLOBAL = path.join(os.tmpdir(), "dimosi-no-global-rules.md");

async function collect(gen: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("Agent", () => {
  it("runs tool calls and feeds results back until the model stops", async () => {
    const root = tmp();
    const provider = new FakeProvider([
      () => [
        { type: "text_delta", text: "Creating the file." },
        {
          type: "done",
          stopReason: "tool_use",
          message: {
            role: "assistant",
            parts: [
              { type: "text", text: "Creating the file." },
              { type: "tool_call", id: "c1", name: "write_file", input: { path: "hello.txt", content: "hi" } },
            ],
          },
        },
      ],
      () => [
        { type: "text_delta", text: "Done." },
        { type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [{ type: "text", text: "Done." }] } },
      ],
    ]);
    const agent = new Agent({ provider, model: "m", root, approval: { approve: async () => "allow" }, globalRulesPath: NO_GLOBAL });
    const events = await collect(agent.run("make hello.txt"));

    expect(await fs.readFile(path.join(root, "hello.txt"), "utf8")).toBe("hi");
    expect(events.map((e) => e.type)).toEqual(["rules", "text", "tool_start", "file_changed", "tool_end", "text", "done"]);
    expect(events.find((e) => e.type === "file_changed")).toMatchObject({
      change: { relPath: "hello.txt", oldContent: null, newContent: "hi" },
    });
    const second = provider.requests[1];
    expect(second.at(-1)).toEqual({
      role: "user",
      parts: [{ type: "tool_result", toolCallId: "c1", content: "Created hello.txt (1 lines).", isError: false }],
    });
  });

  it("answers every tool call when stopped mid-turn, so the next request stays valid", async () => {
    const root = tmp();
    const controller = new AbortController();
    const provider = new FakeProvider([
      () => [
        {
          type: "done",
          stopReason: "tool_use",
          message: {
            role: "assistant",
            parts: [
              { type: "tool_call", id: "a", name: "write_file", input: { path: "x.txt", content: "1" } },
              { type: "tool_call", id: "b", name: "write_file", input: { path: "y.txt", content: "2" } },
            ],
          },
        },
      ],
      () => [{ type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [{ type: "text", text: "ok" }] } }],
    ]);
    const agent = new Agent({
      provider,
      model: "m",
      root,
      globalRulesPath: NO_GLOBAL,
      approval: {
        approve: async () => {
          controller.abort(); // user presses Stop while being asked
          return "deny";
        },
      },
    });
    const events = await collect(agent.run("go", controller.signal));
    expect(events.at(-1)).toEqual({ type: "error", message: "Остановлено." });

    const results = agent.messages.at(-1)!;
    expect(results.role).toBe("user");
    expect(results.parts.map((p) => (p.type === "tool_result" ? p.toolCallId : null))).toEqual(["a", "b"]);

    // Next message is merged into the same user turn instead of creating two in a row.
    await collect(agent.run("continue"));
    const sent = provider.requests[1];
    expect(sent.filter((m) => m.role === "user")).toHaveLength(2);
    expect(sent.at(-1)!.parts.at(-1)).toEqual({ type: "text", text: "continue" });
  });

  it("reports provider errors with a readable message", async () => {
    const provider = new FakeProvider([
      () => {
        throw Object.assign(new Error("bad key"), { status: 401 });
      },
    ]);
    const agent = new Agent({ provider, model: "m", root: tmp(), approval: { approve: async () => "allow" }, globalRulesPath: NO_GLOBAL });
    const events = await collect(agent.run("hi"));
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect((events.at(-1) as { message: string }).message).toMatch(/Неверный API-ключ/);
  });

  it("reads global and project rules on every message and puts them in the system prompt", async () => {
    const root = tmp();
    const globalRules = path.join(tmp(), "rules.md");
    await fs.writeFile(globalRules, "Всегда отвечай по-русски.");
    await fs.writeFile(path.join(root, "AGENTS.md"), "Use tabs.");
    const systems: string[] = [];
    const reply = (req: ChatRequest): StreamEvent[] => {
      systems.push(req.system);
      return [{ type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [{ type: "text", text: "ok" }] } }];
    };
    const provider = new FakeProvider([reply, reply]);
    const agent = new Agent({ provider, model: "m", root, approval: { approve: async () => "allow" }, globalRulesPath: globalRules });

    const first = await collect(agent.run("hi"));
    expect(first[0]).toMatchObject({ type: "rules", sources: [{ scope: "global" }, { label: "AGENTS.md" }] });
    expect(systems[0]).toContain("Всегда отвечай по-русски.");
    expect(systems[0]).toContain("Use tabs.");
    expect(systems[0].indexOf("Всегда отвечай")).toBeLessThan(systems[0].indexOf("Use tabs."));

    // Editing a rule takes effect on the next message, without a new chat.
    await fs.mkdir(path.join(root, ".dimosi"));
    await fs.writeFile(path.join(root, ".dimosi/rules.md"), "Never touch legacy/.");
    await collect(agent.run("again"));
    expect(systems[1]).toContain("Never touch legacy/.");
  });

  it("emits plan updates from the update_plan tool", async () => {
    const provider = new FakeProvider([
      () => [
        {
          type: "done",
          stopReason: "tool_use",
          message: {
            role: "assistant",
            parts: [
              {
                type: "tool_call",
                id: "p1",
                name: "update_plan",
                input: { items: [{ title: "Прочитать код", status: "done" }, { title: "Исправить", status: "in_progress" }] },
              },
            ],
          },
        },
      ],
      () => [{ type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [{ type: "text", text: "ok" }] } }],
    ]);
    const agent = new Agent({ provider, model: "m", root: tmp(), approval: { approve: async () => "deny" }, globalRulesPath: NO_GLOBAL });
    const events = await collect(agent.run("fix it"));
    expect(events.find((e) => e.type === "plan")).toEqual({
      type: "plan",
      items: [
        { title: "Прочитать код", status: "done" },
        { title: "Исправить", status: "in_progress" },
      ],
    });
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ result: "Plan updated (1/2 done).", isError: false });
  });

  it("sends attached images along with the text", async () => {
    const provider = new FakeProvider([
      () => [{ type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [{ type: "text", text: "ok" }] } }],
    ]);
    const agent = new Agent({ provider, model: "m", root: tmp(), approval: { approve: async () => "allow" }, globalRulesPath: NO_GLOBAL });
    await collect(agent.run([{ type: "text", text: "что на картинке?" }, { type: "image", mediaType: "image/png", data: "AAAA" }]));
    expect(provider.requests[0][0].parts).toEqual([
      { type: "text", text: "что на картинке?" },
      { type: "image", mediaType: "image/png", data: "AAAA" },
    ]);
  });
});

describe("plan first", () => {
  it("keeps the system prompt and the tools the same, tells the model in the user's message, and refuses changes", async () => {
    const root = tmp();
    const sent: ChatRequest[] = [];
    const text = (t: string): StreamEvent[] => [{ type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [{ type: "text", text: t }] } }];
    const provider = new FakeProvider([
      () => text("Привет."),
      () => [
        {
          type: "done",
          stopReason: "tool_use",
          message: { role: "assistant", parts: [{ type: "tool_call", id: "w1", name: "write_file", input: { path: "a.txt", content: "x" } }] },
        },
      ],
      () => text("Вот план."),
      () => [
        {
          type: "done",
          stopReason: "tool_use",
          message: { role: "assistant", parts: [{ type: "tool_call", id: "w2", name: "write_file", input: { path: "a.txt", content: "x" } }] },
        },
      ],
      () => text("Готово."),
    ]);
    const stream = provider.stream.bind(provider);
    provider.stream = (req) => (sent.push(structuredClone({ ...req, signal: undefined })), stream(req));
    let asked = 0;
    const agent = new Agent({ provider, model: "m", root, approval: { approve: async () => (asked++, "allow") }, globalRulesPath: NO_GLOBAL });

    await collect(agent.run("привет"));
    agent.planFirst = true;
    const planning = await collect(agent.run("добавь файл"));
    agent.planFirst = false;
    await collect(agent.run("Выполняй план."));

    // The start of every request is identical: the prompt cache survives the mode switch.
    expect(new Set(sent.map((r) => r.system)).size).toBe(1);
    expect(new Set(sent.map((r) => JSON.stringify(r.tools))).size).toBe(1);

    const userTexts = (r: ChatRequest) => r.messages.filter((m) => m.role === "user").flatMap((m) => m.parts).flatMap((p) => (p.type === "text" ? [p.text] : []));
    expect(userTexts(sent[0])).toEqual(["привет"]);
    expect(userTexts(sent[1]).at(-1)).toMatch(/plan mode is on/);
    expect(userTexts(sent[3]).at(-1)).toMatch(/plan mode is off now/);

    // The write was refused without a question, and the model was told why.
    expect(planning.find((e) => e.type === "tool_end")).toMatchObject({ isError: true, result: expect.stringMatching(/Plan mode is on/) });
    expect(planning.some((e) => e.type === "file_changed")).toBe(false);
    expect(asked).toBe(1);
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("x");
  });
});
