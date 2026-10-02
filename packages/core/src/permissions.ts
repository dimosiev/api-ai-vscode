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
  | { kind: "command"; command: string; cwd: string };

export type ApprovalDecision = "allow" | "deny" | "allow_always";

/** Implemented by each host (VS Code UI, terminal prompt). */
export interface ApprovalHandler {
  approve(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export type ApprovalMode = "ask" | "auto";

/**
 * Files whose content runs later without another question: VS Code tasks and
 * settings, CI workflows, npm scripts. Writing them always needs the user's
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
  if (parts.at(-1) === "package.json") {
    return "Это package.json. Скрипты в нём (например, postinstall) запускаются сами при npm install.";
  }
  return undefined;
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
    const warning = req.kind === "write" ? protectedPathWarning(req.relPath) : undefined;
    if (req.kind === "write" && warning) return (await this.handler.approve({ ...req, warning })) !== "deny";
    if (this.mode === "auto" || this.alwaysAllowed.has(approvalKey(req))) return true;
    const decision = await this.handler.approve(req);
    if (decision === "allow_always") this.alwaysAllowed.add(approvalKey(req));
    return decision !== "deny";
  }

  resetSessionApprovals(): void {
    this.alwaysAllowed.clear();
  }
}
