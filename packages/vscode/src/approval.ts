import * as vscode from "vscode";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@dimosi/core";
import { buildDiffView } from "./diff";
import type { ToWebview } from "./protocol";

export const PROPOSED_SCHEME = "dimosi-proposed";

/** Serves the agent's proposed file contents to the side-by-side diff editor. */
export class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();

  set(uri: vscode.Uri, text: string) {
    this.contents.set(uri.toString(), text);
  }

  delete(uri: vscode.Uri) {
    this.contents.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }
}

export interface ApprovalUi {
  post(msg: ToWebview): void;
  /** Brings the chat panel into view so the user sees the question. */
  reveal(): void;
}

interface Pending {
  req: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
  diffUris?: { left: vscode.Uri; right: vscode.Uri };
}

/** Asks for approval with a card in the chat and waits for the user's click. */
export class WebviewApproval implements ApprovalHandler {
  /** Set for each run, so pending questions are dropped when the user presses Stop. */
  signal?: AbortSignal;
  private pending = new Map<string, Pending>();
  private counter = 0;

  constructor(
    private ui: ApprovalUi,
    private proposed: ProposedContentProvider,
  ) {}

  approve(req: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.signal?.aborted) return Promise.resolve("deny");
    const id = `a${++this.counter}`;
    return new Promise<ApprovalDecision>((resolve) => {
      const signal = this.signal;
      const onAbort = () => this.respond(id, "deny");
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        req,
        resolve: (d) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(d);
        },
      });
      if (req.kind === "write") {
        this.ui.post({
          type: "approval_request",
          id,
          kind: "write",
          relPath: req.relPath,
          created: req.oldContent === null,
          diff: buildDiffView(req.oldContent, req.newContent),
          warning: req.warning,
        });
      } else {
        this.ui.post({ type: "approval_request", id, kind: "command", command: req.command });
      }
      this.ui.reveal();
    });
  }

  respond(id: string, decision: ApprovalDecision): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    void this.closeDiff(p);
    this.ui.post({ type: "approval_resolved", id, decision });
    p.resolve(decision);
  }

  /** Denies everything still waiting (panel closed, new chat, stop). */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.respond(id, "deny");
  }

  async openDiff(id: string): Promise<void> {
    const p = this.pending.get(id);
    if (!p || p.req.kind !== "write") return;
    const req = p.req;
    const right = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: "/" + req.relPath, query: `proposed-${id}` });
    const left = req.oldContent === null
      ? vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: "/" + req.relPath, query: `empty-${id}` })
      : vscode.Uri.file(req.path);
    this.proposed.set(right, req.newContent);
    if (req.oldContent === null) this.proposed.set(left, "");
    p.diffUris = { left, right };
    await vscode.commands.executeCommand("vscode.diff", left, right, `${req.relPath} ↔ предложение dimosi`, {
      preview: true,
    });
  }

  private async closeDiff(p: Pending): Promise<void> {
    if (!p.diffUris) return;
    const { left, right } = p.diffUris;
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === right.toString());
    try {
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
    } catch {
      // the user may have closed it already
    }
    this.proposed.delete(right);
    this.proposed.delete(left);
  }
}
