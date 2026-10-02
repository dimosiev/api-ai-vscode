import { describe, expect, it } from "vitest";
import {
  createProvider,
  parsePricing,
  parseUsage,
  UsageTotals,
  toAnthropicMessages,
  toOpenAIMessages,
  TOOL_DEFINITIONS,
  type Message,
  type StreamEvent,
} from "../src";

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(it: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const history: Message[] = [
  { role: "user", parts: [{ type: "text", text: "read a.txt" }] },
  {
    role: "assistant",
    parts: [
      { type: "text", text: "Reading." },
      { type: "tool_call", id: "t1", name: "read_file", input: { path: "a.txt" } },
    ],
  },
  { role: "user", parts: [{ type: "tool_result", toolCallId: "t1", content: "1\thello" }] },
];

describe("OpenAI-compatible adapter (Polza AI preset)", () => {
  it("streams text and assembles tool calls split across chunks", async () => {
    let captured: { url: string; body: any } | undefined;
    const fetchMock = (async (url: string, init: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init.body)) };
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return sseResponse([
        chunk({ role: "assistant", content: "Hel" }),
        chunk({ content: "lo" }),
        chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"pa' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }),
        chunk({}, "tool_calls"),
        "data: [DONE]\n\n",
      ]);
    }) as unknown as typeof fetch;

    const provider = createProvider({ presetId: "polza", apiKey: "pz-test", fetch: fetchMock });
    const events = await collect(
      provider.stream({ model: "anthropic/claude-opus-5.5", system: "sys", messages: history, tools: TOOL_DEFINITIONS }),
    );

    expect(captured!.url).toBe("https://polza.ai/api/v1/chat/completions");
    expect(captured!.body.model).toBe("anthropic/claude-opus-5.5");
    expect(captured!.body.tools).toHaveLength(TOOL_DEFINITIONS.length);
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as any).text).join("")).toBe("Hello");
    const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>;
    expect(done.stopReason).toBe("tool_use");
    expect(done.message.parts).toEqual([
      { type: "text", text: "Hello" },
      { type: "tool_call", id: "call_1", name: "read_file", input: { path: "a.txt" } },
    ]);
  });

  it("converts history to Chat Completions messages", () => {
    const out = toOpenAIMessages("sys", history);
    expect(out).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "read a.txt" },
      {
        role: "assistant",
        content: "Reading.",
        tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
      },
      { role: "tool", tool_call_id: "t1", content: "1\thello" },
    ]);
  });
});

describe("Anthropic adapter", () => {
  it("streams text, returns tool_use and keeps raw content for replay", async () => {
    let body: any;
    const fetchMock = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      return sseResponse([
        ev("message_start", {
          message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
        }),
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Let me look." } }),
        ev("content_block_stop", { index: 0 }),
        ev("content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } }),
        ev("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' } }),
        ev("content_block_stop", { index: 1 }),
        ev("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }),
        ev("message_stop", {}),
      ]);
    }) as unknown as typeof fetch;

    const provider = createProvider({ presetId: "anthropic", apiKey: "sk-ant-test", fetch: fetchMock });
    const events = await collect(
      provider.stream({ model: "claude-opus-5-5", system: "sys", messages: history, tools: TOOL_DEFINITIONS }),
    );

    expect(body.model).toBe("claude-opus-5-5");
    expect(body.system).toBe("sys");
    expect(body.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    expect(events[0]).toEqual({ type: "text_delta", text: "Let me look." });
    const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>;
    expect(done.stopReason).toBe("tool_use");
    expect(done.message.parts[1]).toEqual({ type: "tool_call", id: "toolu_1", name: "read_file", input: { path: "a.txt" } });
    expect(done.message.providerData?.provider).toBe("anthropic");
    expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(body.cache_control).toEqual({ type: "ephemeral" });
  });

  it("replays raw content only for the same provider and model", () => {
    const raw = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "Hi" }];
    const msgs: Message[] = [
      { role: "user", parts: [{ type: "text", text: "q" }] },
      { role: "assistant", parts: [{ type: "text", text: "Hi" }], providerData: { provider: "anthropic", model: "claude-opus-5-5", raw } },
    ];
    expect(toAnthropicMessages(msgs, "anthropic", "claude-opus-5-5")[1].content).toBe(raw);
    expect(toAnthropicMessages(msgs, "anthropic", "claude-sonnet-5-5")[1].content).toEqual([{ type: "text", text: "Hi" }]);
  });
});

describe("presets", () => {
  it("requires a key where needed and a URL for custom", () => {
    expect(() => createProvider({ presetId: "openai" })).toThrow(/No API key/);
    expect(() => createProvider({ presetId: "custom" })).toThrow(/base URL/);
    expect(createProvider({ presetId: "ollama" }).id).toBe("ollama");
  });
});

describe("images", () => {
  const msgs: Message[] = [
    { role: "user", parts: [{ type: "text", text: "что это?" }, { type: "image", mediaType: "image/png", data: "AAAA" }] },
  ];

  it("Anthropic: base64 image block", () => {
    expect(toAnthropicMessages(msgs, "anthropic", "m")[0].content).toEqual([
      { type: "text", text: "что это?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
  });

  it("OpenAI-compatible: image_url data URL", () => {
    expect(toOpenAIMessages("sys", msgs)[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "что это?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
  });
});

describe("pricing", () => {
  it("parses Polza AI prices (RUB per million)", () => {
    expect(
      parsePricing({
        id: "anthropic/claude-opus-5.5",
        top_provider: { pricing: { prompt_per_million: "116.85", completion_per_million: "584.29", currency: "RUB" } },
      }),
    ).toEqual({ input: 116.85, output: 584.29, currency: "RUB" });
  });

  it("parses OpenRouter prices (USD per token)", () => {
    expect(parsePricing({ id: "x", pricing: { prompt: "0.000004", completion: "0.00002" } })).toEqual({
      input: 4,
      output: 20,
      currency: "USD",
    });
  });

  it("returns undefined when there is no price", () => {
    expect(parsePricing({ id: "gpt" })).toBeUndefined();
  });

  it("reads prices from the Polza /models endpoint", async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            { id: "deepseek/deepseek-v4-flash", object: "model", top_provider: { pricing: { prompt_per_million: "10", completion_per_million: "20", currency: "RUB" } } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const provider = createProvider({ presetId: "polza", apiKey: "k", fetch: fetchMock });
    expect(await provider.getPricing!("deepseek/deepseek-v4-flash")).toEqual({ input: 10, output: 20, currency: "RUB" });
    expect(await provider.getPricing!("unknown")).toBeUndefined();
  });
});

describe("usage and cost", () => {
  it("takes the exact ruble cost from Polza AI", () => {
    expect(parseUsage({ prompt_tokens: 10, completion_tokens: 20, cost_rub: 0.015, cost: 0.015 }, "polza")).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cost: { amount: 0.015, currency: "RUB" },
    });
  });

  it("prefers reported cost, falls back to the price list", () => {
    const exact = new UsageTotals();
    exact.add({ inputTokens: 1000, outputTokens: 100, cost: { amount: 0.5, currency: "RUB" } });
    exact.add({ inputTokens: 1000, outputTokens: 100, cost: { amount: 0.25, currency: "RUB" } });
    expect(exact.cost({ input: 999, output: 999, currency: "RUB" })).toEqual({ amount: 0.75, currency: "RUB" });

    const estimated = new UsageTotals();
    estimated.add({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000 });
    // 1M × $4 + 1M cached × $0.40 + 0.1M × $20
    expect(estimated.cost({ input: 4, output: 20, currency: "USD" })?.amount).toBeCloseTo(6.4);
    expect(estimated.lastContext).toBe(2_000_000);
  });

  it("retries without stream_options when the server rejects it", async () => {
    const bodies: any[] = [];
    const fetchMock = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (body.stream_options) {
        return new Response(JSON.stringify({ error: { message: "Unrecognized request argument: stream_options" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return sseResponse([
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    }) as unknown as typeof fetch;
    const provider = createProvider({ presetId: "deepseek", apiKey: "k", fetch: fetchMock });
    const events = await collect(provider.stream({ model: "m", system: "s", messages: [], tools: [] }));
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn" });
    expect(bodies.map((b) => Boolean(b.stream_options))).toEqual([true, false]);
  });
});
