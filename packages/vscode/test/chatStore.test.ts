import { mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Message } from "@dimosi/core";
import { ChangeTracker } from "../src/changes";
import {
  archiveChat,
  CHAT_FORMAT,
  chatTitle,
  deleteArchivedChat,
  listChats,
  parseSavedChat,
  readArchivedChat,
  unarchiveChat,
  readChatFile,
  restoredTranscript,
  serializeChat,
  Transcript,
  writeChatFile,
  type SavedChat,
} from "../src/chatStore";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "dimosi-chat-"));
const claudeRaw = [{ type: "thinking", thinking: "x", signature: "s==" }, { type: "text", text: "Готово." }];

function chat(root: string, extra: Partial<SavedChat> = {}): SavedChat {
  const messages: Message[] = [
    { role: "user", parts: [{ type: "text", text: "привет" }] },
    { role: "assistant", parts: [{ type: "text", text: "Готово." }], providerData: { provider: "anthropic", model: "m", raw: claudeRaw } },
  ];
  return { format: CHAT_FORMAT, root, turn: 1, messages, transcript: [{ type: "user", text: "привет", chips: [] }], trackers: [], interrupted: false, ...extra };
}

describe("Transcript", () => {
  it("merges streamed text and keeps only the latest plan and revert card", () => {
    const t = new Transcript();
    t.add({ type: "user", text: "задача", chips: [] });
    t.add({ type: "activity", text: "Думает…" }); // transient, not kept
    t.add({ type: "text", text: "При" });
    t.add({ type: "text", text: "вет" });
    t.add({ type: "plan", items: [{ title: "Шаг", status: "in_progress" }] });
    t.add({ type: "plan", items: [{ title: "Шаг", status: "done" }] });
    t.add({ type: "changes", turn: 1, files: [] });
    t.add({ type: "changes", turn: 1, files: [{ relPath: "a", added: 1, removed: 0, created: true, reverted: true, unavailable: false }] });
    expect(t.items).toEqual([
      { type: "user", text: "задача", chips: [] },
      { type: "text", text: "Привет" },
      { type: "plan", items: [{ title: "Шаг", status: "done" }] },
      { type: "changes", turn: 1, files: [{ relPath: "a", added: 1, removed: 0, created: true, reverted: true, unavailable: false }] },
    ]);
  });

  it("a snapshot mid-task declines open questions and shows the task's revert card", () => {
    const t = new Transcript();
    t.add({ type: "user", text: "задача", chips: [] });
    t.add({ type: "approval_request", id: "a1", kind: "command", command: "npm test" });
    const tracker = new ChangeTracker();
    tracker.record({ path: "/p/a.txt", relPath: "a.txt", oldContent: null, newContent: "x" });
    const snap = t.snapshot({ turn: 3, tracker });
    expect(snap.slice(1)).toEqual([
      { type: "approval_request", id: "a1", kind: "command", command: "npm test" },
      { type: "approval_resolved", id: "a1", decision: "deny" },
      { type: "changes", turn: 3, files: tracker.summary() },
    ]);
    expect(t.items).toHaveLength(2); // the live transcript is not changed
  });
});

describe("chat file", () => {
  it("round-trips and keeps Claude's original content byte for byte", async () => {
    const dir = tmp();
    const file = path.join(dir, "store", "chat.json");
    await writeChatFile(file, serializeChat(chat(dir)).text!);
    const loaded = await readChatFile(file, dir);
    expect(loaded).toEqual(chat(dir));
    expect(JSON.stringify(loaded!.messages[1].providerData!.raw)).toBe(JSON.stringify(claudeRaw));
    expect(await fs.readdir(path.dirname(file))).toEqual(["chat.json"]); // no temp files left
  });

  it("a damaged, foreign or old-format file starts a new chat instead of failing", async () => {
    const dir = tmp();
    const file = path.join(dir, "chat.json");
    expect(await readChatFile(file, dir)).toBeUndefined(); // missing
    await fs.writeFile(file, "{ not json");
    expect(await readChatFile(file, dir)).toBeUndefined();
    await fs.writeFile(file, '{"format":1,"root":"/x"');
    expect(await readChatFile(file, dir)).toBeUndefined(); // cut off mid-write
    expect(parseSavedChat(chat(dir), "/other/folder")).toBeUndefined();
    expect(parseSavedChat({ ...chat(dir), format: 99 }, dir)).toBeUndefined();
    expect(parseSavedChat({ ...chat(dir), messages: [{ role: "bot", parts: [] }] }, dir)).toBeUndefined();
    expect(parseSavedChat({ ...chat(dir), transcript: [{ type: "status" }] }, dir)).toBeUndefined();
    expect(parseSavedChat({ ...chat(dir), trackers: [{ turn: 1, files: [{ relPath: 1 }] }] }, dir)).toBeUndefined();
    expect(parseSavedChat(null, dir)).toBeUndefined();
  });

  it("over the size limit drops pictures first, then revert originals, and marks revert unavailable", () => {
    const dir = tmp();
    const tracker = new ChangeTracker();
    tracker.record({ path: path.join(dir, "big.txt"), relPath: "big.txt", oldContent: "o".repeat(3000), newContent: "new" });
    tracker.record({ path: path.join(dir, "made.txt"), relPath: "made.txt", oldContent: null, newContent: "new" });
    const base = chat(dir, { trackers: [{ turn: 1, ...tracker.toJSON() }] });
    base.messages[0].parts.push({ type: "image", mediaType: "image/png", data: "A".repeat(4000) });
    const full = Buffer.byteLength(JSON.stringify(base));

    // Room for everything except the picture.
    const noImage = parseSavedChat(JSON.parse(serializeChat(base, full - 3000).text!), dir)!;
    expect(noImage.messages[0].parts.some((p) => p.type === "image")).toBe(false);
    expect(noImage.trackers[0].files[0].original).toHaveLength(3000);
    expect(noImage.messages[1]).toEqual(base.messages[1]); // Claude's message untouched

    // Not even room for the original version of big.txt.
    const small = parseSavedChat(JSON.parse(serializeChat(base, full - 6000).text!), dir)!;
    const restored = ChangeTracker.fromJSON(small.trackers[0]);
    expect(restored.summary()).toEqual([
      { relPath: "big.txt", added: 1, removed: 1, created: false, reverted: false, unavailable: true },
      { relPath: "made.txt", added: 1, removed: 0, created: true, reverted: false, unavailable: false },
    ]);
    expect(restored.revertible()).toEqual(["made.txt"]);
    expect(base.messages[0].parts.some((p) => p.type === "image")).toBe(true); // the live chat is not changed

    expect(serializeChat(base, 100)).toEqual({ dropped: ["pictures", "revert originals", "old tool output", "long tool output in the panel", "the whole chat"] });
  });

  it("revert keeps working after a reload", async () => {
    const dir = tmp();
    const file = path.join(dir, "a.txt");
    await fs.writeFile(file, "agent");
    const before = new ChangeTracker();
    before.record({ path: file, relPath: "a.txt", oldContent: "orig", newContent: "agent" });
    const after = ChangeTracker.fromJSON(JSON.parse(JSON.stringify(before.toJSON())));
    expect(await after.revert("a.txt")).toEqual({ ok: true });
    expect(await fs.readFile(file, "utf8")).toBe("orig");
  });

  it("an unavailable revert refuses and leaves the file alone", async () => {
    const dir = tmp();
    const file = path.join(dir, "a.txt");
    await fs.writeFile(file, "agent");
    const t = new ChangeTracker();
    t.record({ path: file, relPath: "a.txt", oldContent: "orig", newContent: "agent" });
    const saved = t.toJSON();
    saved.files[0].original = null;
    saved.files[0].unavailable = true;
    const r = await ChangeTracker.fromJSON(saved).revert("a.txt");
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("откат недоступен") });
    expect(await fs.readFile(file, "utf8")).toBe("agent");
  });

  it("a chat saved mid-task says so, and its revert cards show what can still be undone", () => {
    const dir = tmp();
    const t = new ChangeTracker();
    t.record({ path: path.join(dir, "a.txt"), relPath: "a.txt", oldContent: null, newContent: "x" });
    const saved = chat(dir, {
      interrupted: true,
      transcript: [
        { type: "user", text: "задача", chips: [] },
        { type: "approval_request", id: "a1", kind: "command", command: "ls" },
        { type: "changes", turn: 1, files: [] },
      ],
    });
    const items = restoredTranscript(saved, new Map([[1, t]]));
    expect(items).toContainEqual({ type: "approval_resolved", id: "a1", decision: "deny" });
    expect(items).toContainEqual({ type: "changes", turn: 1, files: t.summary() });
    expect(items.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("перезагрузили") });
  });
});

describe("earlier chats", () => {
  /** A folder's storage with a current chat written `n` times and put away each time. */
  async function store(n: number, max?: number, keep?: (ids: string[]) => string | undefined) {
    const root = tmp();
    const file = path.join(root, "store", "chat.json");
    const dir = path.join(root, "store", "chats");
    const ids: string[] = [];
    for (let i = 1; i <= n; i++) {
      await writeChatFile(file, serializeChat(chat(root, { transcript: [{ type: "user", text: `чат ${i}`, chips: [] }] })).text!);
      ids.push((await archiveChat(file, dir, { title: `чат ${i}`, savedAt: i, tasks: 1 }, { max, keep: keep?.(ids) }))!);
    }
    return { root, file, dir, ids };
  }

  it("the title is the first message on one line, shortened", () => {
    expect(chatTitle([{ type: "text", text: "x" }, { type: "user", text: "  исправь\n ошибку  в app.js ", chips: [] }])).toBe("исправь ошибку в app.js");
    expect(chatTitle([{ type: "user", text: "я".repeat(200), chips: [] }])).toBe(`${"я".repeat(79)}…`);
    expect(chatTitle([{ type: "user", text: "", chips: [{ id: "a", label: "a.png", kind: "image" }] }])).toBe("(сообщение с вложениями)");
  });

  it("a chat is moved, not copied; the list is newest first and reads no chat", async () => {
    const { root, file, dir, ids } = await store(3);
    await expect(fs.access(file)).rejects.toThrow();
    expect((await listChats(dir)).map((c) => c.title)).toEqual(["чат 3", "чат 2", "чат 1"]);
    // Listing works from the index alone: the chats themselves may be huge.
    for (const id of ids) await fs.writeFile(path.join(dir, `${id}.json`), "{ not json");
    expect((await listChats(dir)).map((c) => [c.title, c.tasks])).toEqual([["чат 3", 1], ["чат 2", 1], ["чат 1", 1]]);
    expect(await readArchivedChat(dir, ids[0], root)).toBeUndefined(); // and a damaged one is not opened
  });

  it("opening moves the chat back byte for byte and takes it off the list", async () => {
    const { root, file, dir, ids } = await store(2);
    await unarchiveChat(dir, ids[0], file);
    const loaded = await readChatFile(file, root);
    expect(loaded?.transcript).toEqual([{ type: "user", text: "чат 1", chips: [] }]);
    expect(JSON.stringify(loaded!.messages[1].providerData!.raw)).toBe(JSON.stringify(claudeRaw));
    expect((await listChats(dir)).map((c) => c.title)).toEqual(["чат 2"]);
    expect((await fs.readdir(dir)).sort()).toEqual([`${ids[1]}.json`, "index.json"].sort());
  });

  it("beyond the limit the oldest chats are deleted, but never the one being opened", async () => {
    const plain = await store(4, 2);
    expect((await listChats(plain.dir)).map((c) => c.title)).toEqual(["чат 4", "чат 3"]);
    expect(await fs.readdir(plain.dir)).toHaveLength(3); // two chats and the index

    const kept = await store(4, 2, (ids) => ids[0]);
    expect((await listChats(kept.dir)).map((c) => c.title)).toEqual(["чат 4", "чат 3", "чат 1"]);
  });

  it("deleting removes the file and the entry; nothing to put away is not an error", async () => {
    const { file, dir, ids } = await store(2);
    await deleteArchivedChat(dir, ids[1]);
    expect((await listChats(dir)).map((c) => c.title)).toEqual(["чат 1"]);
    expect(await archiveChat(file, dir, { title: "нет файла", savedAt: 9, tasks: 1 })).toBeUndefined();
    expect((await listChats(dir)).map((c) => c.title)).toEqual(["чат 1"]);
    expect(await listChats(path.join(dir, "missing"))).toEqual([]);
  });

  it("a lost or damaged index is rebuilt from the chats; an entry without a file is dropped", async () => {
    const { dir, ids } = await store(2);
    await fs.writeFile(path.join(dir, "index.json"), "{ not json");
    expect((await listChats(dir)).map((c) => [c.title, c.tasks]).sort()).toEqual([["чат 1", 1], ["чат 2", 1]]);
    await fs.rm(path.join(dir, `${ids[0]}.json`));
    expect((await listChats(dir)).map((c) => c.title)).toEqual(["чат 2"]);
    // A file that is not a chat is listed as unreadable once, so it can be deleted, and is not read again.
    await fs.writeFile(path.join(dir, "zzzzzzzz-0123abcd.json"), "{ not json");
    expect((await listChats(dir)).map((c) => c.title)).toEqual(["чат 2", "(чат не удалось прочитать)"]);
    expect(JSON.parse(await fs.readFile(path.join(dir, "index.json"), "utf8")).chats).toHaveLength(2);
  });

  it("an id that is not one of ours never becomes a path", async () => {
    const { root, file, dir } = await store(1);
    for (const id of ["../chat", "index", "a/b", "..", ""]) {
      await expect(unarchiveChat(dir, id, file)).rejects.toThrow("Неизвестный чат.");
      await expect(deleteArchivedChat(dir, id)).rejects.toThrow("Неизвестный чат.");
      expect(await readArchivedChat(dir, id, root)).toBeUndefined();
    }
    expect(await listChats(dir)).toHaveLength(1);
  });
});
