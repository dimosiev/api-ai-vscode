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

export class PermissionGate {
  private alwaysAllowed = new Set<ApprovalRequest["kind"]>();

  constructor(
    private handler: ApprovalHandler,
    public mode: ApprovalMode = "ask",
  ) {}

  async check(req: ApprovalRequest): Promise<boolean> {
    if (this.mode === "auto" || this.alwaysAllowed.has(req.kind)) return true;
    const decision = await this.handler.approve(req);
    if (decision === "allow_always") this.alwaysAllowed.add(req.kind);
    return decision !== "deny";
  }

  resetSessionApprovals(): void {
    this.alwaysAllowed.clear();
  }
}
