import { mkdtempSync, promises as fs, symlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { executeTool, PermissionGate, type ApprovalDecision, type ApprovalRequest } from "../src";

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
