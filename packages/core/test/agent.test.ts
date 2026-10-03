import { mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Agent, describeError, type AgentEvent, type ChatRequest, type Message, type Provider, type StreamEvent } from "../src";

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

describe("a reply with nothing to show", () => {
  const run = async (done: Partial<Extract<StreamEvent, { type: "done" }>>) => {
    const provider = new FakeProvider([() => [{ type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [] }, ...done }]]);
    const agent = new Agent({ provider, model: "m", root: tmp(), approval: { approve: async () => "allow" }, globalRulesPath: NO_GLOBAL });
    return { agent, events: (await collect(agent.run("нарисуй погоду"))).filter((e) => e.type !== "rules") };
  };

  it("says that the model answered with a picture dimosi cannot show: the request was paid", async () => {
    const { events } = await run({ droppedImages: 1 });
    expect(events).toEqual([
      { type: "error", message: expect.stringMatching(/^Модель ответила картинкой прямо в разговоре.*оплачен.*Polza AI/) },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("says that the model answered nothing", async () => {
    const { events } = await run({});
    expect(events).toEqual([
      { type: "error", message: expect.stringMatching(/^Модель ничего не ответила/) },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("keeps the text of a reply that had a picture too", async () => {
    const { events } = await run({ droppedImages: 2, message: { role: "assistant", parts: [{ type: "text", text: "Вот." }] } });
    expect(events.map((e) => e.type)).toEqual(["error", "done"]);
    expect(events[0]).toMatchObject({ message: expect.stringMatching(/^Модель ответила картинкой/) });
  });

  it("explains a model that cannot call tools instead of «not found» (OpenRouter answers 404)", () => {
    const e = Object.assign(new Error('404 No endpoints found that support tool use. Try disabling "list_files".'), { status: 404 });
    expect(describeError(e)).toMatch(/^Эта модель не умеет пользоваться инструментами.*Выберите другую модель\. \(404 No endpoints/);
    expect(describeError(Object.assign(new Error("404 model not found"), { status: 404 }))).toMatch(/^Модель или адрес не найдены/);
  });
});

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

describe("a stable start of every request", () => {
  it("the date in the system prompt is taken once per chat, so midnight does not reset the cache", async () => {
    const systems: string[] = [];
    const provider = new FakeProvider(Array.from({ length: 3 }, () => (req: ChatRequest): StreamEvent[] => {
      systems.push(req.system);
      return [{ type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [{ type: "text", text: "ok" }] } }];
    }));
    const agent = new Agent({ provider, model: "m", root: tmp(), approval: { approve: async () => "allow" }, globalRulesPath: NO_GLOBAL });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 9, 3, 23, 59)); // local time: the date is the user's
      await collect(agent.run("вечером"));
      vi.setSystemTime(new Date(2026, 9, 4, 0, 1));
      await collect(agent.run("после полуночи"));
      expect(systems[0]).toContain("Date: 2026-10-03");
      expect(systems[1]).toBe(systems[0]);
      // A new chat takes the new date.
      agent.reset();
      await collect(agent.run("новый чат"));
      expect(systems[2]).toContain("Date: 2026-10-04");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a reply stopped by the user", () => {
  it("is told to the model with the next message, without touching the model's own messages", async () => {
    const controller = new AbortController();
    const provider = new FakeProvider([]);
    let call = 0;
    provider.stream = async function* (req: ChatRequest): AsyncIterable<StreamEvent> {
      provider.requests.push(structuredClone(req.messages));
      if (call++ === 0) {
        yield { type: "text_delta", text: "Шаг 1: открыть файл. " };
        yield { type: "text_delta", text: "Шаг 2: " };
        // The user presses Stop in the middle of the reply.
        controller.abort();
        throw new Error("aborted");
      }
      yield { type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [{ type: "text", text: "поправить строку." }] } };
    };
    const agent = new Agent({ provider, model: "m", root: tmp(), approval: { approve: async () => "allow" }, globalRulesPath: NO_GLOBAL });
    const stopped = await collect(agent.run("объясни по шагам", controller.signal));
    expect(stopped.at(-1)).toEqual({ type: "error", message: "Остановлено." });
    await collect(agent.run("продолжай"));

    const second = provider.requests[1];
    // Still one user message (no assistant reply came), now with the note and the new text.
    expect(second.map((m) => m.role)).toEqual(["user"]);
    const texts = second[0].parts.flatMap((p) => (p.type === "text" ? [p.text] : []));
    expect(texts[0]).toBe("объясни по шагам");
    expect(texts[1]).toMatch(/the user stopped your previous reply/);
    expect(texts[1]).toContain("Шаг 1: открыть файл. Шаг 2:");
    expect(texts[2]).toBe("продолжай");
  });

  it("nothing is added when the stop came before any text, and a very long reply is shortened", async () => {
    for (const [length, expectNote] of [[0, false], [50_000, true]] as const) {
      const controller = new AbortController();
      const provider = new FakeProvider([]);
      provider.stream = async function* (): AsyncIterable<StreamEvent> {
        if (length) yield { type: "text_delta", text: `START ${"x".repeat(length)} END` };
        controller.abort();
        throw new Error("aborted");
      };
      const agent = new Agent({ provider, model: "m", root: tmp(), approval: { approve: async () => "allow" }, globalRulesPath: NO_GLOBAL });
      await collect(agent.run("задача", controller.signal));
      const note = agent.messages[0].parts.flatMap((p) => (p.type === "text" ? [p.text] : []))[1];
      expect(Boolean(note)).toBe(expectNote);
      if (note) {
        expect(note.length).toBeLessThan(9000);
        expect(note).toContain("START");
        expect(note).toContain("END");
      }
    }
  });
});

describe("effort", () => {
  const reply = (extra: Partial<Extract<StreamEvent, { type: "done" }>> = {}): StreamEvent[] => [
    { type: "text_delta", text: "Готово." },
    { type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [{ type: "text", text: "Готово." }] }, ...extra },
  ];

  it("goes to the model with every request, and only when it is set", async () => {
    const seen: Array<string | undefined> = [];
    const provider = new FakeProvider([(req) => (seen.push(req.effort), reply()), (req) => (seen.push(req.effort), reply())]);
    const agent = new Agent({ provider, model: "m", root: tmp(), approval: { approve: async () => "allow" }, globalRulesPath: NO_GLOBAL });
    await collect(agent.run("раз"));
    agent.effort = "high";
    await collect(agent.run("два"));
    expect(seen).toEqual([undefined, "high"]);
  });

  it("tells the user once per chat that the service did not apply it, and the work goes on", async () => {
    const provider = new FakeProvider([() => reply({ effortIgnored: "unsupported" }), () => reply({ effortIgnored: "unsupported" }), () => reply({ effortIgnored: "rejected" })]);
    const agent = new Agent({ provider, model: "m", root: tmp(), approval: { approve: async () => "allow" }, globalRulesPath: NO_GLOBAL });
    agent.effort = "high";
    const errors = async (text: string) => (await collect(agent.run(text))).filter((e) => e.type === "error").map((e) => (e as { message: string }).message);
    expect(await errors("раз")).toEqual([expect.stringMatching(/^Настройка «Усердие» для этого сервиса не действует/)]);
    expect(await errors("два")).toEqual([]);
    agent.reset();
    expect(await errors("новый чат")).toEqual([expect.stringMatching(/^Сервис не принял настройку «Усердие» для модели m/)]);
  });
});
