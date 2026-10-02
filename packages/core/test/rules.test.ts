import { mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRules, MAX_RULE_FILE_CHARS } from "../src";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "dimosi-rules-"));

describe("loadRules", () => {
  it("returns nothing when there are no rule files", async () => {
    const rules = await loadRules(tmp(), path.join(tmp(), "missing.md"));
    expect(rules).toEqual({ sources: [], text: "" });
  });

  it("collects global, AGENTS.md, CLAUDE.md, .dimosi/rules.md and .dimosi/rules/*.md in order", async () => {
    const root = tmp();
    const globalPath = path.join(tmp(), "rules.md");
    await fs.writeFile(globalPath, "G");
    await fs.writeFile(path.join(root, "CLAUDE.md"), "C");
    await fs.writeFile(path.join(root, "AGENTS.md"), "A");
    await fs.mkdir(path.join(root, ".dimosi/rules"), { recursive: true });
    await fs.writeFile(path.join(root, ".dimosi/rules.md"), "R");
    await fs.writeFile(path.join(root, ".dimosi/rules/b-style.md"), "B");
    await fs.writeFile(path.join(root, ".dimosi/rules/a-api.md"), "A2");
    await fs.writeFile(path.join(root, ".dimosi/rules/notes.txt"), "ignored");

    const rules = await loadRules(root, globalPath);
    expect(rules.sources.map((s) => s.label)).toEqual([
      "Глобальные правила",
      "AGENTS.md",
      "CLAUDE.md",
      ".dimosi/rules.md",
      ".dimosi/rules/a-api.md",
      ".dimosi/rules/b-style.md",
    ]);
    expect(rules.sources[0].scope).toBe("global");
    expect(rules.text).not.toContain("ignored");
  });

  it("skips empty files and truncates huge ones", async () => {
    const root = tmp();
    await fs.writeFile(path.join(root, "AGENTS.md"), "   \n");
    await fs.writeFile(path.join(root, "CLAUDE.md"), "x".repeat(MAX_RULE_FILE_CHARS + 500));
    const rules = await loadRules(root, path.join(tmp(), "none.md"));
    expect(rules.sources).toHaveLength(1);
    expect(rules.sources[0]).toMatchObject({ label: "CLAUDE.md", truncated: true });
    expect(rules.text).toContain("обрезано");
  });

  it("does not follow links out of the project, into secret files or to huge files", async () => {
    const root = tmp();
    const outside = path.join(tmp(), "private.md");
    await fs.writeFile(outside, "OUTSIDE SECRET");
    await fs.writeFile(path.join(root, ".env"), "API_KEY=ENV SECRET");
    await fs.mkdir(path.join(root, ".dimosi/rules"), { recursive: true });
    await fs.symlink(outside, path.join(root, ".dimosi/rules/a.md"));
    await fs.symlink(path.join(root, ".env"), path.join(root, ".dimosi/rules/b.md"));
    await fs.symlink(outside, path.join(root, "AGENTS.md"));
    await fs.writeFile(path.join(root, "own.md"), "OWN RULE");
    await fs.symlink(path.join(root, "own.md"), path.join(root, "CLAUDE.md"));
    await fs.writeFile(path.join(root, ".dimosi/rules/huge.md"), "x".repeat(1024 * 1024 + 1));
    const rules = await loadRules(root, path.join(root, "none.md"));
    expect(rules.text).not.toContain("OUTSIDE SECRET");
    expect(rules.text).not.toContain("ENV SECRET");
    expect(rules.text).toContain("OWN RULE"); // a link inside the project is fine
    expect(rules.sources.map((s) => s.label)).toEqual(["CLAUDE.md"]);
  });
});

