import { isSecretFile } from "./tools/workspace";

export type ApprovalRequest =
  | {
      kind: "write";
      /** Absolute path. */
      path: string;
      /** Path relative to the project root, for display. */
      relPath: string;
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
    };

export type ApprovalDecision = "allow" | "deny" | "allow_always";

/** Implemented by each host (VS Code UI, terminal prompt). */
export interface ApprovalHandler {
  approve(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export type ApprovalMode = "ask" | "auto";

/**
 * Files whose content runs later without another question: VS Code tasks and
 * settings, CI workflows, npm scripts, the agent's own rules. Writing them always needs the user's
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
  if (parts[0] === ".dimosi" || parts.at(-1) === "agents.md" || parts.at(-1) === "claude.md") {
    return "Это файл правил: его текст становится указаниями для агента в каждой следующей задаче.";
  }
  if (parts.at(-1) === "package.json") {
    return "Это package.json. Скрипты в нём (например, postinstall) запускаются сами при npm install.";
  }
  return undefined;
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

/**
 * "Always" covers all file writes, but only the exact command that was
 * approved: allowing `npm test` must not allow `rm -rf` later.
 */
function approvalKey(req: ApprovalRequest): string {
  return req.kind === "write" ? "write" : `command:${req.command.trim()}`;
}

export class PermissionGate {
  private alwaysAllowed = new Set<string>();

  constructor(
    private handler: ApprovalHandler,
    public mode: ApprovalMode = "ask",
  ) {}

  async check(req: ApprovalRequest): Promise<boolean> {
    const own = req.kind === "write" ? protectedPathWarning(req.relPath) : dangerousCommandWarning(req.command);
    const warning = [req.warning, own].filter(Boolean).join(" ") || undefined;
    if (warning) return (await this.handler.approve({ ...req, warning })) !== "deny";
    if (this.mode === "auto" || this.alwaysAllowed.has(approvalKey(req))) return true;
    const decision = await this.handler.approve(req);
    if (decision === "allow_always") this.alwaysAllowed.add(approvalKey(req));
    return decision !== "deny";
  }

  resetSessionApprovals(): void {
    this.alwaysAllowed.clear();
  }
}
