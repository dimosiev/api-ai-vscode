import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, Message, Part, Pricing, Provider, StopReason, StreamEvent } from "../types";

/** USD per 1M tokens for current models; others show tokens only. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface AnthropicProviderOptions {
  id?: string;
  apiKey: string;
  baseURL?: string;
  fetch?: typeof fetch;
}

export class AnthropicProvider implements Provider {
  readonly id: string;
  private client: Anthropic;

  constructor(opts: AnthropicProviderOptions) {
    this.id = opts.id ?? "anthropic";
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, fetch: opts.fetch });
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const stream = this.client.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens ?? 64000,
        // Automatic prompt caching: each agent step resends the whole history,
        // so cached prefixes make long tasks much cheaper.
        cache_control: { type: "ephemeral" },
        system: req.system,
        messages: toAnthropicMessages(req.messages, this.id, req.model),
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
      },
      { signal: req.signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text_delta", text: event.delta.text };
      }
    }

    const final = await stream.finalMessage();
    const parts: Part[] = [];
    for (const block of final.content) {
      if (block.type === "text") parts.push({ type: "text", text: block.text });
      else if (block.type === "tool_use") {
        parts.push({
          type: "tool_call",
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    yield {
      type: "done",
      message: {
        role: "assistant",
        parts,
        providerData: { provider: this.id, model: req.model, raw: final.content },
      },
      stopReason: mapStopReason(final.stop_reason),
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }

  async getPricing(model: string): Promise<Pricing | undefined> {
    const price = PRICES[model];
    return price ? { ...price, currency: "USD" } : undefined;
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    for await (const model of this.client.models.list()) ids.push(model.id);
    return ids;
  }
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "refusal":
      return reason;
    default:
      return "other";
  }
}

export function toAnthropicMessages(
  messages: Message[],
  providerId: string,
  model: string,
): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (
      m.role === "assistant" &&
      m.providerData?.provider === providerId &&
      m.providerData.model === model
    ) {
      return { role: "assistant", content: m.providerData.raw as Anthropic.ContentBlockParam[] };
    }
    const content: Anthropic.ContentBlockParam[] = [];
    for (const p of m.parts) {
      if (p.type === "text") {
        if (p.text) content.push({ type: "text", text: p.text });
      } else if (p.type === "image") {
        content.push({
          type: "image",
          source: { type: "base64", media_type: p.mediaType as ImageMediaType, data: p.data },
        });
      } else if (p.type === "tool_call") {
        content.push({ type: "tool_use", id: p.id, name: p.name, input: p.input });
      } else {
        content.push({
          type: "tool_result",
          tool_use_id: p.toolCallId,
          content: p.content,
          is_error: p.isError,
        });
      }
    }
    return { role: m.role, content };
  });
}
