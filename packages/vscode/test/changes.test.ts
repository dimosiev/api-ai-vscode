import { mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ChangeTracker } from "../src/changes";
import { buildDiffView, countChanges } from "../src/diff";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "dimosi-changes-"));

describe("diff view", () => {
  it("numbers lines and counts additions and removals", () => {
    const d = buildDiffView("a\nb\nc\n", "a\nB\nc\nd\n");
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.rows[0].t).toBe("hunk");
    expect(d.rows).toContainEqual({ t: "del", text: "b", old: 2 });
    expect(d.rows).toContainEqual({ t: "add", text: "B", new: 2 });
    expect(d.rows).toContainEqual({ t: "add", text: "d", new: 4 });
    expect(d.truncated).toBe(false);
  });

  it("treats a new file as all additions", () => {
    const d = buildDiffView(null, "x\ny\n");
    expect(d.added).toBe(2);
    expect(d.removed).toBe(0);
  });

  it("caps very large diffs", () => {
    const big = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const d = buildDiffView(null, big);
    expect(d.rows.length).toBeLessThanOrEqual(400);
    expect(d.truncated).toBe(true);
    expect(d.added).toBe(1000);
  });

  it("counts changes", () => {
    expect(countChanges("a\nb\n", "a\nc\nd\n")).toEqual({ added: 2, removed: 1 });
  });
});

describe("ChangeTracker", () => {
  it("restores the content from before the first change", async () => {
    const dir = tmp();
    const file = path.join(dir, "a.txt");
    await fs.writeFile(file, "v1");
    const t = new ChangeTracker();
    await fs.writeFile(file, "v2");
    t.record({ path: file, relPath: "a.txt", oldContent: "v1", newContent: "v2" });
    await fs.writeFile(file, "v3");
    t.record({ path: file, relPath: "a.txt", oldContent: "v2", newContent: "v3" });
    expect(t.summary()).toEqual([{ relPath: "a.txt", added: 1, removed: 1, created: false, reverted: false }]);
    expect(await t.revert("a.txt")).toEqual({ ok: true });
    expect(await fs.readFile(file, "utf8")).toBe("v1");
    expect(t.summary()[0].reverted).toBe(true);
  });

  it("deletes files the agent created", async () => {
    const dir = tmp();
    const file = path.join(dir, "new.txt");
    await fs.writeFile(file, "hello");
    const t = new ChangeTracker();
    t.record({ path: file, relPath: "new.txt", oldContent: null, newContent: "hello" });
    expect(t.summary()[0].created).toBe(true);
    await t.revert("new.txt");
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("refuses to overwrite edits made after the agent unless forced", async () => {
    const dir = tmp();
    const file = path.join(dir, "a.txt");
    await fs.writeFile(file, "agent");
    const t = new ChangeTracker();
    t.record({ path: file, relPath: "a.txt", oldContent: "orig", newContent: "agent" });
    await fs.writeFile(file, "user edit");
    const r = await t.revert("a.txt");
    expect(r).toMatchObject({ ok: false, reason: "modified_since" });
    expect(await fs.readFile(file, "utf8")).toBe("user edit");
    expect(await t.revert("a.txt", true)).toEqual({ ok: true });
    expect(await fs.readFile(file, "utf8")).toBe("orig");
  });
});
