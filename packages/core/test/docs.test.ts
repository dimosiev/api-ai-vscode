// The documents an AI agent works from (CLAUDE.md, docs/ARCHITECTURE.md) must
// not point at code that is no longer there.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.join(__dirname, "../../..");
const tracked = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean);
const read = (file: string) => readFileSync(path.join(repo, file), "utf8");

describe.each(["CLAUDE.md", "docs/ARCHITECTURE.md"])("%s", (doc) => {
  const text = read(doc);

  it("every code file it names exists", () => {
    // `tools/web.ts`, `packages/vscode/test/real/suite.ts`, `chatView.ts`: the end of a tracked path.
    const named = [...text.matchAll(/`([\w./-]+\.(?:ts|mts|mjs))`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(10);
    const missing = [...new Set(named)].filter((name) => !tracked.some((file) => file === name || file.endsWith(`/${name}`)));
    expect(missing).toEqual([]);
  });
});

describe("docs/ARCHITECTURE.md", () => {
  it("names the identifiers the code really has", () => {
    const sources: Record<string, string[]> = {
      "packages/core/src/commandRules.ts": ["SHELL_SYNTAX", "RUNS_ANOTHER", "RUNS_ANOTHER_AFTER", "commandRule", "ruleMatches"],
      "packages/core/src/permissions.ts": ["PermissionGate", "protectedPathWarning", "dangerousCommandWarning", "checkSite", "ApprovalRequest"],
      "packages/core/src/access.ts": ["createAccess", "checkFolder", "resolvePath", "HOME_PRIVATE", "showPath", "relativeInFolder"],
      "packages/core/src/tools/index.ts": ["TOOL_DEFINITIONS", "HANDLERS", "executeTool", "assertWritable", "assertNotSecret", "diskFiles"],
      "packages/core/src/tools/web.ts": ["parsePageUrl", "assertPublic", "stripMarkup"],
      "packages/core/src/tools/sandbox.ts": ["HOME_WRITABLE", "commandEnv"],
      "packages/core/src/agent.ts": ["PLAN_NOTE", "trimToolResults", "runTurn"],
      "packages/vscode/src/chatView.ts": ["PANEL_COMMANDS", "ChatViewProvider"],
      "packages/vscode/src/chatStore.ts": ["Transcript"],
    };
    const doc = read("docs/ARCHITECTURE.md");
    for (const [file, names] of Object.entries(sources)) {
      const code = read(file);
      for (const name of names) {
        expect(doc, `${name} is described`).toContain(name);
        expect(code, `${name} is in ${file}`).toContain(name);
      }
    }
  });

});
