// Saves the current chat of a folder so it survives a window reload, and keeps
// the earlier chats next to it. Must not import "vscode": tested directly.
import { randomBytes } from "node:crypto";
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
  "picture",
  "error",
  "plan_ready",
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
 * `text` is undefined when even that does not fit; `dropped` names what
 * was left out.
 */
export function serializeChat(chat: SavedChat, maxBytes = MAX_CHAT_BYTES): { text?: string; dropped: string[] } {
  let text = JSON.stringify(chat);
  if (Buffer.byteLength(text) <= maxBytes) return { text, dropped: [] };
  const copy: SavedChat = structuredClone(chat);
  const dropped: string[] = [];
  const steps: Array<[string, () => void]> = [
    ["pictures", () => stripImages(copy.messages)],
    ["revert originals", () => copy.trackers.forEach(dropOriginals)],
    ["old tool output", () => trimToolResults(copy.messages, 0)],
    ["long tool output in the panel", () => {
      copy.transcript = copy.transcript.map((m) =>
        m.type === "tool_end" ? { ...m, result: m.result.slice(0, 300) }
        : m.type === "approval_request" && m.kind === "write" ? { ...m, diff: { ...m.diff, rows: m.diff.rows.slice(0, 40), truncated: true } }
        : m,
      );
    }],
  ];
  for (const [name, step] of steps) {
    step();
    dropped.push(name);
    text = JSON.stringify(copy);
    if (Buffer.byteLength(text) <= maxBytes) return { text, dropped };
  }
  return { dropped: [...dropped, "the whole chat"] };
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

// ---------- earlier chats ----------
//
// The current chat is `chat.json`. "New chat" moves it into `chats/<id>.json`;
// opening an earlier chat moves it back. `chats/index.json` holds what the list
// shows, so that listing never reads the chats themselves (up to 20 MB each).

export const MAX_ARCHIVED_CHATS = 30;
const INDEX_FILE = "index.json";
const CHAT_ID = /^[a-z0-9]+-[a-f0-9]{8}$/;

export interface ChatInfo {
  id: string;
  /** The first message of the chat, one line. */
  title: string;
  /** When the chat was put away, ms. */
  savedAt: number;
  /** How many messages the user sent. */
  tasks: number;
}

/** What the list calls a chat: its first message, shortened to one line. */
export function chatTitle(transcript: ToWebview[]): string {
  const first = transcript.find((m) => m.type === "user");
  const text = first?.type === "user" ? first.text.replace(/\s+/g, " ").trim() : "";
  if (!text) return first ? "(сообщение с вложениями)" : "(пустой чат)";
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

export const countTasks = (transcript: ToWebview[]): number => transcript.filter((m) => m.type === "user").length;

const archivedFile = (dir: string, id: string) => path.join(dir, `${id}.json`);

async function readIndex(dir: string): Promise<ChatInfo[]> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, INDEX_FILE), "utf8")) as { chats?: unknown };
    if (!Array.isArray(raw?.chats)) return [];
    return raw.chats.filter(
      (c): c is ChatInfo => c && typeof c === "object" && typeof c.id === "string" && CHAT_ID.test(c.id) && typeof c.title === "string" && Number.isFinite(c.savedAt) && Number.isInteger(c.tasks),
    );
  } catch {
    return [];
  }
}

const writeIndex = (dir: string, chats: ChatInfo[]) => writeChatFile(path.join(dir, INDEX_FILE), JSON.stringify({ chats }));

/**
 * The earlier chats, newest first. The files are the truth and the index is a
 * note about them: an entry without a file is dropped, a file without an entry
 * (the index was lost) is read once and gets one.
 */
export async function listChats(dir: string): Promise<ChatInfo[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const onDisk = new Set(names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter((id) => CHAT_ID.test(id)));
  const index = await readIndex(dir);
  const chats = index.filter((c) => onDisk.has(c.id));
  const known = new Set(chats.map((c) => c.id));
  for (const id of onDisk) {
    if (known.has(id)) continue;
    let info: ChatInfo = { id, title: "(чат не удалось прочитать)", savedAt: 0, tasks: 0 };
    try {
      const file = archivedFile(dir, id);
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as Partial<SavedChat>;
      const transcript = Array.isArray(raw.transcript) ? raw.transcript : [];
      info = { id, title: chatTitle(transcript), savedAt: (await fs.stat(file)).mtimeMs, tasks: countTasks(transcript) };
    } catch {
      // Listed as unreadable: the user can delete it, and it is not read again.
    }
    chats.push(info);
  }
  chats.sort((a, b) => b.savedAt - a.savedAt);
  if (chats.length !== index.length || chats.some((c, i) => c.id !== index[i].id)) await writeIndex(dir, chats).catch(() => undefined);
  return chats;
}

/**
 * Puts the current chat away: `file` becomes `dir/<id>.json`. Beyond `max`
 * chats the oldest are deleted, except `keep`. Returns the id, or undefined
 * when there was no file to put away.
 */
export async function archiveChat(file: string, dir: string, info: Omit<ChatInfo, "id">, opts: { max?: number; keep?: string } = {}): Promise<string | undefined> {
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.rename(file, archivedFile(dir, id));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const chats = [{ id, ...info }, ...(await listChats(dir)).filter((c) => c.id !== id)].sort((a, b) => b.savedAt - a.savedAt);
  const max = opts.max ?? MAX_ARCHIVED_CHATS;
  const kept: ChatInfo[] = [];
  for (const c of chats) {
    if (kept.length < max || c.id === opts.keep) kept.push(c);
    else await fs.rm(archivedFile(dir, c.id), { force: true });
  }
  await writeIndex(dir, kept);
  return id;
}

/** Makes an earlier chat the current one: `dir/<id>.json` becomes `file`. */
export async function unarchiveChat(dir: string, id: string, file: string): Promise<void> {
  if (!CHAT_ID.test(id)) throw new Error("Неизвестный чат.");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.rename(archivedFile(dir, id), file);
  await writeIndex(dir, (await readIndex(dir)).filter((c) => c.id !== id));
}

export async function deleteArchivedChat(dir: string, id: string): Promise<void> {
  if (!CHAT_ID.test(id)) throw new Error("Неизвестный чат.");
  await fs.rm(archivedFile(dir, id), { force: true });
  await writeIndex(dir, (await readIndex(dir)).filter((c) => c.id !== id));
}

/** An earlier chat, checked like the current one; undefined when it cannot be opened. */
export function readArchivedChat(dir: string, id: string, root: string): Promise<SavedChat | undefined> {
  return CHAT_ID.test(id) ? readChatFile(archivedFile(dir, id), root) : Promise.resolve(undefined);
}
