import { mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Message } from "@dimosi/core";
import { ChangeTracker } from "../src/changes";
import {
  CHAT_FORMAT,
  parseSavedChat,
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
