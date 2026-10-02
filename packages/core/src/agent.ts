import { PermissionGate, type ApprovalHandler, type ApprovalMode } from "./permissions";
import { buildSystemPrompt, snapshotLayout } from "./prompt";
import { loadRules, type RuleSource } from "./rules";
import { executeTool, TOOL_DEFINITIONS, type FileChange, type PlanItem } from "./tools";
import type {
  ImagePart,
  Message,
  Part,
  Provider,
  StopReason,
  StreamEvent,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  Usage,
} from "./types";

export interface AgentOptions {
  provider: Provider;
  model: string;
  root: string;
  approval: ApprovalHandler;
  mode?: ApprovalMode;
  maxSteps?: number;
  maxTokens?: number;
  /** Override for tests; defaults to ~/.config/dimosi/rules.md. */
  globalRulesPath?: string;
}

export type AgentEvent =
  | { type: "rules"; sources: RuleSource[] }
  | { type: "text"; text: string }
  | { type: "tool_start"; call: ToolCallPart }
  | { type: "tool_end"; call: ToolCallPart; result: string; isError: boolean }
  | { type: "plan"; items: PlanItem[] }
  | { type: "file_changed"; change: FileChange }
  | { type: "usage"; usage: Usage }
  | { type: "done"; stopReason: StopReason }
  | { type: "error"; message: string };

/** What the user sends: plain text, or text plus attachments. */
export type UserInput = string | Array<TextPart | ImagePart>;

export class Agent {
  provider: Provider;
  model: string;
  maxSteps: number;
  readonly root: string;
  readonly gate: PermissionGate;
  messages: Message[] = [];
  private maxTokens?: number;
  private globalRulesPath?: string;
  private layout?: string;

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.root = opts.root;
    this.maxSteps = opts.maxSteps ?? 50;
    this.maxTokens = opts.maxTokens;
    this.globalRulesPath = opts.globalRulesPath;
    this.gate = new PermissionGate(opts.approval, opts.mode ?? "ask");
  }

  reset(): void {
    this.messages = [];
    this.layout = undefined;
    this.gate.resetSessionApprovals();
  }

  /** Runs one user turn: model calls and tool executions until the model stops. */
  async *run(input: UserInput, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const parts: Part[] = typeof input === "string" ? [{ type: "text", text: input }] : input;
    this.appendUserParts(parts);

    try {
      // Rules are re-read on every message so edits apply immediately.
      const rules = await loadRules(this.root, this.globalRulesPath);
      yield { type: "rules", sources: rules.sources };
      this.layout ??= await snapshotLayout(this.root);
      const system = buildSystemPrompt({ root: this.root, layout: this.layout, rules });

      for (let step = 0; step < this.maxSteps; step++) {
        let done: Extract<StreamEvent, { type: "done" }> | undefined;
        for await (const ev of this.provider.stream({
          model: this.model,
          system,
          messages: this.messages,
          tools: TOOL_DEFINITIONS,
          maxTokens: this.maxTokens,
          signal,
        })) {
          if (ev.type === "text_delta") yield { type: "text", text: ev.text };
          else done = ev;
        }
        if (!done) throw new Error("Сервис оборвал ответ. Попробуйте ещё раз.");
        if (done.usage) yield { type: "usage", usage: done.usage };

        const calls = done.message.parts.filter((p): p is ToolCallPart => p.type === "tool_call");
        if (done.message.parts.length) this.messages.push(done.message);

        if (done.stopReason === "refusal") {
          this.closeDanglingToolCalls("The model declined this request.");
          yield { type: "error", message: "Модель отказалась выполнять этот запрос." };
          return;
        }
        if (!calls.length) {
          if (done.stopReason === "max_tokens") {
            yield { type: "error", message: "Ответ упёрся в лимит длины и был обрезан. Напишите «продолжай»." };
          }
          yield { type: "done", stopReason: done.stopReason };
          return;
        }

        const results: ToolResultPart[] = [];
        for (const call of calls) {
          if (signal?.aborted) break;
          yield { type: "tool_start", call };
          const pending: AgentEvent[] = [];
          // A tool call cut off by the token limit may have truncated arguments.
          const result = done.stopReason === "max_tokens"
            ? { content: "The reply hit the output token limit, so this tool call may be incomplete. Retry with smaller steps.", isError: true }
            : await executeTool(call, {
                root: this.root,
                gate: this.gate,
                signal,
                onFileChange: (change) => pending.push({ type: "file_changed", change }),
                onPlan: (items) => pending.push({ type: "plan", items }),
              });
          results.push({ type: "tool_result", toolCallId: call.id, content: result.content, isError: result.isError });
          yield* pending;
          yield { type: "tool_end", call, result: result.content, isError: result.isError };
        }
        this.messages.push({ role: "user", parts: results });
        this.closeDanglingToolCalls("Cancelled by the user.");
        if (signal?.aborted) {
          yield { type: "error", message: "Остановлено." };
          return;
        }
      }
      yield { type: "error", message: `Агент сделал ${this.maxSteps} шагов и остановился. Напишите «продолжай», чтобы он продолжил.` };
    } catch (e) {
      this.closeDanglingToolCalls("Cancelled by the user.");
      if (signal?.aborted) {
        yield { type: "error", message: "Остановлено." };
        return;
      }
      yield { type: "error", message: describeError(e) };
    }
  }

  private appendUserParts(parts: Part[]): void {
    const last = this.messages[this.messages.length - 1];
    // After a cancelled or failed turn the last message may already be from the user.
    if (last?.role === "user") last.parts.push(...parts);
    else this.messages.push({ role: "user", parts: [...parts] });
  }

  /** Every tool call needs a result before the next request, or providers reject the history. */
  private closeDanglingToolCalls(reason: string): void {
    const lastIndex = this.messages.length - 1;
    const last = this.messages[lastIndex];
    if (!last) return;
    const assistant = last.role === "assistant" ? last : this.messages[lastIndex - 1];
    if (assistant?.role !== "assistant") return;
    const calls = assistant.parts.filter((p): p is ToolCallPart => p.type === "tool_call");
    if (!calls.length) return;
    let resultsMsg = last.role === "user" ? last : undefined;
    if (!resultsMsg) {
      resultsMsg = { role: "user", parts: [] };
      this.messages.push(resultsMsg);
    }
    const answered = new Set(
      resultsMsg.parts.filter((p): p is ToolResultPart => p.type === "tool_result").map((p) => p.toolCallId),
    );
    for (const call of calls) {
      if (!answered.has(call.id)) {
        resultsMsg.parts.push({ type: "tool_result", toolCallId: call.id, content: reason, isError: true });
      }
    }
  }
}

export function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const status = e && typeof e === "object" && "status" in e ? (e as { status?: number }).status : undefined;
  if (/context|too long|maximum.*tokens|token limit|prompt is too long/i.test(msg) && (status === 400 || status === 413)) {
    return `Разговор стал слишком длинным для этой модели. Начните новый чат (кнопка «+»). (${msg})`;
  }
  if (/image|vision|multimodal/i.test(msg) && status === 400) {
    return `Похоже, эта модель не принимает картинки. Выберите другую модель или уберите картинку. (${msg})`;
  }
  switch (status) {
    case 401:
      return `Неверный API-ключ (401). Проверьте ключ этого сервиса. (${msg})`;
    case 402:
      return `Сервис требует оплату (402): пополните баланс. (${msg})`;
    case 403:
      return `Доступ запрещён (403): у ключа нет прав на эту модель или регион. (${msg})`;
    case 404:
      return `Модель или адрес не найдены (404). Проверьте название модели. (${msg})`;
    case 429:
      return `Слишком много запросов или исчерпан лимит (429). Подождите минуту или проверьте тариф. (${msg})`;
  }
  if (status && status >= 500) return `Сервис временно недоступен (${status}). Попробуйте ещё раз через минуту. (${msg})`;
  if (status) return `Ошибка сервиса ${status}: ${msg}`;
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network|Connection error/i.test(msg)) {
    return `Нет связи с сервисом. Проверьте интернет (или адрес сервера). (${msg})`;
  }
  return msg;
}
