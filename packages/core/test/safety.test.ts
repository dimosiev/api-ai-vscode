import { mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool, PermissionGate, type ApprovalDecision, type ApprovalRequest } from "../src";
import { commandEnv } from "../src/tools/sandbox";

let root: string;
let requests: ApprovalRequest[];
let decision: ApprovalDecision;

const gate = (mode: "ask" | "auto" = "ask") =>
  new PermissionGate(
    {
      approve: async (req) => {
        requests.push(req);
        return decision;
      },
    },
    mode,
  );

const call = (name: string, input: Record<string, unknown>, g = gate()) =>
  executeTool({ type: "tool_call", id: "1", name, input }, { root, gate: g });

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "dimosi-safety-"));
  requests = [];
  decision = "allow";
});

describe("command environment", () => {
  afterEach(() => {
    delete process.env.DIMOSI_TEST_API_KEY;
    delete process.env.DIMOSI_TEST_PLAIN;
  });

  it("drops variables that look like keys, tokens and passwords", () => {
    const env = commandEnv({
      PATH: "/usr/bin",
      HOME: "/Users/me",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      ANTHROPIC_API_KEY: "sk-ant",
      GITHUB_TOKEN: "ghp",
      AWS_SECRET_ACCESS_KEY: "aws",
      DB_PASSWORD: "pw",
      npm_config__auth: "npm",
      GOOGLE_APPLICATION_CREDENTIALS: "/x.json",
    });
    expect(Object.keys(env).sort()).toEqual(["CI", "GIT_TERMINAL_PROMPT", "HOME", "PATH", "SSH_AUTH_SOCK"]);
  });

  it("a command does not see the key", async () => {
    process.env.DIMOSI_TEST_API_KEY = "sk-very-secret";
    process.env.DIMOSI_TEST_PLAIN = "visible-value";
    const r = await call("run_command", { command: `node -e "console.log(JSON.stringify(process.env))"` });
    // Booleans: a failure must not print the whole environment into the CI log.
    expect(r.content.includes("visible-value")).toBe(true);
    expect(r.content.includes("sk-very-secret")).toBe(false);
  });
});

void fs;
