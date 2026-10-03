import { existsSync, mkdtempSync, promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool, PermissionGate } from "@dimosi/core";
import { editorFiles } from "../src/editorFiles";
import { EditorProblems } from "../src/problems";
import { DiagnosticSeverity, Position, Range, stub, Uri, type Diagnostic } from "./e2e/vscode";

let root: string;
let problems: EditorProblems;

const at = (line: number) => new Range(new Position(line - 1, 0), new Position(line - 1, 5));
const error = (line: number, message: string, extra: Partial<Diagnostic> = {}): Diagnostic => ({ range: at(line), message, severity: DiagnosticSeverity.Error, ...extra });
const uri = (rel: string) => Uri.file(path.join(root, rel));

const run = (name: string, input: Record<string, unknown>, signal?: AbortSignal, decision: "allow" | "deny" = "allow") =>
  executeTool(
    { type: "tool_call", id: "1", name, input },
    { root, gate: new PermissionGate({ approve: async () => decision }), files: editorFiles, problems: problems.watch, signal },
  );

/** A language service: answers a little after the file changes on disk, like the real ones. */
function languageService(rel: string, ...answers: Diagnostic[][]): { stop(): void } {
  const file = path.join(root, rel);
  let last = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const timer = setInterval(async () => {
    const text = await fs.readFile(file, "utf8").catch(() => undefined);
    if (text === undefined || text === last || !answers.length) return;
    last = text;
    stub.report(uri(rel), answers.shift()!);
  }, 5);
  return { stop: () => clearInterval(timer) };
}

let service: { stop(): void } | undefined;

beforeEach(() => {
  stub.reset();
  root = mkdtempSync(path.join(os.tmpdir(), "dimosi-problems-"));
  // Long waits: a test passes because a report arrived, never because time ran out.
  problems = new EditorProblems({ firstMs: 10_000, unknownMs: 10_000, quietMs: 50, totalMs: 20_000 });
});

afterEach(() => {
  service?.stop();
  service = undefined;
  problems.dispose();
});

describe("the editor's errors after the agent changes a file", () => {
  it("are added to the result of write_file: errors only, with line and source", async () => {
    service = languageService("a.ts", [
      error(2, "Cannot find name 'x'.", { source: "ts", code: 2304 }),
      { range: at(1), message: "'y' is declared but never used.", severity: DiagnosticSeverity.Warning },
      error(3, "Unexpected   token.\nDid you mean `}`?", { source: "eslint", code: { value: "parse" } }),
    ]);
    const r = await run("write_file", { path: "a.ts", content: "const y = 1;\nx;\n}\n" });
    expect(r.isError).toBe(false);
    expect(r.content).toBe(
      "Created a.ts (3 lines).\n\n" +
        "The editor now reports 2 errors in this file (some may have been there before your change):\n" +
        "- line 2: Cannot find name 'x'. (ts 2304)\n" +
        "- line 3: Unexpected token. Did you mean `}`? (eslint parse)",
    );
  });

  it("are added to the result of edit_file", async () => {
    await fs.writeFile(path.join(root, "a.ts"), "const a = 1;\n");
    service = languageService("a.ts", [error(1, "Type 'string' is not assignable to type 'number'.")]);
    await run("read_file", { path: "a.ts" });
    const r = await run("edit_file", { path: "a.ts", old_string: "= 1", new_string: "= 'one' as number" });
    expect(r.content).toContain("Edited a.ts (1 replacement).");
    expect(r.content).toContain("The editor now reports 1 error in this file");
    expect(r.content).toContain("- line 1: Type 'string' is not assignable to type 'number'.");
  });

  it("a clean file adds nothing", async () => {
    service = languageService("a.ts", []);
    expect((await run("write_file", { path: "a.ts", content: "const y = 1;\n" })).content).toBe("Created a.ts (1 lines).");
  });

  it("waits for the reports to settle: syntax first, meaning a moment later", async () => {
    await fs.writeFile(path.join(root, "a.ts"), "old\n");
    const file = uri("a.ts");
    // The second report comes inside the quiet time after the first one.
    const firstReport = setInterval(async () => {
      if ((await fs.readFile(file.fsPath, "utf8")) === "old\n") return;
      clearInterval(firstReport);
      stub.report(file, []);
      setTimeout(() => stub.report(file, [error(1, "Cannot find name 'x'.")]), 10);
    }, 5);
    const r = await run("write_file", { path: "a.ts", content: "x;\n" });
    expect(r.content).toContain("- line 1: Cannot find name 'x'.");
  });

  it("errors that were there before the change are replaced by the new report, not repeated", async () => {
    await fs.writeFile(path.join(root, "a.ts"), "x;\n");
    stub.report(uri("a.ts"), [error(1, "Cannot find name 'x'.")]);
    service = languageService("a.ts", []);
    const r = await run("write_file", { path: "a.ts", content: "const x = 1;\n" });
    expect(r.content).toBe("Updated a.ts (1 lines).");
  });

  it("Stop ends the wait at once", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = run("write_file", { path: "notes.txt", content: "hi\n" }, controller.signal);
    // No language service answers; the wait would be 10 s.
    while (!(await fs.readFile(path.join(root, "notes.txt"), "utf8").catch(() => ""))) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    expect((await pending).content).toBe("Created notes.txt (1 lines).");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("a language that never reports is not waited for after a couple of changes, until it reports", async () => {
    const quick = new EditorProblems({ firstMs: 10_000, unknownMs: 30, quietMs: 30, totalMs: 20_000 });
    const write = (n: number) =>
      executeTool(
        { type: "tool_call", id: "1", name: "write_file", input: { path: "notes.md", content: `v${n}\n` } },
        { root, gate: new PermissionGate({ approve: async () => "allow" }), files: editorFiles, problems: quick.watch },
      );
    await write(1);
    await write(2);
    // From here on a wait would take 10 s if the language were thought to report.
    const started = Date.now();
    await write(3);
    await write(4);
    expect(Date.now() - started).toBeLessThan(5000);
    // A Markdown checker is installed and reports: now it is waited for again.
    service = languageService("notes.md", [error(1, "Heading expected.")]);
    stub.report(uri("notes.md"), []);
    expect((await write(5)).content).toContain("- line 1: Heading expected.");
    quick.dispose();
  });

  it("a rejected or failed write leaves nobody listening", async () => {
    await run("write_file", { path: "a.ts", content: "x" }, undefined, "deny");
    const failing = { ...editorFiles, writeText: async () => Promise.reject(new Error("disk full")) };
    const r = await executeTool(
      { type: "tool_call", id: "1", name: "write_file", input: { path: "b.ts", content: "x" } },
      { root, gate: new PermissionGate({ approve: async () => "allow" }), files: failing, problems: problems.watch },
    );
    expect(r).toMatchObject({ isError: true, content: "disk full" });
    stub.report(uri("b.ts"), [error(1, "late")]);
    expect((problems as unknown as { watchers: Map<string, unknown> }).watchers.size).toBe(0);
  });
});
