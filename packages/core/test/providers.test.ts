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

describe("prompt caching through OpenAI-compatible services (Polza AI, OpenRouter)", () => {
  const cc = { type: "ephemeral" };

  it("marks the system prompt and the last message for Claude", () => {
    const out = toOpenAIMessages("sys", history, { cache: true });
    expect(out[0]).toEqual({ role: "system", content: [{ type: "text", text: "sys", cache_control: cc }] });
    // Earlier messages stay unchanged so the cached prefix is byte-identical next time.
    expect(out[1]).toEqual({ role: "user", content: "read a.txt" });
    expect(out.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "t1",
      content: [{ type: "text", text: "1\thello", cache_control: cc }],
    });
  });

  it("marks the last part of a user message with images", () => {
    const out = toOpenAIMessages("sys", [
      { role: "user", parts: [{ type: "text", text: "look" }, { type: "image", mediaType: "image/png", data: "AAA" }] },
    ], { cache: true });
    const content = out.at(-1)!.content as any[];
    expect(content[0]).toEqual({ type: "text", text: "look" });
    expect(content[1]).toMatchObject({ type: "image_url", cache_control: cc });
  });

  it("marks only the last of several tool results", () => {
    const out = toOpenAIMessages("sys", [
      ...history.slice(0, 1),
      {
        role: "assistant",
        parts: [
          { type: "tool_call", id: "a", name: "read_file", input: { path: "a" } },
          { type: "tool_call", id: "b", name: "read_file", input: { path: "b" } },
        ],
      },
      {
        role: "user",
        parts: [
          { type: "tool_result", toolCallId: "a", content: "A" },
          { type: "tool_result", toolCallId: "b", content: "B" },
        ],
      },
    ], { cache: true });
    expect(out.at(-2)).toEqual({ role: "tool", tool_call_id: "a", content: "A" });
    expect(out.at(-1)!.content).toEqual([{ type: "text", text: "B", cache_control: cc }]);
  });

  it("sends cache marks to Polza for Claude models only", async () => {
    const bodies: any[] = [];
    const fetchMock = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return sseResponse([
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    }) as unknown as typeof fetch;
    const provider = createProvider({ presetId: "polza", apiKey: "k", fetch: fetchMock });
    await collect(provider.stream({ model: "anthropic/claude-opus-5.5", system: "s", messages: history, tools: [] }));
    await collect(provider.stream({ model: "openai/gpt-6.1-sol", system: "s", messages: history, tools: [] }));
    expect(bodies[0].messages[0].content).toEqual([{ type: "text", text: "s", cache_control: cc }]);
    expect(bodies[1].messages[0].content).toBe("s");
  });

  it("retries without cache marks when the service rejects them, and stops sending them", async () => {
    const bodies: any[] = [];
    const fetchMock = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (Array.isArray(body.messages[0].content)) {
        return new Response(JSON.stringify({ error: { message: "Unknown field: cache_control" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return sseResponse([
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    }) as unknown as typeof fetch;
    const provider = createProvider({ presetId: "custom", baseURL: "https://x.test/v1", apiKey: "k", fetch: fetchMock });
    const req = { model: "claude-opus-5-5", system: "s", messages: history, tools: [] };
    expect((await collect(provider.stream(req))).at(-1)).toMatchObject({ type: "done", stopReason: "end_turn" });
    await collect(provider.stream(req));
    expect(bodies.map((b) => Array.isArray(b.messages[0].content))).toEqual([true, false, false]);
  });

  it("reads cached and written tokens from usage", () => {
    const u = parseUsage(
      { prompt_tokens: 1500, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 1400, cache_write_tokens: 50 }, cost_rub: 2.5 },
      "polza",
    );
    expect(u).toEqual({
      inputTokens: 50,
      outputTokens: 100,
      cacheReadTokens: 1400,
      cacheWriteTokens: 50,
      cost: { amount: 2.5, currency: "RUB" },
    });
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

  it("accept http:// only for this computer: elsewhere the key would travel unencrypted", () => {
    for (const url of ["http://example.com/v1", "http://192.168.1.5:11434/v1", "http://localhost.evil.com/v1", "ftp://x/v1", "not a url"]) {
      expect(() => createProvider({ presetId: "custom", baseURL: url, apiKey: "k" }), url).toThrow(/https:\/\//);
      expect(() => createProvider({ presetId: "ollama", baseURL: url }), url).toThrow(/https:\/\//);
    }
    for (const url of ["https://example.com/v1", "http://localhost:8080/v1", "http://127.0.0.1:1234/v1", "http://[::1]:11434/v1"]) {
      expect(createProvider({ presetId: "custom", baseURL: url, apiKey: "k" }).id, url).toBe("custom");
    }
  });

  it("send the key only to the official address of a known service", async () => {
    const urls: string[] = [];
    const fetchMock = (async (url: string | URL | Request) => {
      urls.push(String(url instanceof Request ? url.url : url));
      return new Response(JSON.stringify({ data: [], has_more: false, object: "list" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const saved = { a: process.env.ANTHROPIC_BASE_URL, o: process.env.OPENAI_BASE_URL };
    process.env.ANTHROPIC_BASE_URL = "https://evil.example/a";
    process.env.OPENAI_BASE_URL = "https://evil.example/o";
    try {
      await createProvider({ presetId: "anthropic", apiKey: "k", fetch: fetchMock }).listModels();
      await createProvider({ presetId: "openai", apiKey: "k", fetch: fetchMock }).listModels();
      // An address from old settings is ignored for them too.
      await createProvider({ presetId: "polza", apiKey: "k", baseURL: "https://evil.example/p", fetch: fetchMock }).listModels();
    } finally {
      process.env.ANTHROPIC_BASE_URL = saved.a;
      process.env.OPENAI_BASE_URL = saved.o;
      if (saved.a === undefined) delete process.env.ANTHROPIC_BASE_URL;
      if (saved.o === undefined) delete process.env.OPENAI_BASE_URL;
    }
    expect(urls.map((u) => new URL(u).origin)).toEqual(["https://api.anthropic.com", "https://api.openai.com", "https://polza.ai"]);
  });
});

describe("models that do not chat (Polza AI lists image, video and speech models too)", () => {
  // The shape of https://polza.ai/api/v1/models, 3 October 2026.
  const catalog = {
    object: "list",
    data: [
      { id: "qwen/qwen3.8-27b", type: "chat", architecture: { output_modalities: ["text"] } },
      { id: "qwen/image-2", type: "image", architecture: { output_modalities: ["image"] } },
      { id: "kling/v3", type: "video", architecture: { output_modalities: ["video"] } },
      { id: "openai/text-embedding-4", type: "embedding", architecture: { output_modalities: ["embeddings"] } },
      // OpenRouter has no "type": a model that answers with text and pictures still chats.
      { id: "openai/gpt-5-image", architecture: { output_modalities: ["image", "text"] } },
      { id: "black-forest/flux-2", architecture: { output_modalities: ["image"] } },
      { id: "plain-model" },
    ],
  };
  const service = (chat: () => Response) => {
    const urls: string[] = [];
    const fetchMock = (async (url: string) => {
      urls.push(String(url));
      if (String(url).endsWith("/models")) return new Response(JSON.stringify(catalog), { headers: { "content-type": "application/json" } });
      return chat();
    }) as unknown as typeof fetch;
    return { urls, provider: createProvider({ presetId: "polza", apiKey: "k", fetch: fetchMock }) };
  };
  const rejected = () => new Response(JSON.stringify({ error: { message: "Некорректный запрос." } }), { status: 400, headers: { "content-type": "application/json" } });

  it("offers only models that can hold a conversation", async () => {
    const { provider } = service(rejected);
    expect(await provider.listModels()).toEqual(["openai/gpt-5-image", "plain-model", "qwen/qwen3.8-27b"]);
  });

  it("explains that the chosen model draws pictures instead of repeating the service's «Некорректный запрос»", async () => {
    const { provider } = service(rejected);
    const run = collect(provider.stream({ model: "qwen/image-2", system: "s", messages: history, tools: [] }));
    await expect(run).rejects.toThrow(/^Модель qwen\/image-2 создаёт картинки и не умеет вести разговор.*Выберите другую модель.*\(Ответ сервиса: .*Некорректный запрос\.\)$/);
  });

  it("says the same when the service reports the error inside the stream, without a status", async () => {
    const { provider } = service(() => sseResponse([`data: ${JSON.stringify({ error: { message: "Некорректный запрос." } })}\n\n`]));
    const run = collect(provider.stream({ model: "kling/v3", system: "s", messages: history, tools: [] }));
    await expect(run).rejects.toThrow(/^Модель kling\/v3 создаёт видео и не умеет вести разговор/);
  });

  it("does not offer a model that cannot call tools (OpenRouter: supported_parameters)", async () => {
    const list = {
      data: [
        { id: "google/gemini-2.5-flash-image", architecture: { output_modalities: ["image", "text"] }, supported_parameters: ["max_tokens", "temperature"] },
        { id: "google/gemini-3-pro-image", architecture: { output_modalities: ["image", "text"] }, supported_parameters: ["max_tokens", "tools", "tool_choice"] },
        { id: "deepseek/deepseek-v4-pro", architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"] },
      ],
    };
    const fetchMock = (async () => new Response(JSON.stringify(list), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const provider = createProvider({ presetId: "openrouter", apiKey: "k", fetch: fetchMock });
    expect(await provider.listModels()).toEqual(["deepseek/deepseek-v4-pro", "google/gemini-3-pro-image"]);
  });

  it("reports pictures in the reply instead of dropping them without a word (OpenRouter: delta.images)", async () => {
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const { provider } = service(() =>
      sseResponse([
        chunk({ role: "assistant", content: "", images: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }),
        chunk({}, "stop"),
        "data: [DONE]\n\n",
      ]),
    );
    const events = await collect(provider.stream({ model: "google/gemini-3-pro-image", system: "s", messages: history, tools: [] }));
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn", message: { parts: [] }, droppedImages: 1 });
  });

  it("leaves the error of a chat model as it is", async () => {
    const { provider } = service(rejected);
    const run = collect(provider.stream({ model: "qwen/qwen3.8-27b", system: "s", messages: history, tools: [] }));
    await expect(run).rejects.toThrow(/^400 Некорректный запрос\.$/);
  });

  it("does not blame the model for a wrong key or a lost connection", async () => {
    const denied = service(() => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401, headers: { "content-type": "application/json" } }));
    await expect(collect(denied.provider.stream({ model: "qwen/image-2", system: "s", messages: history, tools: [] }))).rejects.toMatchObject({ status: 401 });
    const offline = createProvider({
      presetId: "polza",
      apiKey: "k",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(collect(offline.stream({ model: "qwen/image-2", system: "s", messages: history, tools: [] }))).rejects.toThrow("Connection error.");
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

describe("effort (how hard the model works)", () => {
  const chunk = `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`;
  const refused = (message: string) => new Response(JSON.stringify({ error: { message } }), { status: 400, headers: { "content-type": "application/json" } });
  const done = async (it: AsyncIterable<StreamEvent>) => (await collect(it)).at(-1) as Extract<StreamEvent, { type: "done" }>;

  /** An OpenAI-compatible service that refuses whatever `refuse` says. */
  function service(presetId: string, refuse: (body: any) => string | undefined = () => undefined) {
    const bodies: any[] = [];
    const fetchMock = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const why = refuse(body);
      return why ? refused(why) : sseResponse([chunk, "data: [DONE]\n\n"]);
    }) as unknown as typeof fetch;
    const baseURL = presetId === "custom" ? "https://x.test/v1" : undefined;
    return { bodies, provider: createProvider({ presetId, apiKey: "k", baseURL, fetch: fetchMock }) };
  }
  const req = (model: string, effort?: "low" | "medium" | "high" | "max") => ({ model, system: "s", messages: history, tools: [], effort });

  /** The Anthropic API; `refuse` as above. */
  function anthropic(refuse: (body: any) => string | undefined = () => undefined) {
    const bodies: any[] = [];
    const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const fetchMock = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const why = refuse(body);
      if (why) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: why } }), { status: 400, headers: { "content-type": "application/json" } });
      return sseResponse([
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }),
        ev("content_block_stop", { index: 0 }),
        ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
        ev("message_stop", {}),
      ]);
    }) as unknown as typeof fetch;
    return { bodies, provider: createProvider({ presetId: "anthropic", apiKey: "k", fetch: fetchMock }) };
  }

  it("is not sent at all until the user sets it: requests stay as they were", async () => {
    const polza = service("polza");
    await collect(polza.provider.stream(req("anthropic/claude-opus-5.5")));
    expect(Object.keys(polza.bodies[0]).sort()).toEqual(["messages", "model", "stream", "stream_options"]);
    const direct = anthropic();
    expect(await done(direct.provider.stream(req("claude-opus-5-5")))).not.toHaveProperty("effortIgnored");
    expect(direct.bodies[0]).not.toHaveProperty("output_config");
  });

  it("Anthropic: goes as output_config.effort", async () => {
    const { bodies, provider } = anthropic();
    expect(await done(provider.stream(req("claude-opus-5-5", "low")))).not.toHaveProperty("effortIgnored");
    expect(bodies[0].output_config).toEqual({ effort: "low" });
  });

  it("each service gets it in its own form; Polza AI ignores the OpenAI field, so it gets `reasoning`", async () => {
    const sent = async (presetId: string, model: string) => {
      const { bodies, provider } = service(presetId);
      const last = await done(provider.stream(req(model, "high")));
      const { model: _m, messages: _ms, stream: _s, stream_options: _o, ...rest } = bodies[0];
      return { rest, ignored: last.effortIgnored };
    };
    expect(await sent("polza", "anthropic/claude-opus-5.5")).toEqual({ rest: { reasoning: { type: "adaptive", effort_level: "high" } }, ignored: undefined });
    expect(await sent("polza", "openai/gpt-6.1-sol")).toEqual({ rest: { reasoning: { effort: "high" } }, ignored: undefined });
    expect(await sent("openrouter", "anthropic/claude-opus-5.5")).toEqual({ rest: { reasoning: { effort: "high" } }, ignored: undefined });
    expect(await sent("openai", "gpt-6.1-sol")).toEqual({ rest: { reasoning_effort: "high" }, ignored: undefined });
  });

  it("a service without a known setting gets nothing, and the reply says the effort was not applied", async () => {
    for (const presetId of ["deepseek", "ollama", "custom"]) {
      const { bodies, provider } = service(presetId);
      expect((await done(provider.stream(req("some-model", "high")))).effortIgnored).toBe("unsupported");
      expect(bodies[0]).not.toHaveProperty("reasoning");
      expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    }
  });

  it("a refused effort is left out and not sent to that model again; the cache marks stay", async () => {
    const { bodies, provider } = service("polza", (b) => (b.reasoning ? "reasoning is not supported" : undefined));
    const claude = req("anthropic/claude-opus-5.5", "max");
    expect((await done(provider.stream(claude))).effortIgnored).toBe("rejected");
    expect((await done(provider.stream(claude))).effortIgnored).toBe("rejected");
    expect(bodies.map((b) => [Boolean(b.reasoning), Array.isArray(b.messages[0].content)])).toEqual([
      [true, true],
      [false, true],
      [false, true],
    ]);
    // Another model is asked afresh.
    await collect(provider.stream(req("openai/gpt-6.1-sol", "max")));
    expect(bodies.at(-2).reasoning).toEqual({ effort: "max" });
  });

  it("a refusal for another reason does not switch the effort off for good", async () => {
    // The service refuses the cache marks, not the effort.
    const { bodies, provider } = service("polza", (b) => (Array.isArray(b.messages[0].content) ? "Unknown field: cache_control" : undefined));
    const claude = req("anthropic/claude-opus-5.5", "high");
    await collect(provider.stream(claude));
    expect((await done(provider.stream(claude))).effortIgnored).toBeUndefined();
    expect(bodies.at(-1).reasoning).toEqual({ type: "adaptive", effort_level: "high" });
    expect(bodies.at(-1).messages[0].content).toBe("s");
  });

  it("Anthropic: a model that refuses the effort answers without it, and is not asked again", async () => {
    const { bodies, provider } = anthropic((b) => (b.output_config ? "This model does not support the effort parameter." : undefined));
    expect((await done(provider.stream(req("claude-haiku-4-5", "low")))).effortIgnored).toBe("rejected");
    expect((await done(provider.stream(req("claude-haiku-4-5", "low")))).effortIgnored).toBe("rejected");
    expect(bodies.map((b) => Boolean(b.output_config))).toEqual([true, false, false]);
  });

  it("Anthropic: a request refused for another reason fails as before and keeps the effort", async () => {
    let fail = true;
    const { bodies, provider } = anthropic(() => (fail ? "prompt is too long" : undefined));
    await expect(collect(provider.stream(req("claude-opus-5-5", "high")))).rejects.toThrow(/prompt is too long/);
    fail = false;
    expect((await done(provider.stream(req("claude-opus-5-5", "high")))).effortIgnored).toBeUndefined();
    expect(bodies.map((b) => Boolean(b.output_config))).toEqual([true, false, true]);
  });
});
