import { mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { executeTool, PermissionGate, type ApprovalDecision, type FileChange } from "@dimosi/core";
import { ChangeTracker } from "../src/changes";
import { editorFiles } from "../src/editorFiles";
import { minimalEdit } from "../src/textEdit";
import { stub, TextDocument, Uri, workspace } from "./e2e/vscode";

let root: string;
let decision: ApprovalDecision;
let changes: FileChange[];

function open(rel: string, text: string): TextDocument {
  const doc = new TextDocument(Uri.file(path.join(root, rel)), text);
  workspace.textDocuments.push(doc);
  return doc;
}

const run = (name: string, input: Record<string, unknown>) =>
  executeTool(
    { type: "tool_call", id: "1", name, input },
    { root, gate: new PermissionGate({ approve: async () => decision }), files: editorFiles, onFileChange: (c) => changes.push(c) },
  );

const disk = (rel: string) => fs.readFile(path.join(root, rel), "utf8");

beforeEach(() => {
  stub.reset();
  root = mkdtempSync(path.join(os.tmpdir(), "dimosi-editor-"));
  decision = "allow";
  changes = [];
});

describe("agent edits go through the open editor", () => {
  it("builds on unsaved edits, saves, and Ctrl+Z undoes only the agent's change", async () => {
    await fs.writeFile(path.join(root, "app.js"), "const a = 1;\nconst b = 2;\n");
    const doc = open("app.js", "const a = 1;\nconst b = 2;\n");
    doc.type("const a = 1;\nconst b = 2;\n// my unsaved note\n");

    const r = await run("edit_file", { path: "app.js", old_string: "const b = 2;", new_string: "const b = 3;" });
    expect(r.isError).toBe(false);
    const expected = "const a = 1;\nconst b = 3;\n// my unsaved note\n";
    expect(doc.getText()).toBe(expected);
    expect(await disk("app.js")).toBe(expected); // saved, so the disk agrees
    expect(doc.isDirty).toBe(false);
    expect(changes[0]).toMatchObject({ oldContent: "const a = 1;\nconst b = 2;\n// my unsaved note\n", newContent: expected });

    doc.undo();
    expect(doc.getText()).toBe("const a = 1;\nconst b = 2;\n// my unsaved note\n");
  });

  it("read_file shows the model the unsaved text, so its next edit matches", async () => {
    await fs.writeFile(path.join(root, "app.js"), "old line\n");
    open("app.js", "old line\n").type("typed but unsaved\n");
    const r = await run("read_file", { path: "app.js" });
    expect(r.content).toBe("1\ttyped but unsaved\n2\t");
    // A file in an old encoding can still be read, as before.
    await fs.writeFile(path.join(root, "cp.txt"), Buffer.from([0x41, 0xcf]));
    expect((await run("read_file", { path: "cp.txt" })).isError).toBe(false);
  });

  it("files that are not open are written on disk, like in the terminal", async () => {
    const r = await run("write_file", { path: "src/new.txt", content: "hi" });
    expect(r.isError).toBe(false);
    expect(await disk("src/new.txt")).toBe("hi");
  });

  it("a rejected change leaves the editor and the disk alone", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "old");
    const doc = open("a.txt", "old");
    doc.type("old, typed");
    decision = "deny";
    const r = await run("write_file", { path: "a.txt", content: "new" });
    expect(r.content).toMatch(/rejected/);
    expect(doc.getText()).toBe("old, typed");
    expect(doc.isDirty).toBe(true);
    expect(await disk("a.txt")).toBe("old");
  });

  it("keeps Windows line breaks in an open file", async () => {
    await fs.writeFile(path.join(root, "w.txt"), "one\r\ntwo\r\n");
    const doc = open("w.txt", "one\r\ntwo\r\n");
    const r = await run("edit_file", { path: "w.txt", old_string: "one\ntwo", new_string: "one\nTWO" });
    expect(r.isError).toBe(false);
    expect(doc.getText()).toBe("one\r\nTWO\r\n");
  });

  it("refuses files that are not UTF-8, open or not", async () => {
    await fs.writeFile(path.join(root, "cp.txt"), "text");
    const doc = open("cp.txt", "text");
    doc.encoding = "windows1251";
    const r1 = await run("edit_file", { path: "cp.txt", old_string: "text", new_string: "x" });
    expect(r1.content).toMatch(/not a UTF-8 text file/);
    expect(doc.getText()).toBe("text");

    await fs.writeFile(path.join(root, "bin.txt"), Buffer.from([0xcf, 0xf0, 0xe8]));
    open("bin.txt", "���");
    const r2 = await run("write_file", { path: "bin.txt", content: "x" });
    expect(r2.content).toMatch(/not a UTF-8 text file/);
  });

  it("still refuses .git and paths outside the project", async () => {
    expect((await run("write_file", { path: ".git/hooks/pre-commit", content: "x" })).content).toMatch(/\.git/);
    expect((await run("write_file", { path: "../evil.txt", content: "x" })).content).toMatch(/outside the project root/);
  });
});

describe("revert through the open editor", () => {
  it("restores the version before the agent, undoably", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "before");
    const doc = open("a.txt", "before");
    await run("write_file", { path: "a.txt", content: "agent" });
    const tracker = new ChangeTracker(editorFiles);
    tracker.record(changes[0]);

    expect(await tracker.revert("a.txt")).toEqual({ ok: true });
    expect(doc.getText()).toBe("before");
    expect(await disk("a.txt")).toBe("before");
    doc.undo(); // the revert itself can be undone too
    expect(doc.getText()).toBe("agent");
  });

  it("notices unsaved typing after the agent and asks before overwriting it", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "before");
    const doc = open("a.txt", "before");
    await run("write_file", { path: "a.txt", content: "agent" });
    const tracker = new ChangeTracker(editorFiles);
    tracker.record(changes[0]);
    doc.type("agent + my unsaved edit");
    expect(await tracker.revert("a.txt")).toMatchObject({ ok: false, reason: "modified_since" });
    expect(doc.getText()).toBe("agent + my unsaved edit");
  });
});

describe("minimalEdit", () => {
  it("replaces only the changed middle", () => {
    expect(minimalEdit("abcdef", "abXYef")).toEqual({ start: 2, end: 4, text: "XY" });
    expect(minimalEdit("abc", "abc")).toBeUndefined();
    expect(minimalEdit("", "new")).toEqual({ start: 0, end: 0, text: "new" });
    expect(minimalEdit("aaa", "aaaa")).toEqual({ start: 3, end: 3, text: "a" });
  });

  it("never cuts a Windows line break in half", () => {
    const e = minimalEdit("a\r\nb", "a\r\nc\r\nb")!;
    expect("a\r\nb".slice(0, e.start) + e.text + "a\r\nb".slice(e.end)).toBe("a\r\nc\r\nb");
    expect("a\r\nb"[e.start - 1]).not.toBe("\r");
    const f = minimalEdit("x\r\n", "x\n")!;
    expect("x\r\n".slice(0, f.start) + f.text + "x\r\n".slice(f.end)).toBe("x\n");
  });
});
