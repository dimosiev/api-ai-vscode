import { createAccess, type AccessPolicy, type ExtraFolder } from "./access";
import type { CommandRuleStore } from "./commandRules";
import { PermissionGate, type ApprovalHandler, type ApprovalMode } from "./permissions";
import type { Log } from "./log";
import { buildSystemPrompt, snapshotLayout, today } from "./prompt";
import { isProjectRulesFile, loadRules, type RuleSource, type RuleTrust } from "./rules";
import { IncompleteResponseError } from "./providers/openai";
import { executeTool, TOOL_DEFINITIONS, type FileAccess, type FileChange, type PlanItem, type ProblemWatcher } from "./tools";
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
  /** Run commands in the macOS sandbox. Default: true. */
  sandbox?: boolean;
  maxTokens?: number;
  /** Model context window in tokens; old tool output is trimmed to stay inside it. */
  contextWindow?: number;
  /** Override for tests; defaults to ~/.config/dimosi/rules.md. */
  globalRulesPath?: string;
  /** How tools read and write files; defaults to the disk. */
  files?: FileAccess;
  /** The editor's errors for a changed file, added to the tool result (VS Code only). */
  problems?: ProblemWatcher;
  /** Folders outside the project that the user opened to the agent. */
  extraFolders?: ExtraFolder[];
  /** Keeps the commands allowed with "Always" between sessions; without it they last until the new chat. */
  commandRules?: CommandRuleStore;
  /** Diagnostic journal: request and tool metadata only, never content. */
  log?: Log;
  /** Decides on the project's rules files (AGENTS.md, CLAUDE.md, .dimosi/); without it they are used as is. */
  ruleTrust?: RuleTrust;
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

type DoneEvent = Extract<StreamEvent, { type: "done" }>;

export const DEFAULT_CONTEXT_WINDOW = 200_000;
// Notes about "plan first" go into the user's message, never into the system
// prompt or the tool list: those must stay the same for the prompt cache.
const PLAN_NOTE =
  "[dimosi: plan mode is on. Investigate with the read-only tools, then show a step-by-step plan with update_plan, explain it briefly and stop. " +
  "Do not change files or run commands in this turn: such calls are refused.]";
const EXECUTE_NOTE = "[dimosi: plan mode is off now. Unless the user asks for something else, carry out the plan.]";
/** Pauses before retrying a failed request (network drop, overload, 5xx). */
const RETRY_DELAYS_MS = [2000, 5000];
const MAX_STOPPED_CHARS = 8000;
const TRIMMED_RESULT = "[Output removed to free context space. Run the tool again if you still need it.]";

export class Agent {
  provider: Provider;
  model: string;
  maxSteps: number;
  /** Commands run in the macOS sandbox. */
  sandbox: boolean;
  contextWindow: number;
  /** As written in the user's settings; checked when a task starts. */
  extraFolders: ExtraFolder[];
  /** "Plan first": the agent investigates and proposes a plan; nothing is changed until this is switched off. */
  planFirst = false;
  /** The previous turn was a planning one. */
  private planned = false;
  readonly root: string;
  readonly gate: PermissionGate;
  messages: Message[] = [];
  private maxTokens?: number;
  private globalRulesPath?: string;
  private files?: FileAccess;
  private problems?: ProblemWatcher;
  private log?: Log;
  private ruleTrust?: RuleTrust;
  private layout?: string;
  private date?: string;
  /** What the user saw of a reply they stopped; told to the model with the next message. */
  private streamed = "";
  private access?: { key: string; policy: AccessPolicy };
  private running = false;

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.root = opts.root;
    this.maxSteps = opts.maxSteps ?? 50;
    this.sandbox = opts.sandbox ?? true;
    this.contextWindow = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this.maxTokens = opts.maxTokens;
    this.globalRulesPath = opts.globalRulesPath;
    this.files = opts.files;
    this.problems = opts.problems;
    this.extraFolders = opts.extraFolders ?? [];
    this.log = opts.log;
    this.ruleTrust = opts.ruleTrust;
    this.gate = new PermissionGate(opts.approval, opts.mode ?? "ask", opts.commandRules);
  }

  reset(): void {
    this.messages = [];
    this.layout = undefined;
    this.date = undefined;
    this.access = undefined;
    this.planned = false;
    this.gate.resetSessionApprovals();
  }

  /**
   * The project plus the extra folders. Checked once per chat and again only
   * when the user changes the list: the folders are named in the system
   * prompt, and a prompt that keeps changing is never served from the cache.
   */
  private accessPolicy(): AccessPolicy {
    const key = JSON.stringify(this.extraFolders);
    if (this.access?.key !== key) {
      const policy = createAccess(this.root, this.extraFolders);
      this.access = { key, policy };
      this.log?.info(`access: project + ${policy.folders.length} extra folders (${policy.folders.filter((f) => f.mode === "write").length} writable, ${policy.rejected.length} not used)`);
    }
    return this.access.policy;
  }

  /**
   * Continues a saved conversation. A save made mid-step may hold tool calls
   * without results; they are answered so the next request stays valid.
   * Assistant messages (Claude's original content) are kept exactly as saved.
   */
  restore(messages: Message[]): void {
    this.reset();
    this.messages = messages;
    this.closeDanglingToolCalls(
      "The result of this call was lost because the editor window was reloaded. Check the current state before repeating it.",
    );
  }

  /** Runs one user turn: model calls and tool executions until the model stops. */
  async *run(input: UserInput, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    // Two runs on one history would interleave messages and break the chat for good.
    if (this.running) {
      yield { type: "error", message: "Агент ещё выполняет предыдущую задачу. Дождитесь окончания или нажмите «Стоп»." };
      return;
    }
    this.running = true;
    try {
      yield* this.runTurn(input, signal);
    } finally {
      this.running = false;
    }
  }

  private async *runTurn(input: UserInput, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const parts: Part[] = typeof input === "string" ? [{ type: "text", text: input }] : [...input];
    const note = this.planFirst ? PLAN_NOTE : this.planned ? EXECUTE_NOTE : undefined;
    if (note) parts.push({ type: "text", text: note });
    this.planned = this.planFirst;
    this.gate.planOnly = this.planFirst;
    this.appendUserParts(parts);

    try {
      // Rules are re-read on every message so edits apply immediately.
      const rules = await loadRules(this.root, this.globalRulesPath, this.ruleTrust);
      yield { type: "rules", sources: rules.sources };
      this.layout ??= await snapshotLayout(this.root);
      const access = this.accessPolicy();
      this.date ??= today();
      const system = buildSystemPrompt({ root: this.root, layout: this.layout, rules, folders: access.folders, date: this.date });

      for (let step = 0; step < this.maxSteps; step++) {
        // Trim rarely and in one go: every trim invalidates the prompt cache once.
        const size = estimateTokens(this.messages);
        if (size > this.contextWindow * 0.7) {
          trimToolResults(this.messages, this.contextWindow * 0.4);
          this.log?.info(`context trimmed: ≈${size} → ≈${estimateTokens(this.messages)} tok (window ${this.contextWindow})`);
        }
        const done = yield* this.request(system, signal);
        if (done.usage) yield { type: "usage", usage: done.usage };

        const calls = done.message.parts.filter((p): p is ToolCallPart => p.type === "tool_call");
        if (done.message.parts.length) this.messages.push(done.message);

        if (done.stopReason === "refusal") {
          this.log?.warn("the model refused the request");
          this.closeDanglingToolCalls("The model declined this request.");
          yield { type: "error", message: "Модель отказалась выполнять этот запрос." };
          return;
        }
        if (!calls.length) {
          if (done.stopReason === "max_tokens") {
            this.log?.warn("reply cut off at the output token limit");
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
          const toolStarted = Date.now();
          // A tool call cut off by the token limit may have truncated arguments.
          const result = done.stopReason === "max_tokens"
            ? { content: "The reply hit the output token limit, so this tool call may be incomplete. Retry with smaller steps.", isError: true }
            : await executeTool(call, {
                root: this.root,
                access,
                gate: this.gate,
                files: this.files,
                problems: this.problems,
                sandbox: this.sandbox,
                signal,
                onFileChange: (change) => pending.push({ type: "file_changed", change }),
                onPlan: (items) => pending.push({ type: "plan", items }),
              });
          this.logTool(call.name, Date.now() - toolStarted, result);
          for (const e of pending) {
            // A new rules file the user approved in full is theirs: don't ask about it again.
            if (e.type === "file_changed" && e.change.oldContent === null && isProjectRulesFile(this.root, e.change.path)) {
              await this.ruleTrust?.remember?.(e.change.path, e.change.newContent);
            }
          }
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
      this.log?.warn(`stopped after ${this.maxSteps} steps`);
      yield { type: "error", message: `Агент сделал ${this.maxSteps} шагов и остановился. Напишите «продолжай», чтобы он продолжил.` };
    } catch (e) {
      this.closeDanglingToolCalls("Cancelled by the user.");
      if (signal?.aborted) {
        this.noteStoppedReply();
        this.log?.info("stopped by the user");
        yield { type: "error", message: "Остановлено." };
        return;
      }
      this.log?.error(`task failed: ${describeError(e)}`);
      yield { type: "error", message: describeError(e) };
    }
  }

  /** One model call, retried when it failed before anything reached the user. */
  private async *request(system: string, signal?: AbortSignal): AsyncGenerator<AgentEvent, DoneEvent> {
    let trimmedForOverflow = false;
    for (let attempt = 0; ; attempt++) {
      let started = false;
      this.streamed = "";
      const at = Date.now();
      const what = `request ${this.provider.id}/${this.model} (${this.messages.length} messages, ≈${estimateTokens(this.messages) + Math.ceil(system.length / 3)} tok${attempt ? `, attempt ${attempt + 1}` : ""})`;
      try {
        let done: DoneEvent | undefined;
        for await (const ev of this.provider.stream({
          model: this.model,
          system,
          messages: this.messages,
          tools: TOOL_DEFINITIONS,
          maxTokens: this.maxTokens,
          signal,
        })) {
          if (ev.type === "text_delta") {
            started = true;
            this.streamed += ev.text;
            yield { type: "text", text: ev.text };
          } else done = ev;
        }
        if (!done) throw new IncompleteResponseError();
        const u = done.usage;
        this.log?.info(`${what}: ok in ${seconds(at)}, stop ${done.stopReason}${u ? `, ${usageText(u)}` : ""}`);
        return done;
      } catch (e) {
        const failure = `${what}: failed in ${seconds(at)}${statusOf(e) ? ` with ${statusOf(e)}` : ""} — ${errorText(e, this.log)}`;
        if (signal?.aborted) {
          this.log?.info(`${what}: stopped by the user after ${seconds(at)}`);
          throw e;
        }
        if (started) {
          this.log?.error(`${failure} (after the reply had started, not retried)`);
          throw e;
        }
        // The history no longer fits: drop old tool output and try again once.
        if (isContextOverflow(e) && !trimmedForOverflow) {
          trimmedForOverflow = true;
          const before = estimateTokens(this.messages);
          if (trimToolResults(this.messages, before / 2)) {
            this.log?.warn(`${failure}; context overflow, trimmed ≈${before} → ≈${estimateTokens(this.messages)} tok and retrying`);
            continue;
          }
        }
        if (attempt < RETRY_DELAYS_MS.length && isRetryable(e)) {
          this.log?.warn(`${failure}; retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s`);
          await sleep(RETRY_DELAYS_MS[attempt], signal);
          continue;
        }
        this.log?.error(failure);
        throw e;
      }
    }
  }

  /** Name, time and outcome only: results hold file contents and command output. */
  private logTool(name: string, ms: number, result: { content: string; isError: boolean }): void {
    if (!this.log) return;
    if (!result.isError) return this.log.info(`tool ${name}: ok in ${ms} ms`);
    // Our own error texts carry no file contents, except the echo of broken arguments.
    const reason = result.content.startsWith("Tool arguments were not valid JSON")
      ? "arguments were not valid JSON"
      : this.log.redact(result.content.split("\n")[0]).slice(0, 160);
    this.log.warn(`tool ${name}: failed in ${ms} ms — ${reason}`);
  }

  /**
   * A reply cut off by Stop never reaches the history (it is not a complete
   * answer of the model), but the user has read it. It is passed on as a note
   * in the user's message, so that "continue" does not start from scratch.
   */
  private noteStoppedReply(): void {
    const text = this.streamed.trim();
    this.streamed = "";
    if (!text) return;
    const seen = text.length > MAX_STOPPED_CHARS ? `${text.slice(0, MAX_STOPPED_CHARS / 2)}\n[...]\n${text.slice(-MAX_STOPPED_CHARS / 2)}` : text;
    this.appendUserParts([
      { type: "text", text: `[dimosi: the user stopped your previous reply. They saw this much of it:\n"""\n${seen}\n"""\nIf asked to continue, go on from there instead of starting again.]` },
    ]);
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

/** Rough token count of the history (≈3 characters per token, on the safe side). */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "text") chars += p.text.length;
      else if (p.type === "tool_result") chars += p.content.length;
      else if (p.type === "tool_call") chars += JSON.stringify(p.input).length;
      else chars += 4500; // an image is ~1500 tokens
    }
  }
  return Math.ceil(chars / 3);
}

/**
 * Replaces the oldest tool output with a short note until the history fits
 * `targetTokens`. Only tool results change: assistant messages (Claude's
 * original content) must be resent exactly as received. Returns true if
 * anything was trimmed.
 */
/** "in 1000 (cache read 900, write 50, hit 90%) out 5": shows whether prompt caching works. */
function usageText(u: Usage): string {
  const read = u.cacheReadTokens ?? 0;
  const write = u.cacheWriteTokens ?? 0;
  const total = u.inputTokens + read + write;
  const cache = read || write ? ` (cache read ${read}, write ${write}, hit ${Math.round((read / total) * 100)}%)` : "";
  return `in ${total}${cache} out ${u.outputTokens}`;
}

export function trimToolResults(messages: Message[], targetTokens: number): boolean {
  let trimmed = false;
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (estimateTokens(messages) <= targetTokens) return trimmed;
      if (p.type === "tool_result" && p.content.length > TRIMMED_RESULT.length * 2) {
        p.content = TRIMMED_RESULT;
        trimmed = true;
      }
    }
  }
  return trimmed;
}

function seconds(since: number): string {
  return `${((Date.now() - since) / 1000).toFixed(1)}s`;
}

/** Masked before it is cut: a key split at the cut would no longer be recognized. */
function errorText(e: unknown, log?: Log): string {
  const text = e instanceof Error ? e.message : String(e);
  return (log ? log.redact(text) : text).slice(0, 300);
}

function statusOf(e: unknown): number | undefined {
  return e && typeof e === "object" && "status" in e ? (e as { status?: number }).status : undefined;
}

function isContextOverflow(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const status = statusOf(e);
  return /context|too long|maximum.*tokens|token limit|prompt is too long/i.test(msg) && (status === 400 || status === 413);
}

function isRetryable(e: unknown): boolean {
  if (e instanceof IncompleteResponseError) return true;
  const status = statusOf(e);
  if (status !== undefined) return status === 408 || status === 409 || status === 429 || status >= 500;
  const msg = e instanceof Error ? e.message : String(e);
  return /overloaded|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|terminated|network|Connection error/i.test(msg);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const status = statusOf(e);
  if (isContextOverflow(e)) {
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
