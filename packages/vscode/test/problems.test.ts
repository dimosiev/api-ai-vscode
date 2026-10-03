import { mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool, PermissionGate } from "@dimosi/core";
import { editorFiles } from "../src/editorFiles";
import { EditorProblems, type ProblemTimings } from "../src/problems";
import { DiagnosticSeverity, Position, Range, stub, Uri, type Diagnostic, type TextDocument } from "./e2e/vscode";

let root: string;
let problems: EditorProblems;

const at = (line: number) => new Range(new Position(line - 1, 0), new Position(line - 1, 5));
const error = (line: number, message: string, extra: Partial<Diagnostic> = {}): Diagnostic => ({ range: at(line), message, severity: DiagnosticSeverity.Error, ...extra });
const uri = (rel: string) => Uri.file(path.join(root, rel));

/** A checker for tests: every line with "BAD" is an error, every line with "hm" a warning. */
const check = (doc: TextDocument): Diagnostic[] =>
  doc.getText().split("\n").flatMap((text, i) =>
    text.includes("BAD")
      ? [error(i + 1, `Cannot find name '${text.trim()}'.`, { source: "ts", code: 2304 })]
      : text.includes("hm")
        ? [{ range: at(i + 1), message: "Unused.", severity: DiagnosticSeverity.Warning }]
        : [],
  );

const run = (name: string, input: Record<string, unknown>, opts: { signal?: AbortSignal; decision?: "allow" | "deny"; watcher?: EditorProblems } = {}) =>
  executeTool(
    { type: "tool_call", id: "1", name, input },
    { root, gate: new PermissionGate({ approve: async () => opts.decision ?? "allow" }), files: editorFiles, problems: (opts.watcher ?? problems).watch, signal: opts.signal },
  );

/** Waits so long that a test passes because a report arrived, never because time ran out. */
const PATIENT: ProblemTimings = { knownMs: 10_000, unknownMs: 10_000, quietMs: 40, minMs: 10_000, maxMs: 10_000 };
/** For files that stay clean: nothing arrives, so the wait must be short. */
const BRISK: Partial<ProblemTimings> = { knownMs: 60, unknownMs: 60, minMs: 60 };
const opened = () => stub.executed.filter((e) => e.id === "vscode.open").length;

beforeEach(() => {
  stub.reset();
  stub.check = check;
  root = mkdtempSync(path.join(os.tmpdir(), "dimosi-problems-"));
  problems = new EditorProblems(PATIENT);
});

afterEach(() => problems.dispose());

describe("the editor's errors after the agent changes a file", () => {
  it("are added to the result of write_file: errors only, with line and source", async () => {
    const r = await run("write_file", { path: "a.ts", content: "const y = 1; // hm\nBAD;\n  BAD2\n" });
    expect(r.isError).toBe(false);
    expect(r.content).toBe(
      "Created a.ts (3 lines).\n\n" +
        "The editor now reports 2 errors in this file (some may have been there before your change):\n" +
        "- line 2: Cannot find name 'BAD;'. (ts 2304)\n" +
        "- line 3: Cannot find name 'BAD2'. (ts 2304)",
    );
  });

  it("the file is put in a background tab for the check and the tab is closed again; the user's tab stays in front", async () => {
    await fs.writeFile(path.join(root, "mine.ts"), "ok\n");
    await stub.showFile(uri("mine.ts"));
    const r = await run("write_file", { path: "a.ts", content: "BAD\n" });
    expect(r.content).toContain("- line 1: Cannot find name 'BAD'.");
    expect(stub.executed.find((e) => e.id === "vscode.open")?.args[1]).toEqual({ background: true, preview: true, preserveFocus: true });
    expect(stub.tabs).toEqual(["mine.ts*"]);
  });

  it("a file the user already has in a tab is checked in place: no new tab, nothing closed", async () => {
    await fs.writeFile(path.join(root, "a.ts"), "const a = 1;\n");
    await fs.writeFile(path.join(root, "other.ts"), "ok\n");
    await stub.showFile(uri("a.ts"));
    await stub.showFile(uri("other.ts"));
    const r = await run("edit_file", { path: "a.ts", old_string: "= 1", new_string: "= BAD" });
    expect(r.content).toContain("Edited a.ts (1 replacement).");
    expect(r.content).toContain("The editor now reports 1 error in this file");
    expect(opened()).toBe(0);
    expect(stub.tabs).toEqual(["a.ts", "other.ts*"]);
  });

  it("with no editor open the checked file ends up in front and is left there", async () => {
    await run("write_file", { path: "a.ts", content: "BAD\n" });
    expect(stub.tabs).toEqual(["a.ts*(p)"]);
  });

  it("a clean file adds nothing, after a short wait", async () => {
    const brisk = new EditorProblems({ ...PATIENT, ...BRISK });
    const started = Date.now();
    expect((await run("write_file", { path: "a.ts", content: "const y = 1;\n" }, { watcher: brisk })).content).toBe("Created a.ts (1 lines).");
    expect(Date.now() - started).toBeLessThan(5000);
    brisk.dispose();
  });

  it("errors that were there before the change are replaced by the new report, not repeated", async () => {
    await fs.writeFile(path.join(root, "a.ts"), "BAD\n");
    await stub.showFile(uri("a.ts"));
    expect(await eventually(() => stub.diagnostics.get(uri("a.ts").toString())?.length === 1)).toBe(true);
    const r = await run("write_file", { path: "a.ts", content: "const x = 1;\n" });
    expect(r.content).toBe("Updated a.ts (1 lines).");
  });

  it("waits for a slow checker, and for a second report that follows the first", async () => {
    stub.checkDelayMs = 150;
    const first = await run("write_file", { path: "a.ts", content: "BAD\n" });
    expect(first.content).toContain("- line 1: Cannot find name 'BAD'.");
    // Syntax first (nothing), meaning a moment later (an error), inside the quiet time.
    stub.checkDelayMs = 5;
    await fs.writeFile(path.join(root, "b.ts"), "x\n");
    await stub.showFile(uri("b.ts"));
    stub.check = undefined;
    const pending = run("write_file", { path: "b.ts", content: "y\n" });
    await eventually(async () => (await fs.readFile(path.join(root, "b.ts"), "utf8")) === "y\n");
    stub.report(uri("b.ts"), [{ range: at(1), message: "Unused.", severity: DiagnosticSeverity.Warning }]);
    setTimeout(() => stub.report(uri("b.ts"), [error(1, "Cannot find name 'y'.")]), 10);
    expect((await pending).content).toContain("- line 1: Cannot find name 'y'.");
  });

  it("once a language has answered, a clean change waits about twice its usual delay, not the full time", async () => {
    const learning = new EditorProblems({ ...PATIENT, minMs: 50 });
    expect((await run("write_file", { path: "a.ts", content: "BAD\n" }, { watcher: learning })).content).toContain("Cannot find name");
    const started = Date.now();
    expect((await run("write_file", { path: "b.ts", content: "fine\n" }, { watcher: learning })).content).toBe("Created b.ts (1 lines).");
    expect(Date.now() - started).toBeLessThan(5000);
    learning.dispose();
  });

  it("Stop ends the wait at once", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = run("write_file", { path: "a.ts", content: "fine\n" }, { signal: controller.signal });
    // The file is clean, so nothing arrives; the wait would be 10 s.
    await eventually(() => opened() === 1);
    controller.abort();
    expect((await pending).content).toBe("Created a.ts (1 lines).");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("a language nobody checks is not waited for after a couple of changes, and no tab is opened for it", async () => {
    const brisk = new EditorProblems({ ...PATIENT, ...BRISK });
    stub.check = undefined;
    await fs.writeFile(path.join(root, "mine.ts"), "ok\n");
    await stub.showFile(uri("mine.ts"));
    for (let n = 1; n <= 4; n++) await run("write_file", { path: "notes.md", content: `v${n}\n` }, { watcher: brisk });
    expect(opened()).toBe(2);
    expect(stub.tabs).toEqual(["mine.ts*"]);

    // A Markdown checker gets installed and reports on a file the user looks at: the language is waited for again.
    stub.check = check;
    await fs.writeFile(path.join(root, "user.md"), "BAD\n");
    await stub.showFile(uri("user.md"));
    expect(await eventually(() => stub.diagnostics.get(uri("user.md").toString())?.length === 1)).toBe(true);
    expect((await run("write_file", { path: "notes.md", content: "BAD\n" }, { watcher: brisk })).content).toContain("- line 1: Cannot find name 'BAD'.");
    brisk.dispose();
  });

  it("a rejected or failed write leaves nobody listening", async () => {
    await run("write_file", { path: "a.ts", content: "x" }, { decision: "deny" });
    const failing = { ...editorFiles, writeText: async () => Promise.reject(new Error("disk full")) };
    const r = await executeTool(
      { type: "tool_call", id: "1", name: "write_file", input: { path: "b.ts", content: "x" } },
      { root, gate: new PermissionGate({ approve: async () => "allow" }), files: failing, problems: problems.watch },
    );
    expect(r).toMatchObject({ isError: true, content: "disk full" });
    expect((problems as unknown as { watchers: Map<string, unknown> }).watchers.size).toBe(0);
    expect(opened()).toBe(0);
  });
});

/** Polls a condition: a busy machine (CI) is slower. */
async function eventually(check: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}
