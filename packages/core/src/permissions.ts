import * as path from "node:path";
import { commandRule, ruleMatches, type CommandRule, type CommandRuleStore } from "./commandRules";
import { isSecretFile } from "./tools/workspace";

export type ApprovalRequest =
  | {
      kind: "write";
      /** Absolute path. */
      path: string;
      /** As shown to the user: relative to the project root, or the full path in an extra folder. */
      relPath: string;
      /** Path inside the open folder the file really lies in (the project or an extra folder): what the protected-file check looks at. */
      folderPath?: string;
      /** null when the file is being created. */
      oldContent: string | null;
      newContent: string;
      /** Set for files that can run code later; such writes are always asked about. */
      warning?: string;
    }
  | {
      kind: "command";
      command: string;
      cwd: string;
      /** Set for commands that can't be undone or reach outside; such commands are always asked about. */
      warning?: string;
      /** What "Always" would remember, set by the gate. Absent when "Always" is not offered. */
      always?: CommandRule;
      /** Secret files (absolute paths) the sandbox lets this command read. Always asked about, see checkSecrets. */
      secretFiles?: string[];
      /** Set by the gate: "Always" is offered despite the warning and lasts only until the new chat. */
      untilNewChat?: boolean;
    }
  | {
      /** Reading a web page. "Always" remembers the site. */
      kind: "fetch";
      url: string;
      /** The site, e.g. "docs.python.org". */
      host: string;
      warning?: string;
    }
  | {
      /** A picture made by a paid request to an image model. Always asked about; there is no "Always". */
      kind: "image";
      prompt: string;
      /** Absolute path of the new file. */
      path: string;
      relPath: string;
      model: string;
      /** The price of one picture as the service lists it, e.g. "4 ₽". */
      price?: string;
      warning?: string;
    };

export type ApprovalDecision = "allow" | "deny" | "allow_always";

/** Implemented by each host (VS Code UI, terminal prompt). */
export interface ApprovalHandler {
  approve(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export type ApprovalMode = "ask" | "auto";

/**
 * The warning for a write. A file in an extra folder is shown by its full
 * path, but what counts is where it lies inside that folder: `.dimosi/` there
 * is protected, and a folder is not protected just because something above
 * it is called `.vscode`.
 */
function protectedWriteWarning(req: Extract<ApprovalRequest, { kind: "write" }>): string | undefined {
  if (req.folderPath === undefined) return protectedPathWarning(req.relPath);
  return protectedPathWarning(req.folderPath) ?? (path.isAbsolute(req.relPath) ? undefined : protectedPathWarning(req.relPath));
}

/**
 * Files whose content runs later without another question: VS Code tasks and
 * settings, CI workflows, npm scripts, git hooks, direnv, dev containers,
 * the agent's own rules. Writing them always needs the user's
 * explicit yes, even in "no approvals" mode or after "Always".
 */
export function protectedPathWarning(relPath: string): string | undefined {
  const parts = relPath.toLowerCase().split(/[\\/]/);
  if (parts.includes(".vscode")) {
    return "Это файл настроек VS Code. Задачи (tasks.json) и настройки отсюда могут сами запускать команды при открытии папки.";
  }
  const github = parts.indexOf(".github");
  if (github >= 0 && parts[github + 1] === "workflows") {
    return "Это сценарий GitHub Actions. Он выполняется на серверах GitHub при каждой отправке кода и имеет доступ к секретам репозитория.";
  }
  if (parts.includes(".husky")) {
    return "Это git-хук Husky: он запускается сам при каждом git commit, уже без песочницы.";
  }
  if (parts.at(-1) === ".envrc") {
    return "Это .envrc: программа direnv выполняет его сама, когда вы заходите в папку в терминале.";
  }
  if (parts.includes(".devcontainer")) {
    return "Это настройки Dev Container: команды из них VS Code выполняет сам при открытии проекта в контейнере.";
  }
  if (parts.at(-1)!.endsWith(".code-workspace")) {
    return "Это файл рабочей области VS Code: задачи и настройки из него могут сами запускать команды.";
  }
  if (parts[0] === ".dimosi" || parts.at(-1) === "agents.md" || parts.at(-1) === "claude.md") {
    return "Это файл правил: его текст становится указаниями для агента в каждой следующей задаче.";
  }
  if (parts.at(-1) === "package.json") {
    return "Это package.json. Скрипты в нём (например, postinstall) запускаются сами при npm install.";
  }
  return undefined;
}

/**
 * Invisible characters and bidi controls: they can make a command or a change
 * look different from what it does (Trojan Source).
 */
const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** The text with each hidden character shown as a visible mark, e.g. ⟦U+202E⟧. */
export function revealHidden(text: string): string {
  return text.replace(HIDDEN, (ch) => `⟦U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟧`);
}

const countHidden = (text: string | null) => text?.match(HIDDEN)?.length ?? 0;

function hiddenCharsWarning(req: ApprovalRequest): string | undefined {
  const found = req.kind === "fetch"
    ? countHidden(req.url) > 0
    : req.kind === "command"
    ? countHidden(req.command) > 0
    : req.kind === "image"
    ? countHidden(req.prompt) + countHidden(req.relPath) > 0
    // In a file, only new ones count: a byte order mark at the start is common.
    : countHidden(req.relPath) > 0 || countHidden(req.newContent) > countHidden(req.oldContent);
  return found
    ? "Внимание: скрытые символы. В тексте есть невидимые знаки или знаки смены направления письма (показаны как ⟦U+…⟧): ими можно замаскировать настоящий смысл."
    : undefined;
}

/** The part of a page address after "?" that is still read without a question on a site allowed with "Always". */
const MAX_QUIET_QUERY = 100;

/**
 * The site sees the whole address. A long part after "?" is how text from the
 * project could be carried out, so it is asked about even on an allowed site.
 */
function pageAddressWarning(url: string): string | undefined {
  let query = "";
  try {
    query = new URL(url).search;
  } catch {
    // not an address: the tool refuses it itself
  }
  return query.length > MAX_QUIET_QUERY
    ? `В адресе после «?» длинная строка (длина ${query.length}). Сайт увидит её целиком: так наружу могут уйти данные из проекта. Проверьте, что в ней нет лишнего.`
    : undefined;
}

/** Up to the next `;`, `&&`, `|` or line break: one command of a chain. */
const ARGS = String.raw`[^;&|\n]*`;

const DANGEROUS_COMMANDS: Array<[RegExp, string]> = [
  [/\b(sudo|doas)\b/, "Команда с правами администратора: ей доступна вся система."],
  [new RegExp(String.raw`\brm\b${ARGS}\s(-[a-z]*[rf]|--recursive|--force)`, "i"), "Удаление файлов (rm -r или -f): удалённое не вернуть, откат dimosi его не восстановит."],
  [new RegExp(String.raw`\bfind\b${ARGS}\s-delete\b`), "Удаление файлов через find -delete: удалённое не вернуть."],
  [new RegExp(String.raw`\bgit\b${ARGS}\spush\b`), "Отправка кода в удалённый репозиторий (git push): его увидят другие, отменить трудно."],
  [
    new RegExp(String.raw`\bgit\b${ARGS}\s(reset\s${ARGS}--hard|clean\b|checkout\s${ARGS}(--|\s\.)(\s|$)|restore\b|stash\s+(drop|clear)\b|branch\s${ARGS}(-d|--delete)\b)`, "i"),
    "Команда git, которая стирает несохранённые в git изменения или ветки. Откат dimosi их не вернёт.",
  ],
  [/\b(curl|wget)\b[^;&|\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, "Скачать из интернета и сразу выполнить: неизвестно, что за код запустится."],
  [
    new RegExp(String.raw`\b(curl|wget)\b${ARGS}\s(-d|-F|-T|--data[a-z-]*|--form[a-z-]*|--upload-file|--post-(file|data))(\s|=|$)`),
    "Отправка данных в интернет: так файлы и пароли могут уйти на чужой сервер.",
  ],
  [/\b(scp|sftp|nc|ncat|netcat)\b/, "Передача файлов или данных на другой компьютер."],
  [new RegExp(String.raw`\brsync\b${ARGS}\s\S+:`), "Передача файлов на другой компьютер (rsync)."],
  [/\b(npm|pnpm|yarn)\s+(publish|unpublish)\b/, "Публикация пакета в интернет: отменить нельзя."],
  [/\bsecurity\s+(find|dump|export|delete)/, "Доступ к Связке ключей macOS: там хранятся пароли и ключи."],
  [/\bosascript\b/, "Управление другими программами Mac через AppleScript."],
  [/\b(killall|pkill)\b/, "Завершение программ по имени: может закрыть VS Code или другие программы."],
  [/\b(shutdown|reboot|mkfs|diskutil\s+erase)\b/, "Команда, которая выключает компьютер или стирает диск."],
];

/**
 * Commands that can't be undone (the rollback only covers file edits) or
 * reach outside the project. Like protected files, they are always asked
 * about, even in "no approvals" mode or after "Always". The list catches
 * honest mistakes, not a determined attacker: the sandbox is what limits
 * a command that slips through.
 */
export function dangerousCommandWarning(command: string): string | undefined {
  const secret = command.split(/[\s'"`=<>()|;&]+/).find((word) => word && isSecretFile(word));
  if (secret) {
    return `Команда обращается к файлу ${secret}, где могут быть пароли и ключи. Его содержимое может уйти сервису ИИ или в интернет.`;
  }
  return DANGEROUS_COMMANDS.find(([re]) => re.test(command))?.[1];
}

/** What the model is told when a call is refused in "plan first" mode. */
export const PLAN_MODE_REFUSAL =
  "Plan mode is on, so this call was not run and nothing was changed. Finish investigating with the read-only tools " +
  "(list_files, read_file, search), show the plan with update_plan, describe it briefly and stop. " +
  "The user will read the plan and switch plan mode off; carry it out then.";

/**
 * "Always" covers all file writes until the new chat. For a command it
 * remembers a rule (see commandRule): allowing `npm test` must not allow
 * `rm -rf` later. With a store the rules outlive the session.
 */
export class PermissionGate {
  private writesAllowed = false;
  /** Rules of this chat: all of them without a store, or those the store could not save. */
  private sessionRules: CommandRule[] = [];
  private sessionSites: string[] = [];
  /** Commands allowed to read secret files until the new chat. Never saved: a new chat starts from nothing. */
  private sessionSecrets: Array<{ rule: CommandRule; files: string[] }> = [];
  /**
   * "Plan first": nothing is changed and the user is not asked. Every write
   * and every command is refused, also the commands allowed with "Always":
   * the gate can't tell `git status` from `npm install`. Done here and not
   * by hiding tools: the tool list must stay the same for the prompt cache.
   */
  planOnly = false;

  constructor(
    private handler: ApprovalHandler,
    public mode: ApprovalMode = "ask",
    private rules?: CommandRuleStore,
  ) {}

  async check(req: ApprovalRequest): Promise<boolean> {
    const own =
      req.kind === "write" ? protectedWriteWarning(req)
      : req.kind === "command" ? dangerousCommandWarning(req.command)
      : req.kind === "fetch" ? pageAddressWarning(req.url)
      : undefined;
    const warning = [req.warning, hiddenCharsWarning(req), own].filter(Boolean).join(" ") || undefined;
    if (req.kind === "fetch") return this.checkSite(req, warning);
    if (req.kind === "image") {
      // Every picture costs money: asked in any mode, and "Always" is not remembered.
      if (this.planOnly) throw new Error(PLAN_MODE_REFUSAL);
      return (await this.handler.approve({ ...req, warning })) !== "deny";
    }
    const remembered = () => req.kind === "command" && [...(this.rules?.list() ?? []), ...this.sessionRules].some((rule) => ruleMatches(rule, req.command));
    if (this.planOnly) throw new Error(PLAN_MODE_REFUSAL);
    // Hidden characters, a dangerous command or one that names a secret file itself: asked as any such command.
    if (req.kind === "command" && req.secretFiles?.length && !hiddenCharsWarning(req) && !own) return this.checkSecrets(req, req.secretFiles);
    if (warning) return (await this.handler.approve({ ...req, warning })) !== "deny";
    if (this.mode === "auto") return true;
    if (req.kind === "write") {
      if (this.writesAllowed) return true;
      const decision = await this.handler.approve(req);
      if (decision === "allow_always") this.writesAllowed = true;
      return decision !== "deny";
    }
    // The saved list is read every time: a rule the user removed stops working at once.
    if (remembered()) return true;
    const always = commandRule(req.command);
    const decision = await this.handler.approve({ ...req, always });
    if (decision === "allow_always") {
      try {
        if (!this.rules) throw new Error("no store");
        await this.rules.add(always);
      } catch {
        this.sessionRules.push(always);
      }
    }
    return decision !== "deny";
  }

  /**
   * Every new site is asked about, in any mode: a page address can carry
   * data out, and a page can carry instructions in. "Always" remembers the
   * site; reading changes nothing, so plan mode asks as usual.
   */
  private async checkSite(req: Extract<ApprovalRequest, { kind: "fetch" }>, warning: string | undefined): Promise<boolean> {
    const known = [...(this.rules?.sites?.() ?? []), ...this.sessionSites].includes(req.host);
    if (known && !warning) return true;
    const decision = await this.handler.approve({ ...req, warning });
    if (decision === "allow_always" && !warning) {
      try {
        if (!this.rules?.addSite) throw new Error("no store");
        await this.rules.addSite(req.host);
      } catch {
        this.sessionSites.push(req.host);
      }
    }
    return decision !== "deny";
  }

  /**
   * A command that reads secret files is asked about in any mode. The user
   * may remember it until the new chat: the same program (see commandRule)
   * with the same files, so that a report run ten times is asked about once.
   */
  private async checkSecrets(req: Extract<ApprovalRequest, { kind: "command" }>, files: string[]): Promise<boolean> {
    if (this.sessionSecrets.some((s) => ruleMatches(s.rule, req.command) && files.every((f) => s.files.includes(f)))) return true;
    const always = commandRule(req.command);
    const decision = await this.handler.approve({ ...req, always, untilNewChat: true });
    if (decision === "allow_always") this.sessionSecrets.push({ rule: always, files });
    return decision !== "deny";
  }

  /** New chat: "Always" for file writes and for secret files is forgotten; saved command rules stay. */
  resetSessionApprovals(): void {
    this.writesAllowed = false;
    this.sessionRules = [];
    this.sessionSites = [];
    this.sessionSecrets = [];
  }
}
