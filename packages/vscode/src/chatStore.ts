// Saves the last chat of a folder so it survives a window reload. Must not
// import "vscode": tested directly.
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseMessages, stripImages, trimToolResults, type Message } from "@dimosi/core";
import { ChangeTracker, dropOriginals, type SavedTracker } from "./changes";
import type { ToWebview } from "./protocol";

export const CHAT_FORMAT = 1;
export const MAX_CHAT_BYTES = 20 * 1024 * 1024;

export interface SavedChat {
  format: typeof CHAT_FORMAT;
  /** The project folder; a chat is never restored into another one. */
  root: string;
  /** Last task number, so new revert cards don't clash with restored ones. */
  turn: number;
  messages: Message[];
  /** What the panel showed, replayed on restore. */
  transcript: ToWebview[];
  trackers: Array<{ turn: number } & SavedTracker>;
  /** Saved while the agent was still working. */
  interrupted: boolean;
}

/** Panel messages that make up the visible chat; the rest is transient state. */
const RECORDED = new Set<ToWebview["type"]>([
  "user",
  "text",
  "tool_start",
  "tool_end",
  "plan",
  "approval_request",
  "approval_resolved",
  "changes",
  "error",
]);

/** The visible chat as a list of panel messages, kept compact. */
export class Transcript {
  items: ToWebview[] = [];

  add(msg: ToWebview): void {
    if (!RECORDED.has(msg.type)) return;
    const last = this.items.at(-1);
    if (msg.type === "text" && last?.type === "text") {
      this.items[this.items.length - 1] = { type: "text", text: last.text + msg.text };
      return;
    }
    // Only the latest plan of a task and the latest state of a revert card matter.
    const replace =
      msg.type === "plan"
        ? this.indexSinceLastUser((m) => m.type === "plan")
        : msg.type === "changes"
          ? this.items.findIndex((m) => m.type === "changes" && m.turn === msg.turn)
          : -1;
    if (replace >= 0) this.items[replace] = msg;
    else this.items.push(msg);
  }

  clear(): void {
    this.items = [];
  }

  /**
   * The chat as it would look if the running task stopped now: unanswered
   * questions count as declined, and the task's revert card is shown.
   */
  snapshot(running?: { turn: number; tracker: ChangeTracker }): ToWebview[] {
    const items = resolvePending(this.items);
    if (running && !running.tracker.isEmpty && !items.some((m) => m.type === "changes" && m.turn === running.turn)) {
      items.push({ type: "changes", turn: running.turn, files: running.tracker.summary() });
    }
    return items;
  }

  private indexSinceLastUser(match: (m: ToWebview) => boolean): number {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].type === "user") return -1;
      if (match(this.items[i])) return i;
    }
    return -1;
  }
}

function resolvePending(items: ToWebview[]): ToWebview[] {
  const resolved = new Set(items.flatMap((m) => (m.type === "approval_resolved" ? [m.id] : [])));
  const out: ToWebview[] = [];
  for (const m of items) {
    out.push(m);
    if (m.type === "approval_request" && !resolved.has(m.id)) out.push({ type: "approval_resolved", id: m.id, decision: "deny" });
  }
  return out;
}

/**
 * JSON for the chat file, fitted into `maxBytes`. When too big, drops in
 * order: pictures, the originals kept for revert (those files then show
 * "revert unavailable"), old tool output, long tool output in the panel.
 * Undefined when even that does not fit.
 */
export function serializeChat(chat: SavedChat, maxBytes = MAX_CHAT_BYTES): string | undefined {
  let text = JSON.stringify(chat);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const copy: SavedChat = structuredClone(chat);
  const steps = [
    () => stripImages(copy.messages),
    () => copy.trackers.forEach(dropOriginals),
    () => trimToolResults(copy.messages, 0),
    () => {
      copy.transcript = copy.transcript.map((m) =>
        m.type === "tool_end" ? { ...m, result: m.result.slice(0, 300) }
        : m.type === "approval_request" && m.kind === "write" ? { ...m, diff: { ...m.diff, rows: m.diff.rows.slice(0, 40), truncated: true } }
        : m,
      );
    },
  ];
  for (const step of steps) {
    step();
    text = JSON.stringify(copy);
    if (Buffer.byteLength(text) <= maxBytes) return text;
  }
  return undefined;
}

/** Writes through a temporary file, so a crash never leaves half a chat. */
export async function writeChatFile(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

export async function deleteChatFile(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}

/**
 * Loads the saved chat of `root`. Anything missing, damaged or from another
 * format gives undefined: the user simply gets a new chat.
 */
export async function readChatFile(file: string, root: string): Promise<SavedChat | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
  return parseSavedChat(raw, root);
}

export function parseSavedChat(raw: unknown, root: string): SavedChat | undefined {
  const c = raw as Partial<SavedChat> | null;
  if (!c || typeof c !== "object" || c.format !== CHAT_FORMAT || c.root !== root) return undefined;
  if (!Number.isInteger(c.turn) || typeof c.interrupted !== "boolean") return undefined;
  const messages = parseMessages(c.messages);
  if (!messages) return undefined;
  if (!Array.isArray(c.transcript) || !c.transcript.every((m) => m && typeof m === "object" && RECORDED.has(m.type))) return undefined;
  if (!Array.isArray(c.trackers)) return undefined;
  const trackers: SavedChat["trackers"] = [];
  for (const t of c.trackers) {
    const parsed = ChangeTracker.parse(t);
    if (!parsed || !Number.isInteger(t?.turn)) return undefined;
    trackers.push({ turn: t.turn, ...parsed });
  }
  return { format: CHAT_FORMAT, root, turn: c.turn!, messages, transcript: c.transcript, trackers, interrupted: c.interrupted };
}

/** The panel messages for a restored chat, with revert cards matching what can still be undone. */
export function restoredTranscript(chat: SavedChat, trackers: Map<number, ChangeTracker>): ToWebview[] {
  const items = resolvePending(chat.transcript).map((m) =>
    m.type === "changes" && trackers.has(m.turn) ? { ...m, files: trackers.get(m.turn)!.summary() } : m,
  );
  if (chat.interrupted) {
    items.push({ type: "error", message: "Задача прервалась: окно VS Code перезагрузили. Напишите «продолжай», чтобы агент продолжил." });
  }
  return items;
}
