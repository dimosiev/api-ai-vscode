import OpenAI from "openai";
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
    const create = (withUsage: boolean) =>
      this.client.chat.completions.create(
        {
          model: req.model,
          messages: toOpenAIMessages(req.system, req.messages),
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
    let stream;
    try {
      stream = await create(this.includeUsage);
    } catch (e) {
      // Some servers reject stream_options; retry once without it and stop asking.
      const status = (e as { status?: number }).status;
      if (!this.includeUsage || status !== 400 || !/stream_options|include_usage/i.test(String((e as Error).message))) throw e;
      this.includeUsage = false;
      stream = await create(false);
    }

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
      for await (const m of this.client.models.list()) {
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
  const usage: Usage = {
    inputTokens: Number(raw.prompt_tokens) || 0,
    outputTokens: Number(raw.completion_tokens) || 0,
  };
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

export function toOpenAIMessages(
  system: string,
  messages: Message[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
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
          id: p.id,
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
          tool_call_id: p.toolCallId,
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
  return out;
}
