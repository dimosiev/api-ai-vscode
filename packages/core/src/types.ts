// Provider-neutral conversation format. Each provider adapter converts to and
// from its own wire format, so a conversation can survive a provider switch.

export interface TextPart {
  type: "text";
  text: string;
}

/** An image attached by the user (base64, no data: prefix). */
export interface ImagePart {
  type: "image";
  mediaType: string;
  data: string;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export type Part = TextPart | ImagePart | ToolCallPart | ToolResultPart;

export interface Message {
  role: "user" | "assistant";
  parts: Part[];
  /**
   * The provider's original assistant content. Replayed verbatim when the
   * same provider and model continue the conversation (e.g. Claude thinking
   * blocks must be sent back unchanged); ignored otherwise.
   */
  providerData?: { provider: string; model: string; raw: unknown };
}

export interface JsonSchema {
  [key: string]: unknown;
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface Usage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Anthropic prompt caching; billed at ~0.1× and ~1.25× of the input price. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Exact cost reported by the service (Polza AI: rubles, OpenRouter: dollars). */
  cost?: { amount: number; currency: "USD" | "RUB" };
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "done";
      message: Message;
      stopReason: StopReason;
      usage?: Usage;
      /** Pictures the model put into its reply; they are not shown or kept. */
      droppedImages?: number;
      /** The effort asked for was not applied: the service has no such setting, or it refused it. */
      effortIgnored?: "unsupported" | "rejected";
    };

/** How hard the model works on a reply. Not set: the model's own default, nothing is sent. */
export type Effort = "low" | "medium" | "high" | "max";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "max"];

/** A setting or a flag as written by the user; anything unknown means "not set". */
export function parseEffort(value: unknown): Effort | undefined {
  return EFFORTS.find((e) => e === value);
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens?: number;
  effort?: Effort;
  signal?: AbortSignal;
}

/** Price per one million tokens. */
export interface Pricing {
  input: number;
  output: number;
  currency: "USD" | "RUB";
}

export interface Provider {
  /** Preset id, e.g. "anthropic", "polza". */
  readonly id: string;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
  listModels(): Promise<string[]>;
  /** Best effort; undefined when the provider does not publish prices. */
  getPricing?(model: string): Promise<Pricing | undefined>;
}
