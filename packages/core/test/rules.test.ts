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
});
