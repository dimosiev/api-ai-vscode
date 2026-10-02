import OpenAI from "openai";
import { ToolIdMapper } from "./toolIds";
import type { ChatRequest, Message, Part, Pricing, Provider, StopReason, StreamEvent, Usage } from "../types";

export interface OpenAIProviderOptions {
  id: string;
  apiKey: string;
  baseURL?: string;
  /** Ask for token usage in the stream; not every compatible server accepts it. */
  includeUsage?: boolean;
  fetch?: typeof fetch;
}

/**
 * Chat Completions adapter. Works with OpenAI itself and with any
 * OpenAI-compatible server (Polza AI, OpenRouter, DeepSeek, Ollama, LM Studio...).
 */
export class OpenAIProvider implements Provider {
  readonly id: string;
  private client: OpenAI;
  private includeUsage: boolean;
  /** Mark cache points for Claude models; turned off if the service rejects the marks. */
  private promptCache = true;
  private pricing?: Promise<Map<string, Pricing>>;

  constructor(opts: OpenAIProviderOptions) {
    this.id = opts.id;
    this.includeUsage = opts.includeUsage ?? false;
    this.client = new OpenAI({
      // Local servers (Ollama, LM Studio) ignore the key, but the SDK requires one.
      apiKey: opts.apiKey || "not-needed",
      baseURL: opts.baseURL,
      fetch: opts.fetch,
    });
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const create = (withUsage: boolean, withCache: boolean) =>
      this.client.chat.completions.create(
        {
          model: req.model,
          messages: toOpenAIMessages(req.system, req.messages, { cache: withCache }),
          tools: req.tools.length
            ? req.tools.map((t) => ({
                type: "function" as const,
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              }))
            : undefined,
          stream: true,
          ...(withUsage ? { stream_options: { include_usage: true } } : {}),
        },
        { signal: req.signal },
      );
    let cache = this.promptCache && isClaude(req.model);
    let withUsage = this.includeUsage;
    let stream;
    for (;;) {
      try {
        stream = await create(withUsage, cache);
        break;
      } catch (e) {
        if ((e as { status?: number }).status !== 400) throw e;
        if (cache) {
          // Any 400 with cache marks: retry once without them. If that works,
          // the service does not accept them and they are not sent again.
          cache = false;
        } else if (withUsage && /stream_options|include_usage/i.test(String((e as Error).message))) {
          // Some servers reject stream_options; retry once without it and stop asking.
          withUsage = false;
        } else {
          throw e;
        }
      }
    }
    if (this.promptCache && isClaude(req.model) && !cache) this.promptCache = false;
    this.includeUsage = withUsage;

    let text = "";
    let finishReason: string | null = null;
    let usage: Usage | undefined;
    const calls = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      if (chunk.usage) usage = parseUsage(chunk.usage as unknown as Record<string, unknown>, this.id);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta?.content) {
        text += delta.content;
        yield { type: "text_delta", text: delta.content };
      }
      for (const tc of delta?.tool_calls ?? []) {
        const entry = calls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        calls.set(tc.index, entry);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    // A proxy or the service cut the connection: the reply is incomplete.
    if (!finishReason) throw new IncompleteResponseError();

    const parts: Part[] = [];
    if (text) parts.push({ type: "text", text });
    for (const [index, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      parts.push({
        type: "tool_call",
        id: c.id || `call_${index}_${Date.now()}`,
        name: c.name,
        input: parseArgs(c.args),
      });
    }

    yield {
      type: "done",
      message: { role: "assistant", parts },
      stopReason: mapFinishReason(finishReason, calls.size > 0),
      usage,
    };
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    for await (const model of this.client.models.list()) ids.push(model.id);
    return ids.sort();
  }

  /** Reads prices from /models when the server publishes them (Polza AI, OpenRouter). */
  async getPricing(model: string): Promise<Pricing | undefined> {
    this.pricing ??= (async () => {
      const map = new Map<string, Pricing>();
      for await (const m of this.client.models.list({ timeout: 15_000, maxRetries: 0 })) {
        const price = parsePricing(m as unknown as Record<string, unknown>);
        if (price) map.set(m.id, price);
      }
      return map;
    })().catch(() => {
      this.pricing = undefined; // retry next time
      return new Map<string, Pricing>();
    });
    return (await this.pricing).get(model);
  }
}

/** Understands the Polza AI and OpenRouter model list formats. */
export function parsePricing(raw: Record<string, unknown>): Pricing | undefined {
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? NaN : Number(v));
  const polza = (raw.top_provider as { pricing?: Record<string, unknown> } | undefined)?.pricing;
  if (polza) {
    const input = num(polza.prompt_per_million);
    const output = num(polza.completion_per_million);
    const currency = polza.currency === "USD" ? "USD" : "RUB";
    if (Number.isFinite(input) && Number.isFinite(output)) return { input, output, currency };
  }
  const openrouter = raw.pricing as Record<string, unknown> | undefined;
  if (openrouter) {
    const input = num(openrouter.prompt) * 1e6;
    const output = num(openrouter.completion) * 1e6;
    if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) {
      return { input, output, currency: "USD" };
    }
  }
  return undefined;
}

/** Token counts plus the exact cost when the service reports it. */
export function parseUsage(raw: Record<string, unknown>, providerId: string): Usage {
  // prompt_tokens is the whole input; the details say how much of it came from
  // or went into the cache. Usage.inputTokens counts only the uncached rest.
  const details = (raw.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cacheRead = Number(details.cached_tokens) || 0;
  const cacheWrite = Number(details.cache_write_tokens) || 0;
  const usage: Usage = {
    inputTokens: Math.max(0, (Number(raw.prompt_tokens) || 0) - cacheRead - cacheWrite),
    outputTokens: Number(raw.completion_tokens) || 0,
  };
  if (cacheRead) usage.cacheReadTokens = cacheRead;
  if (cacheWrite) usage.cacheWriteTokens = cacheWrite;
  const rub = Number(raw.cost_rub);
  const generic = Number(raw.cost);
  if (raw.cost_rub !== undefined && Number.isFinite(rub)) usage.cost = { amount: rub, currency: "RUB" };
  else if (providerId === "openrouter" && raw.cost !== undefined && Number.isFinite(generic)) {
    usage.cost = { amount: generic, currency: "USD" };
  }
  return usage;
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { __invalid_arguments: raw };
  } catch {
    // Surfaced to the model as a tool error by the executor.
    return { __invalid_arguments: raw };
  }
}

function mapFinishReason(reason: string | null, hasToolCalls: boolean): StopReason {
  if (reason === "length") return "max_tokens";
  if (reason === "content_filter") return "refusal";
  if (hasToolCalls || reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "stop") return "end_turn";
  return "other";
}

/** The stream ended without a finish reason: the connection was cut mid-reply. */
export class IncompleteResponseError extends Error {
  constructor() {
    super("Ответ сервиса оборвался на середине. Напишите «продолжай».");
  }
}

/** Claude needs explicit cache marks; other models cache automatically or not at all. */
export function isClaude(model: string): boolean {
  return /claude/i.test(model);
}

const CACHE_MARK = { type: "ephemeral" } as const;

/**
 * Copy of a message whose last content part carries a cache mark.
 * cache_control is a Polza AI / OpenRouter extension unknown to the OpenAI types.
 */
function withCacheMark(m: OpenAI.Chat.ChatCompletionMessageParam): OpenAI.Chat.ChatCompletionMessageParam {
  const content: unknown = m.content;
  let parts: Record<string, unknown>[];
  if (typeof content === "string") parts = [{ type: "text", text: content }];
  else if (Array.isArray(content) && content.length) parts = [...(content as Record<string, unknown>[])];
  else return m;
  parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: CACHE_MARK };
  return { ...m, content: parts } as unknown as OpenAI.Chat.ChatCompletionMessageParam;
}

export interface OpenAIMessageOptions {
  /**
   * Mark the system prompt and the last message for prompt caching (Claude via
   * Polza AI or OpenRouter). Everything before the last mark is read from the
   * cache on the next step, so earlier messages must not change between steps.
   */
  cache?: boolean;
}

export function toOpenAIMessages(
  system: string,
  messages: Message[],
  opts: OpenAIMessageOptions = {},
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const ids = new ToolIdMapper();
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      const toolCalls = m.parts
        .filter((p) => p.type === "tool_call")
        .map((p) => ({
          id: ids.call(p.id),
          type: "function" as const,
          function: { name: p.name, arguments: JSON.stringify(p.input) },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // Tool results must directly follow the assistant message that requested them.
    for (const p of m.parts) {
      if (p.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: ids.result(p.toolCallId),
          content: p.isError ? `ERROR: ${p.content}` : p.content,
        });
      }
    }
    const text = m.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
    const images = m.parts.filter((p) => p.type === "image");
    if (images.length) {
      out.push({
        role: "user",
        content: [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...images.map((p) => ({
            type: "image_url" as const,
            image_url: { url: `data:${p.mediaType};base64,${p.data}` },
          })),
        ],
      });
    } else if (text) {
      out.push({ role: "user", content: text });
    }
  }
  if (opts.cache) {
    out[0] = withCacheMark(out[0]);
    if (out.length > 1) out[out.length - 1] = withCacheMark(out[out.length - 1]);
  }
  return out;
}
