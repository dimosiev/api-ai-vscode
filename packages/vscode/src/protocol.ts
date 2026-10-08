// Messages between the extension host and the chat webview. Shared by both
// sides so they cannot drift apart. Must not import "vscode".

export type DiffRow =
  | { t: "hunk"; text: string }
  | { t: "add" | "del" | "ctx"; text: string; old?: number; new?: number };

export interface DiffView {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** Rows were cut to keep the card readable. */
  truncated: boolean;
}

export interface ChipView {
  id: string;
  label: string;
  kind: "file" | "image" | "selection";
}

export interface RuleView {
  label: string;
  path: string;
  scope: "global" | "project";
  truncated: boolean;
  /** Not used: the user has not trusted this file. */
  skipped?: boolean;
}

export interface ChangedFileView {
  relPath: string;
  added: number;
  removed: number;
  created: boolean;
  reverted: boolean;
  /** The original version was not kept, so this file can't be reverted. */
  unavailable: boolean;
}

export interface PlanItemView {
  title: string;
  status: "pending" | "in_progress" | "done";
}

/** The effort setting as the user reads it; "" is the model's own default. */
export const EFFORT_LABELS: Record<string, string> = { "": "как решит модель", low: "низкое", medium: "среднее", high: "высокое", max: "наибольшее" };

export type ToWebview =
  | {
      type: "status";
      provider: string;
      model: string;
      approval: "ask" | "auto";
      /** Show the setup screen: no key or no model yet. */
      needsSetup: boolean;
      hasFolder: boolean;
      /** "Plan first" is on: the agent proposes a plan and changes nothing. */
      planFirst: boolean;
      /** The effort setting: "low" | "medium" | "high" | "max", or "" for the model's own default. */
      effort: string;
      /** What the agent can reach: "проект + 2 папки". */
      access: string;
      /** The folders one per line, for the tooltip. */
      accessDetail: string;
    }
  | { type: "user"; text: string; chips: ChipView[] }
  | { type: "rules"; rules: RuleView[] }
  | { type: "text"; text: string }
  | { type: "activity"; text: string }
  | { type: "tool_start"; id: number; title: string; name: string }
  | { type: "tool_end"; id: number; result: string; isError: boolean }
  /** What a helper is doing now, shown on the card of its tool call. Not kept in the saved chat. */
  | { type: "tool_note"; id: number; text: string }
  | { type: "plan"; items: PlanItemView[] }
  | {
      type: "approval_request";
      id: string;
      kind: "write";
      relPath: string;
      created: boolean;
      diff: DiffView;
      /** A file that can run code later: shown as a warning, and "Always" is not offered. */
      warning?: string;
    }
  | {
      type: "approval_request";
      id: string;
      kind: "command";
      command: string;
      /** A command that can't be undone: shown as a warning, and "Always" is not offered. */
      warning?: string;
      /** What "Always" would remember: commands that begin like this, or only this one. */
      always?: { kind: "prefix" | "exact"; text: string };
      /** "Always" is offered despite the warning and lasts only until the new chat (a command that reads secret files). */
      untilNewChat?: boolean;
    }
  | {
      type: "approval_request";
      id: string;
      kind: "fetch";
      url: string;
      /** The site that "Always" would remember. */
      host: string;
      /** Shown as a warning, and "Always" is not offered. */
      warning?: string;
    }
  | {
      type: "approval_request";
      id: string;
      /** A paid picture: asked every time, "Always" is not offered. */
      kind: "image";
      prompt: string;
      relPath: string;
      model: string;
      /** The listed price of one picture, e.g. "4 ₽". */
      price?: string;
      warning?: string;
    }
  | {
      type: "approval_request";
      id: string;
      /** Starting a helper: the project's text goes to its model. */
      kind: "subagent";
      name: string;
      description: string;
      /** The service and model the helper runs on, as the user reads them. */
      service: string;
      model: string;
      external: boolean;
      task: string;
      warning?: string;
    }
  | { type: "approval_resolved"; id: string; decision: "allow" | "deny" | "allow_always" }
  /** A picture the agent made. The panel asks for its content with `load_picture`. */
  | { type: "picture"; relPath: string }
  /** `src` is a data: address, or null when the file is gone or too large to draw. */
  | { type: "picture_data"; relPath: string; src: string | null }
  | { type: "changes"; turn: number; files: ChangedFileView[] }
  | {
      type: "usage";
      tokens: string;
      cost: string;
      chatCost: string;
      context: string;
      /** The conversation is getting long; suggest a new chat. */
      contextWarning: boolean;
    }
  | { type: "busy"; busy: boolean }
  | { type: "error"; message: string; action?: { label: string; command: string } }
  | { type: "attachments"; chips: ChipView[] }
  | { type: "active_file"; label: string | null }
  | { type: "mentions"; query: string; items: string[] }
  /** A planning turn ended: offer to carry the plan out. */
  | { type: "plan_ready" }
  | { type: "focus_input" }
  | { type: "clear" }
  /** Redraws a saved chat: the same messages the panel got while it ran. */
  | { type: "restore"; items: ToWebview[] };

export type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  /** "Выполнить план": switches "plan first" off and tells the agent to go. */
  | { type: "run_plan" }
  | { type: "command"; command: string }
  | { type: "approval_response"; id: string; decision: "allow" | "deny" | "allow_always" }
  | { type: "open_diff"; id: string }
  | { type: "open_file"; relPath: string }
  | { type: "load_picture"; relPath: string }
  | { type: "revert"; turn: number; relPath: string | null }
  | { type: "pick_files" }
  | { type: "attach_active_file" }
  | { type: "attach_path"; relPath: string }
  | { type: "attach_uris"; uris: string[] }
  | { type: "attach_data"; name: string; mediaType: string; data: string }
  | { type: "remove_attachment"; id: string }
  | { type: "mention_query"; query: string };
