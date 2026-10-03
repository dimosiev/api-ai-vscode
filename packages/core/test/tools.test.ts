import { mkdtempSync, promises as fs, symlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { executeTool, PermissionGate, type ApprovalDecision, type ApprovalRequest, type FileProblem, type ProblemWatcher } from "../src";

let root: string;
let requests: ApprovalRequest[];
let decision: ApprovalDecision;

const gate = () =>
  new PermissionGate({
    approve: async (req) => {
      requests.push(req);
      return decision;
    },
  });

const call = (name: string, input: Record<string, unknown>, g = gate()) =>
  executeTool({ type: "tool_call", id: "1", name, input }, { root, gate: g });

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "dimosi-tools-"));
  requests = [];
  decision = "allow";
  await fs.writeFile(path.join(root, "a.txt"), "one\ntwo\ntwo\n");
});

describe("path safety", () => {
  it("rejects paths outside the project root", async () => {
    const r = await call("read_file", { path: "../../etc/passwd" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/outside the project root/);
  });

  it("rejects absolute paths outside the root", async () => {
    const r = await call("write_file", { path: "/tmp/evil.txt", content: "x" });
    expect(r.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("rejects symlinks that point outside the root", async () => {
    symlinkSync(os.tmpdir(), path.join(root, "link"));
    const r = await call("list_files", { path: "link" });
    expect(r.isError).toBe(true);
  });
});

describe("read / list / search", () => {
  it("reads numbered lines", async () => {
    const r = await call("read_file", { path: "a.txt" });
    expect(r.content).toContain("1\tone");
  });

  it("lists files and skips node_modules", async () => {
    await fs.mkdir(path.join(root, "node_modules/x"), { recursive: true });
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src/index.ts"), "export {}");
    const r = await call("list_files", {});
    expect(r.content).toContain("src/index.ts");
    expect(r.content).not.toContain("node_modules");
  });

  it("searches contents", async () => {
    const r = await call("search", { pattern: "TWO" });
    expect(r.content).toContain("a.txt:2:");
    expect(r.content).toContain("a.txt:3:");
  });
});

describe("writes need approval", () => {
  it("creates a file after approval and passes the diff data", async () => {
    const r = await call("write_file", { path: "new/dir/b.txt", content: "hello" });
    expect(r.isError).toBe(false);
    expect(requests[0]).toMatchObject({ kind: "write", relPath: "new/dir/b.txt", oldContent: null, newContent: "hello" });
    expect(await fs.readFile(path.join(root, "new/dir/b.txt"), "utf8")).toBe("hello");
  });

  it("does not write when denied", async () => {
    decision = "deny";
    const r = await call("write_file", { path: "b.txt", content: "hello" });
    expect(r.isError).toBe(true);
    await expect(fs.access(path.join(root, "b.txt"))).rejects.toThrow();
  });

  it("allow_always skips later questions of the same kind", async () => {
    decision = "allow_always";
    const g = gate();
    await call("write_file", { path: "b.txt", content: "1" }, g);
    await call("write_file", { path: "c.txt", content: "2" }, g);
    expect(requests).toHaveLength(1);
  });

  it("edit_file requires a unique match", async () => {
    const r = await call("edit_file", { path: "a.txt", old_string: "two", new_string: "2" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/occurs 2 times/);
    const ok = await call("edit_file", { path: "a.txt", old_string: "one", new_string: "1" });
    expect(ok.isError).toBe(false);
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("1\ntwo\ntwo\n");
  });

  it("edit_file replace_all", async () => {
    await call("edit_file", { path: "a.txt", old_string: "two", new_string: "2", replace_all: true });
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("one\n2\n2\n");
  });

  it("runs an approved command in the root", async () => {
    const r = await call("run_command", { command: "echo hi && ls" });
    expect(r.content).toContain("Exit code: 0");
    expect(r.content).toContain("hi");
    expect(r.content).toContain("a.txt");
  });

  it("does not run a denied command", async () => {
    decision = "deny";
    const r = await call("run_command", { command: "touch should-not-exist" });
    expect(r.isError).toBe(true);
    await expect(fs.access(path.join(root, "should-not-exist"))).rejects.toThrow();
  });

  it("reports invalid JSON arguments as a tool error", async () => {
    const r = await call("read_file", { __invalid_arguments: "{oops" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not valid JSON/);
  });
});

describe("the editor's errors in the result of a change", () => {
  const withProblems = (problems: ProblemWatcher, name: string, input: Record<string, unknown>) =>
    executeTool({ type: "tool_call", id: "1", name, input }, { root, gate: gate(), problems });
  const fixed = (list: FileProblem[]): ProblemWatcher => () => ({ after: async () => list, cancel() {} });

  it("at most 10 are listed, each on one line and not too long", async () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ line: i + 1, message: i === 0 ? `long ${"x".repeat(500)}` : `problem\n${i}` }));
    const r = await withProblems(fixed(many), "write_file", { path: "b.ts", content: "x" });
    const lines = r.content.split("\n");
    expect(lines[0]).toBe("Created b.ts (1 lines).");
    expect(lines[2]).toMatch(/^The editor now reports 13 errors in this file/);
    expect(lines.slice(3)).toHaveLength(11);
    expect(lines[3].length).toBeLessThan(330);
    expect(lines[3].endsWith("...")).toBe(true);
    expect(lines[4]).toBe("- line 2: problem 1");
    expect(lines.at(-1)).toBe("... and 3 more");
  });

  it("an editor that can't tell does not fail the change", async () => {
    const broken: ProblemWatcher = () => ({ after: async () => Promise.reject(new Error("no editor")), cancel() {} });
    const r = await withProblems(broken, "edit_file", { path: "a.txt", old_string: "one", new_string: "1" });
    expect(r).toEqual({ content: "Edited a.txt (1 replacement).", isError: false });
  });

  it("nothing is asked of the editor when the change is rejected or there is nothing to change", async () => {
    let watched = 0;
    const counting: ProblemWatcher = () => (watched++, { after: async () => [], cancel() {} });
    decision = "deny";
    await withProblems(counting, "write_file", { path: "b.ts", content: "x" });
    decision = "allow";
    await withProblems(counting, "write_file", { path: "a.txt", content: "one\ntwo\ntwo\n" });
    await withProblems(counting, "read_file", { path: "a.txt" });
    expect(watched).toBe(0);
  });
});

describe("writing a file: the whole file or nothing", () => {
  const leftovers = async (dir = root) => (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));

  it("replaces the content, keeps the file's permissions and leaves no temporary files", async () => {
    const script = path.join(root, "run.sh");
    await fs.writeFile(script, "#!/bin/sh\necho old\n", { mode: 0o755 });
    await fs.chmod(script, 0o755);
    expect((await call("write_file", { path: "run.sh", content: "#!/bin/sh\necho new\n" })).isError).toBe(false);
    expect(await fs.readFile(script, "utf8")).toBe("#!/bin/sh\necho new\n");
    if (process.platform !== "win32") expect((await fs.stat(script)).mode & 0o777).toBe(0o755);
    await call("edit_file", { path: "a.txt", old_string: "one", new_string: "1" });
    await call("write_file", { path: "deep/new/file.txt", content: "x" });
    expect(await leftovers()).toEqual([]);
    expect(await leftovers(path.join(root, "deep/new"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("a link stays a link: its target gets the new content", async () => {
    await fs.mkdir(path.join(root, "real"));
    await fs.writeFile(path.join(root, "real/config.txt"), "old");
    symlinkSync(path.join(root, "real/config.txt"), path.join(root, "config.txt"));
    await call("write_file", { path: "config.txt", content: "new" });
    expect((await fs.lstat(path.join(root, "config.txt"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(root, "real/config.txt"), "utf8")).toBe("new");
    expect(await leftovers(path.join(root, "real"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("a folder that takes no new files is still written in place", async () => {
    const dir = path.join(root, "locked");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "note.txt"), "old");
    await fs.chmod(dir, 0o555);
    try {
      const r = await call("write_file", { path: "locked/note.txt", content: "new" });
      // root (in some containers) may write anyway; either way the content is there.
      expect(r.isError).toBe(false);
      expect(await fs.readFile(path.join(dir, "note.txt"), "utf8")).toBe("new");
    } finally {
      await fs.chmod(dir, 0o755);
    }
  });

  it("when the write fails, the old file is untouched and nothing is left behind", async () => {
    // A folder in the file's place: the rename over it fails.
    await fs.mkdir(path.join(root, "taken"));
    await fs.writeFile(path.join(root, "taken/keep.txt"), "keep");
    const { diskFiles } = await import("../src");
    await expect(diskFiles.writeText(path.join(root, "taken"), "x")).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "taken/keep.txt"), "utf8")).toBe("keep");
    expect(await leftovers()).toEqual([]);
  });
});
