import OpenAI from "openai";
import { ChatGPTSignInError, CHATGPT_SIGN_IN_HINT } from "../chatgptAuth";
import { IncompleteResponseError, parseArgs } from "./openai";
import { ToolIdMapper } from "./toolIds";
import type { ChatRequest, Effort, Message, Part, Provider, StopReason, StreamEvent, Usage } from "../types";

export interface ChatGPTProviderOptions {
  id: string;
  baseURL: string;
  /** The access token of the sign-in, renewed by the caller when needed. */
  token: () => Promise<string>;
  fetch?: typeof fetch;
}

const USAGE_PAGE = "ChatGPT → Settings (Настройки) → Usage (Использование)";

/** What the service's refusals mean for the user. The codes: "Errors and recovery" of the sign-in docs. */
const PLAN_ERRORS: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded: `Лимит подписки ChatGPT исчерпан: общий или тот, что задан для dimosi. Посмотреть и изменить: ${USAGE_PAGE}.`,
  subscription_sharing_user_not_eligible: "Этот аккаунт ChatGPT не может использовать подписку в приложениях: не тот тариф, запрет рабочего пространства или регион.",
  subscription_sharing_unsupported_capability: "По подписке ChatGPT эта модель или возможность недоступна. Выберите другую модель.",
  subscription_sharing_route_not_supported: "По подписке ChatGPT такой запрос недоступен.",
  subscription_sharing_invalid_user: `Вход в ChatGPT не принят сервисом. ${CHATGPT_SIGN_IN_HINT}`,
  chatpass_v2_scope_not_authorized: `Вход в ChatGPT не даёт права на запросы по подписке. ${CHATGPT_SIGN_IN_HINT}`,
  chatpass_v2_invalid_authorization_context: `Вход в ChatGPT не даёт права на запросы по подписке. ${CHATGPT_SIGN_IN_HINT}`,
};

/**
 * A refusal that repeating the request cannot cure. It carries no HTTP status on purpose:
 * the agent retries by status, and a used-up plan must not be asked three times.
 */
export class ChatGPTPlanError extends Error {}

type Item = Record<string, unknown>;

/**
 * OpenAI's Responses API paid from the user's ChatGPT plan ("Sign in with ChatGPT").
 * The preview takes only stateless streaming requests: `store: false`, the whole history in
 * `input`, the system text in `instructions`, no token limit and no sampling settings.
 */
export class ChatGPTProvider implements Provider {
  readonly id: string;
  private client: OpenAI;
  /** Models that refused the effort setting: it is not sent to them again. */
  private noEffort = new Set<string>();

  constructor(private opts: ChatGPTProviderOptions) {
    this.id = opts.id;
    this.client = new OpenAI({
      apiKey: opts.token,
      baseURL: opts.baseURL,
      // Given explicitly: otherwise the SDK takes them from the environment.
      organization: null,
      project: null,
      fetch: opts.fetch,
      // A used-up plan answers 429: the library would ask again by itself.
      maxRetries: 0,
    });
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    try {
      yield* this.respond(req);
    } catch (e) {
      throw explain(e);
    }
  }

  private async *respond(req: ChatRequest): AsyncIterable<StreamEvent> {
    const create = (effort: Effort | undefined) =>
      this.client.responses.create(
        {
          model: req.model,
          instructions: req.system,
          input: toResponsesInput(req.messages, this.id, req.model),
          ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema, strict: false })) } : {}),
          ...(effort ? { reasoning: { effort } } : {}),
          // Nothing is kept on the server, so the model's reasoning comes back encrypted and is sent again as is.
          include: ["reasoning.encrypted_content"],
          store: false,
          stream: true,
        } as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
        { signal: req.signal },
      );
    let effort = this.noEffort.has(req.model) ? undefined : req.effort;
    let stream;
    try {
      stream = await create(effort);
    } catch (e) {
      // A refused request (400) arrives before any text. Not every model has the effort
      // setting: ask once more without it, and remember the model only if that worked.
      if (!effort || (e as { status?: number }).status !== 400 || req.signal?.aborted) throw e;
      stream = await create(undefined);
      this.noEffort.add(req.model);
      effort = undefined;
    }

    const items: Item[] = [];
    let final: { status?: string; output?: Item[]; usage?: Record<string, unknown>; incomplete_details?: { reason?: string } | null } | undefined;
    for await (const ev of stream as AsyncIterable<{ type: string } & Record<string, unknown>>) {
      if (ev.type === "response.output_text.delta") {
        if (typeof ev.delta === "string" && ev.delta) yield { type: "text_delta", text: ev.delta };
      } else if (ev.type === "response.output_item.done") {
        items.push(ev.item as Item);
      } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
        final = ev.response as typeof final;
      } else if (ev.type === "response.failed") {
        const error = ((ev.response as { error?: { code?: string; message?: string } | null } | undefined)?.error ?? {}) as { code?: string; message?: string };
        throw Object.assign(new Error(error.message || "Сервис не смог ответить."), { code: error.code });
      }
    }
    // The stream ended without the closing event: the connection was cut mid-reply.
    if (!final) throw new IncompleteResponseError();

    const output = items.length ? items : (final.output ?? []);
    const parts: Part[] = [];
    let refused = false;
    for (const item of output) {
      if (item.type === "message") {
        let text = "";
        for (const c of (item.content as Array<{ type: string; text?: string; refusal?: string }> | undefined) ?? []) {
          if (c.type === "output_text") text += c.text ?? "";
          else if (c.type === "refusal") {
            refused = true;
            text += c.refusal ?? "";
          }
        }
        if (text) parts.push({ type: "text", text });
      } else if (item.type === "function_call") {
        parts.push({ type: "tool_call", id: String(item.call_id), name: String(item.name), input: parseArgs(String(item.arguments ?? "")) });
      }
    }
    const called = parts.some((p) => p.type === "tool_call");

    yield {
      type: "done",
      message: { role: "assistant", parts, providerData: { provider: this.id, model: req.model, raw: output } },
      stopReason: stopReason(final, called, refused),
      usage: final.usage ? parseResponsesUsage(final.usage) : undefined,
      ...(req.effort && !effort ? { effortIgnored: "rejected" as const } : {}),
    };
  }

  /** The models this account may use, in the service's own order. */
  async listModels(): Promise<string[]> {
    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseURL}/models`, {
        headers: { authorization: `Bearer ${await this.opts.token()}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw Object.assign(new Error(`сервис ответил ${res.status}`), { status: res.status });
      const body = (await res.json()) as { models?: Array<{ slug?: unknown; visibility?: unknown }>; data?: Array<{ id?: unknown }> };
      const names = Array.isArray(body.models) ? body.models.filter((m) => m.visibility === "list").map((m) => m.slug) : (body.data ?? []).map((m) => m.id);
      return names.filter((n): n is string => typeof n === "string" && n !== "");
    } catch (e) {
      throw explain(e);
    }
  }
}

function stopReason(final: { status?: string; incomplete_details?: { reason?: string } | null }, called: boolean, refused: boolean): StopReason {
  if (final.status === "incomplete") {
    const reason = final.incomplete_details?.reason;
    return reason === "max_output_tokens" ? "max_tokens" : reason === "content_filter" ? "refusal" : "other";
  }
  return called ? "tool_use" : refused ? "refusal" : "end_turn";
}

/** `input_tokens` is the whole input; Usage.inputTokens counts only what did not come from the cache. */
export function parseResponsesUsage(raw: Record<string, unknown>): Usage {
  const cached = Number((raw.input_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens) || 0;
  const usage: Usage = { inputTokens: Math.max(0, (Number(raw.input_tokens) || 0) - cached), outputTokens: Number(raw.output_tokens) || 0 };
  if (cached) usage.cacheReadTokens = cached;
  return usage;
}

function explain(e: unknown): unknown {
  // The token could not be had: the library wraps the reason, the user needs the reason itself.
  const cause = (e as { cause?: unknown } | undefined)?.cause;
  if (cause instanceof ChatGPTSignInError) return cause;
  const { code, status, param } = (e ?? {}) as { code?: unknown; status?: unknown; param?: unknown };
  const text = (typeof code === "string" && Object.hasOwn(PLAN_ERRORS, code) ? PLAN_ERRORS[code] : undefined) ?? (status === 401 ? `Вход в ChatGPT не принят сервисом. ${CHATGPT_SIGN_IN_HINT}` : undefined);
  if (!text) return e;
  const answer = e instanceof Error ? e.message : String(e);
  return new ChatGPTPlanError(`${text} (Ответ сервиса: ${[answer, typeof param === "string" ? param : ""].filter(Boolean).join(", ")})`, { cause: e });
}

/**
 * The history as Responses input items. The model's own output (with its encrypted reasoning)
 * goes back as it came when the same model continues; only the server ids are left out,
 * because with `store: false` the server keeps nothing to find by them.
 */
export function toResponsesInput(messages: Message[], providerId: string, model: string): Item[] {
  const ids = new ToolIdMapper();
  /** The id each call was sent under, for its result. */
  const sent = new Map<string, string>();
  const out: Item[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const raw = m.providerData?.provider === providerId && m.providerData.model === model ? m.providerData.raw : undefined;
      if (Array.isArray(raw)) {
        for (const item of raw as Item[]) {
          // Reasoning that came without its encrypted text cannot be read back by the service.
          if (item.type === "reasoning" && typeof item.encrypted_content !== "string") continue;
          const { id: _serverId, ...rest } = item;
          out.push(rest);
          if (item.type === "function_call") sent.set(String(item.call_id), String(item.call_id));
        }
        continue;
      }
      const text = m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      if (text) out.push({ role: "assistant", content: text });
      for (const p of m.parts) {
        if (p.type !== "tool_call") continue;
        sent.set(p.id, ids.call(p.id));
        out.push({ type: "function_call", call_id: sent.get(p.id), name: p.name, arguments: JSON.stringify(p.input) });
      }
      continue;
    }
    // Tool results must directly follow the calls they answer.
    for (const p of m.parts) {
      if (p.type === "tool_result") {
        out.push({ type: "function_call_output", call_id: sent.get(p.toolCallId) ?? ids.result(p.toolCallId), output: p.isError ? `ERROR: ${p.content}` : p.content });
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
        content: [...(text ? [{ type: "input_text", text }] : []), ...images.map((p) => ({ type: "input_image", image_url: `data:${p.mediaType};base64,${p.data}`, detail: "auto" }))],
      });
    } else if (text) {
      out.push({ role: "user", content: text });
    }
  }
  return out;
}
