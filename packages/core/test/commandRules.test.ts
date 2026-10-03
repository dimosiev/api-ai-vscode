import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  commandRule,
  PermissionGate,
  ProjectCommandRules,
  type ApprovalDecision,
  type ApprovalRequest,
  type CommandRule,
  type CommandRulesStorage,
} from "../src";

let requests: ApprovalRequest[];
let decision: ApprovalDecision;
let saved: unknown;
let root: string;

/** What a host keeps outside the project (VS Code storage, the CLI's own folder). */
const storage: CommandRulesStorage = {
  load: () => saved,
  save: async (all) => void (saved = structuredClone(all)),
};

const gate = (rules = new ProjectCommandRules(root, storage), mode: "ask" | "auto" = "ask") =>
  new PermissionGate(
    {
      approve: async (req) => {
        requests.push(req);
        return decision;
      },
    },
    mode,
    rules,
  );

const run = (g: PermissionGate, command: string) => g.check({ kind: "command", command, cwd: root });

/** Presses "Always" on `command`, then counts the questions for the commands after it. */
async function asksAfterAlways(command: string, later: string[], g = gate()): Promise<number> {
  decision = "allow_always";
  await run(g, command);
  requests = [];
  decision = "allow";
  for (const c of later) await run(g, c);
  return requests.length;
}

beforeEach(() => {
  requests = [];
  decision = "allow";
  saved = undefined;
  root = mkdtempSync(path.join(os.tmpdir(), "dimosi-rules-"));
});

describe("\"Always\" for a command: chained commands never pass by their beginning", () => {
  it.each([
    "npm test && rm -r src",
    "npm test && echo done",
    "npm test; echo done",
    "npm test || echo failed",
    "npm test | tee out.txt",
    "npm test & echo background",
    "npm test $(cat list.txt)",
    "npm test `cat list.txt`",
    "npm test $HOME",
    "npm test > out.txt",
    "npm test < in.txt",
    "npm test\necho second line",
    "npm test \\\n&& echo x",
    "(npm test)",
    "npm test -- \"a; echo b\"",
  ])("%j is asked about after Always on `npm test`", async (later) => {
    expect(await asksAfterAlways("npm test", [later])).toBe(1);
  });

  it("a chained command can be allowed itself, but only exactly as it was", async () => {
    const chain = "npm test && npm run build";
    expect(commandRule(chain)).toEqual({ kind: "exact", text: chain });
    expect(await asksAfterAlways(chain, [chain, `  ${chain}  `])).toBe(0);
    expect(await asksAfterAlways(chain, [`${chain} && echo more`, "npm test", "npm test && npm run build2"])).toBe(3);
  });

  it("a rule in the saved file can't smuggle a chain in either", async () => {
    saved = { [new ProjectCommandRules(root, storage).key]: [{ kind: "prefix", text: "npm test &&" }, { kind: "prefix", text: "npm" }] };
    const g = gate();
    await run(g, "npm test && echo x");
    await run(g, "npm install left-pad");
    expect(requests).toHaveLength(2);
  });
});

describe("\"Always\" for a command: what is remembered", () => {
  it.each<[string, CommandRule]>([
    ["npm test", { kind: "prefix", text: "npm test" }],
    ["  npm   test  -- --watch ", { kind: "prefix", text: "npm test" }],
    ["git status --short", { kind: "prefix", text: "git status" }],
    ["npm run build", { kind: "prefix", text: "npm run build" }],
    ["pnpm run test:unit --watch", { kind: "prefix", text: "pnpm run test:unit" }],
    ["npx vitest run agent", { kind: "prefix", text: "npx vitest" }],
    ["python3 scripts/check.py", { kind: "prefix", text: "python3 scripts/check.py" }],
    // One word, or an option right after the program: nothing safe to generalise.
    ["ls", { kind: "exact", text: "ls" }],
    ["ls -la", { kind: "exact", text: "ls -la" }],
    ["node -e 1", { kind: "exact", text: "node -e 1" }],
    ["npm run", { kind: "exact", text: "npm run" }],
    ["npm run --silent build", { kind: "exact", text: "npm run --silent build" }],
    // Programs that run another program: their beginning says nothing.
    ["env node script.js", { kind: "exact", text: "env node script.js" }],
    ["xargs rm", { kind: "exact", text: "xargs rm" }],
    ["bash script.sh", { kind: "exact", text: "bash script.sh" }],
    ["timeout 5 node x.js", { kind: "exact", text: "timeout 5 node x.js" }],
    ["FOO=1 npm test", { kind: "exact", text: "FOO=1 npm test" }],
    ["cat 'my file.txt'", { kind: "exact", text: "cat 'my file.txt'" }],
  ])("%j → %j", (command, rule) => {
    expect(commandRule(command)).toEqual(rule);
  });

  it("the handler is told what Always would remember", async () => {
    await run(gate(), "npm test -- --watch");
    expect(requests[0]).toMatchObject({ always: { kind: "prefix", text: "npm test" } });
  });

  it("the beginning must match whole words", async () => {
    expect(await asksAfterAlways("npm test", ["npm test", "npm test -- --watch", "npm   test  --coverage"])).toBe(0);
    expect(await asksAfterAlways("npm test", ["npm testx", "npm tes", "npm install", "npm", "xnpm test"])).toBe(5);
  });

  it("dangerous commands are still asked about every time, and Always is not remembered for them", async () => {
    const g = gate();
    expect(await asksAfterAlways("git status", ["git status --short"], g)).toBe(0);
    decision = "allow_always";
    await run(g, "git push");
    await run(g, "git push origin main");
    expect(requests).toHaveLength(2);
    expect(requests[0].warning).toMatch(/git push/);
    expect(requests[0]).not.toHaveProperty("always");
    expect(new ProjectCommandRules(root, storage).list()).toEqual([{ kind: "prefix", text: "git status" }]);
  });

  it("a remembered beginning does not cover its dangerous forms", async () => {
    expect(await asksAfterAlways("git checkout main", ["git checkout -- ."])).toBe(1);
    expect(await asksAfterAlways("rm notes.txt", ["rm notes.txt -rf"])).toBe(1);
  });
});

describe("\"Always\" for a command: kept between sessions, per project, outside the project", () => {
  it("a new session of the same project does not ask again", async () => {
    await asksAfterAlways("npm test", []);
    await run(gate(), "npm test -- --watch");
    expect(requests).toHaveLength(0);
    expect(Object.keys(saved as object)).toEqual([new ProjectCommandRules(root, storage).key]);
  });

  it("a new chat keeps the commands but forgets Always for file writes", async () => {
    const g = gate();
    await asksAfterAlways("npm test", [], g);
    decision = "allow_always";
    const write = { kind: "write" as const, path: path.join(root, "a.txt"), relPath: "a.txt", oldContent: null, newContent: "x" };
    await g.check(write);
    await g.check(write);
    expect(requests).toHaveLength(1);
    g.resetSessionApprovals();
    await g.check(write);
    await run(g, "npm test");
    expect(requests).toHaveLength(2);
  });

  it("another project has its own list", async () => {
    await asksAfterAlways("npm test", []);
    const other = mkdtempSync(path.join(os.tmpdir(), "dimosi-rules-other-"));
    await run(gate(new ProjectCommandRules(other, storage)), "npm test");
    expect(requests).toHaveLength(1);
  });

  it("a removed rule is asked about again at once, in the running session too", async () => {
    const rules = new ProjectCommandRules(root, storage);
    const g = gate(rules);
    await asksAfterAlways("npm test", [], g);
    await asksAfterAlways("git status", [], g);
    expect(rules.list()).toEqual([{ kind: "prefix", text: "npm test" }, { kind: "prefix", text: "git status" }]);
    await rules.remove({ kind: "prefix", text: "npm test" });
    await run(g, "npm test");
    await run(g, "git status");
    expect(requests).toHaveLength(1);
    await rules.clear();
    await run(g, "git status");
    expect(requests).toHaveLength(2);
    expect(saved).toEqual({});
  });

  it("the same rule is saved once; a damaged file means no rules", async () => {
    const g = gate();
    await asksAfterAlways("npm test", [], g);
    await new ProjectCommandRules(root, storage).add({ kind: "prefix", text: "npm test" });
    expect(new ProjectCommandRules(root, storage).list()).toHaveLength(1);
    for (const bad of ["text", 5, null, { [new ProjectCommandRules(root, storage).key]: "x" }, { [new ProjectCommandRules(root, storage).key]: [{ kind: "all", text: "" }, 7] }]) {
      saved = bad;
      expect(new ProjectCommandRules(root, storage).list()).toEqual([]);
    }
  });

  it("without a store Always lasts until the new chat, by the same rules", async () => {
    const g = new PermissionGate({ approve: async (req) => (requests.push(req), decision) });
    expect(await asksAfterAlways("npm test", ["npm test -- --watch", "npm test && echo x"], g)).toBe(1);
    g.resetSessionApprovals();
    await run(g, "npm test");
    expect(requests).toHaveLength(2);
  });

  it("if the rule can't be saved, it still works until the new chat", async () => {
    const broken = new ProjectCommandRules(root, { load: () => undefined, save: async () => Promise.reject(new Error("disk full")) });
    expect(await asksAfterAlways("npm test", ["npm test"], gate(broken))).toBe(0);
  });
});
