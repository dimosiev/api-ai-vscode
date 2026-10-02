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
    }
  | { kind: "command"; command: string; cwd: string };

export type ApprovalDecision = "allow" | "deny" | "allow_always";

/** Implemented by each host (VS Code UI, terminal prompt). */
export interface ApprovalHandler {
  approve(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export type ApprovalMode = "ask" | "auto";

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
    if (this.mode === "auto" || this.alwaysAllowed.has(approvalKey(req))) return true;
    const decision = await this.handler.approve(req);
    if (decision === "allow_always") this.alwaysAllowed.add(approvalKey(req));
    return decision !== "deny";
  }

  resetSessionApprovals(): void {
    this.alwaysAllowed.clear();
  }
}
