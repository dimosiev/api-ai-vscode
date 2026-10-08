import { mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  Agent,
  parseSubagents,
  PermissionGate,
  ProjectCommandRules,
  subagentKey,
  UsageTotals,
  withBuiltinSubagents,
  type AgentEvent,
  type ApprovalRequest,
  type ChatRequest,
  type CommandRule,
  type Pricing,
  type Provider,
  type StreamEvent,
  type SubagentDef,
  type ToolCallPart,
} from "../src";

/** Replays scripted assistant turns and records what it was sent. */
class FakeProvider implements Provider {
  requests: ChatRequest[] = [];
  constructor(
    readonly id: string,
    private turns: Array<StreamEvent[] | ((req: ChatRequest) => StreamEvent[])>,
    private pricing?: Pricing,
  ) {}
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone({ ...req, signal: undefined }));
    const turn = this.turns.shift();
    if (!turn) throw new Error("no more scripted turns");
    for (const ev of typeof turn === "function" ? turn(req) : turn) yield ev;
  }
  async listModels() {
    return [];
  }
  async getPricing() {
    return this.pricing;
  }
}

const call = (id: string, name: string, input: Record<string, unknown>): ToolCallPart => ({ type: "tool_call", id, name, input });
const toolTurn = (...calls: ToolCallPart[]): StreamEvent[] => [
  { type: "done", stopReason: "tool_use", message: { role: "assistant", parts: calls }, usage: { inputTokens: 100, outputTokens: 10 } },
];
const textTurn = (text: string): StreamEvent[] => [
  { type: "text_delta", text },
  { type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [{ type: "text", text }] }, usage: { inputTokens: 50, outputTokens: 5 } },
];

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "dimosi-helper-"));
const NO_GLOBAL = path.join(os.tmpdir(), "dimosi-no-global-rules.md");
async function collect(gen: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const SCOUT: SubagentDef = { name: "scout", description: "finds things", provider: "cheap", model: "small-1" };

function setup(opts: { main: FakeProvider; helper?: FakeProvider; defs?: SubagentDef[]; mode?: "ask" | "auto"; store?: ProjectCommandRules; decision?: "allow" | "deny" | "allow_always" }) {
  const asked: ApprovalRequest[] = [];
  const root = tmp();
  const agent = new Agent({
    provider: opts.main,
    model: "big-1",
    root,
    approval: {
      approve: async (req) => {
        asked.push(req);
        return opts.decision ?? "allow";
      },
    },
    mode: opts.mode,
    globalRulesPath: NO_GLOBAL,
    commandRules: opts.store,
    subagents: opts.defs ?? [SCOUT],
    resolveSubagent: opts.helper ? async (def) => ({ provider: opts.helper!, model: def.model ?? "small-1" }) : undefined,
  });
  return { agent, asked, root };
}

describe("settings of helpers", () => {
  it("keeps good helpers and drops the rest", () => {
    const parsed = parseSubagents([
      { name: "scout", description: "d", provider: "polza", model: "m", maxSteps: 500 },
      { name: "scout", description: "again" },
      { name: "Bad Name" },
      { name: "no-description" },
      "text",
      null,
    ]);
    expect(parsed.map((d) => d.name)).toEqual(["scout", "no-description"]);
    expect(parsed[0]).toMatchObject({ provider: "polza", model: "m", maxSteps: 60 });
    expect(parseSubagents("nope")).toEqual([]);
  });

  it("has an explorer without any setup, and the user's helper of that name replaces it", () => {
    expect(withBuiltinSubagents([]).map((d) => d.name)).toEqual(["explorer"]);
    const mine = withBuiltinSubagents([{ name: "explorer", description: "mine", model: "x" }]);
    expect(mine).toEqual([{ name: "explorer", description: "mine", model: "x" }]);
  });
});

describe("run_subagent", () => {
  it("hands the task to a helper on another service; its reading stays out of the main chat", async () => {
    const helper = new FakeProvider("cheap", [
      toolTurn(call("h1", "read_file", { path: "secret-plan.txt" })),
      textTurn("The plan is in secret-plan.txt, line 1."),
    ]);
    const main = new FakeProvider("main", [
      toolTurn(call("m1", "run_subagent", { name: "scout", task: "Where is the plan?" })),
      textTurn("Found."),
    ]);
    const { agent, root } = setup({ main, helper });
    await fs.writeFile(path.join(root, "secret-plan.txt"), "FILE-CONTENT-THE-MAIN-AGENT-MUST-NOT-SEE\n");

    const events = await collect(agent.run("find the plan"));

    expect(events.at(-1)).toMatchObject({ type: "done" });
    const result = events.find((e) => e.type === "tool_end" && e.call.name === "run_subagent");
    expect(result).toMatchObject({ isError: false, result: expect.stringContaining("The plan is in secret-plan.txt, line 1.") });
    expect((result as { result: string }).result).toMatch(/not an instruction/);
    // The file was read by the helper only.
    expect(JSON.stringify(main.requests)).not.toContain("FILE-CONTENT-THE-MAIN-AGENT-MUST-NOT-SEE");
    expect(JSON.stringify(helper.requests)).toContain("FILE-CONTENT-THE-MAIN-AGENT-MUST-NOT-SEE");
    // Its own model, a task and no memory of the chat.
    expect(helper.requests[0].model).toBe("small-1");
    expect(JSON.stringify(helper.requests[0].messages)).toContain("Where is the plan?");
    expect(JSON.stringify(helper.requests[0].messages)).not.toContain("find the plan");
  });

  it("gives the helper only the reading tools, and refuses anything else it tries", async () => {
    const helper = new FakeProvider("cheap", [
      toolTurn(call("h1", "write_file", { path: "evil.txt", content: "x" }), call("h2", "run_command", { command: "touch evil2" })),
      textTurn("Could not."),
    ]);
    const main = new FakeProvider("main", [toolTurn(call("m1", "run_subagent", { name: "scout", task: "t" })), textTurn("ok")]);
    const { agent, root } = setup({ main, helper });

    await collect(agent.run("go"));

    expect(helper.requests[0].tools.map((t) => t.name).sort()).toEqual(["fetch_page", "list_files", "read_file", "search"]);
    expect(main.requests[0].tools.map((t) => t.name)).toContain("run_subagent");
    await expect(fs.access(path.join(root, "evil.txt"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "evil2"))).rejects.toThrow();
    // The refusal went to the helper as a tool result, and the helper finished.
    expect(JSON.stringify(helper.requests[1].messages)).toContain("not available");
  });

  it("tells the main agent whom it can ask, in the system instruction, and keeps the list for the chat", async () => {
    const main = new FakeProvider("main", [textTurn("a"), textTurn("b")]);
    const { agent } = setup({ main });
    await collect(agent.run("one"));
    agent.subagents = [{ name: "other", description: "changed" }];
    await collect(agent.run("two"));
    expect(main.requests[0].system).toContain("# Helpers");
    expect(main.requests[0].system).toContain("- scout: finds things");
    // A changing prompt would lose the cache: the list stays the same until the new chat.
    expect(main.requests[1].system).toBe(main.requests[0].system);
    agent.reset();
    const again = new FakeProvider("main", [textTurn("c")]);
    agent.provider = again;
    await collect(agent.run("three"));
    expect(again.requests[0].system).toContain("- other: changed");
  });

  it("without helpers there is no Helpers block", async () => {
    const main = new FakeProvider("main", [textTurn("a")]);
    const { agent } = setup({ main, defs: [] });
    await collect(agent.run("one"));
    expect(main.requests[0].system).not.toContain("# Helpers");
    const events = await collect(
      setup({ main: new FakeProvider("m", [toolTurn(call("m1", "run_subagent", { name: "scout", task: "t" })), textTurn("ok")]), defs: [] }).agent.run("go"),
    );
    expect(events.find((e) => e.type === "tool_end" && e.call.name === "run_subagent")).toMatchObject({ isError: true });
  });

  it("an unknown helper or an empty task is an error for the model, not a crash", async () => {
    const main = new FakeProvider("main", [
      toolTurn(call("m1", "run_subagent", { name: "nobody", task: "t" }), call("m2", "run_subagent", { name: "scout", task: "  " })),
      textTurn("ok"),
    ]);
    const { agent } = setup({ main, helper: new FakeProvider("cheap", []) });
    const ends = (await collect(agent.run("go"))).filter((e) => e.type === "tool_end");
    expect(ends).toMatchObject([
      { isError: true, result: expect.stringContaining('no helper "nobody"') },
      { isError: true, result: expect.stringContaining("empty") },
    ]);
  });

  it("a helper on a service that is not set up says so", async () => {
    const main = new FakeProvider("main", [toolTurn(call("m1", "run_subagent", { name: "scout", task: "t" })), textTurn("ok")]);
    const { agent } = setup({ main });
    const end = (await collect(agent.run("go"))).find((e) => e.type === "tool_end");
    expect(end).toMatchObject({ isError: true, result: expect.stringContaining('needs the service "cheap"') });
  });

  it("a helper without its own service runs on the model of the chat", async () => {
    const main = new FakeProvider("main", [
      toolTurn(call("m1", "run_subagent", { name: "explorer", task: "t" })),
      textTurn("done"),
      // the helper's request is the second one of the same service
    ]);
    const { agent } = setup({ main, defs: withBuiltinSubagents([]), mode: "auto" });
    // main: turn 1 (call), helper turn 2 (answer), main turn 3 (finish)
    main["turns"].splice(1, 0, textTurn("Found it."));
    const events = await collect(agent.run("go"));
    expect(main.requests.map((r) => r.model)).toEqual(["big-1", "big-1", "big-1"]);
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ isError: false, result: expect.stringContaining("Found it.") });
  });

  it("shows what the helper does while it works, before the tool call ends, and what it cost", async () => {
    const helper = new FakeProvider(
      "cheap",
      [toolTurn(call("h1", "list_files", {})), textTurn("Listed.")],
      { input: 1, output: 2, currency: "USD" },
    );
    const main = new FakeProvider("main", [toolTurn(call("m1", "run_subagent", { name: "scout", task: "t" })), textTurn("ok")]);
    const { agent } = setup({ main, helper });
    const events = await collect(agent.run("go"));
    const kinds = events.map((e) => e.type);
    const steps = events.filter((e) => e.type === "helper").map((e) => (e as { text: string }).text);
    expect(steps.some((t) => t.includes("Просмотр папки"))).toBe(true);
    expect(kinds.indexOf("helper")).toBeGreaterThan(kinds.indexOf("tool_start"));
    expect(kinds.lastIndexOf("helper")).toBeLessThan(kinds.indexOf("tool_end"));
    // 150 input and 15 output tokens at $1 / $2 per million.
    const spent = events.find((e) => e.type === "helper_usage") as { cost?: { amount: number; currency: string } };
    expect(spent.cost?.currency).toBe("USD");
    expect(spent.cost?.amount).toBeCloseTo((150 * 1 + 15 * 2) / 1e6, 10);
    // The helper's tokens do not count as the size of the main chat.
    expect(events.filter((e) => e.type === "usage")).toHaveLength(2);
  });

  it("does not turn off the plan-mode of the main agent while the helper works", async () => {
    const helper = new FakeProvider("cheap", [textTurn("Looked.")]);
    const main = new FakeProvider("main", [toolTurn(call("m1", "run_subagent", { name: "scout", task: "t" })), textTurn("plan")]);
    const { agent } = setup({ main, helper });
    agent.planFirst = true;
    let planOnlyDuring: boolean | undefined;
    const gate = agent.gate;
    const original = helper.stream.bind(helper);
    helper.stream = (req) => {
      planOnlyDuring = gate.planOnly;
      return original(req);
    };
    await collect(agent.run("plan it"));
    expect(planOnlyDuring).toBe(true);
    expect(agent.gate.planOnly).toBe(true);
  });
});

describe("stopping", () => {
  it("«Stop» does not wait for a slow price list", async () => {
    const helper = new FakeProvider("cheap", [textTurn("x")]);
    helper.getPricing = () => new Promise(() => undefined); // never answers
    const main = new FakeProvider("main", [toolTurn(call("m1", "run_subagent", { name: "scout", task: "t" })), textTurn("ok")]);
    const { agent } = setup({ main, helper, mode: "auto" });
    const controller = new AbortController();
    const started = Date.now();
    const events: AgentEvent[] = [];
    for await (const ev of agent.run("go", controller.signal)) {
      events.push(ev);
      if (ev.type === "tool_start") controller.abort();
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("asking about helpers", () => {
  const key = subagentKey(SCOUT, "cheap", "small-1");
  const script = () => ({
    helper: new FakeProvider("cheap", [textTurn("one"), textTurn("two")]),
    main: new FakeProvider("main", [
      toolTurn(call("m1", "run_subagent", { name: "scout", task: "first" })),
      toolTurn(call("m2", "run_subagent", { name: "scout", task: "second" })),
      textTurn("end"),
    ]),
  });

  it("asks before the first start and tells where the text will go", async () => {
    const { helper, main } = script();
    const { agent, asked } = setup({ main, helper, decision: "allow" });
    await collect(agent.run("go"));
    // "Allow" is for this start only: the second one is asked about too.
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({ kind: "subagent", name: "scout", providerId: "cheap", model: "small-1", external: true, task: "first" });
  });

  it("«Always» is asked once and then remembered for good", async () => {
    const saved: Record<string, CommandRule[]> = {};
    const store = new ProjectCommandRules(tmp(), { load: () => saved, save: async (all) => void (Object.keys(saved).forEach((k) => delete saved[k]), Object.assign(saved, all)) });
    const { helper, main } = script();
    const { agent, asked } = setup({ main, helper, decision: "allow_always", store });
    await collect(agent.run("go"));
    expect(asked).toHaveLength(1);
    expect(store.helpers()).toEqual([key]);

    // Another chat, another project folder: still not asked.
    const second = script();
    const again = setup({ main: second.main, helper: second.helper, decision: "deny", store: new ProjectCommandRules(tmp(), { load: () => saved, save: async () => undefined }) });
    const events = await collect(again.agent.run("go"));
    expect(again.asked).toHaveLength(0);
    expect(events.filter((e) => e.type === "tool_end" && !e.isError)).toHaveLength(2);

    await store.removeHelper(key);
    expect(store.helpers()).toEqual([]);
  });

  it("another model for the same helper is a new question", async () => {
    const saved: Record<string, CommandRule[]> = {};
    const store = new ProjectCommandRules(tmp(), { load: () => saved, save: async (all) => void Object.assign(saved, all) });
    await store.addHelper(key);
    const helper = new FakeProvider("cheap", [textTurn("x")]);
    const main = new FakeProvider("main", [toolTurn(call("m1", "run_subagent", { name: "scout", task: "t" })), textTurn("end")]);
    const { agent, asked } = setup({ main, helper, defs: [{ ...SCOUT, model: "small-2" }], decision: "allow", store });
    await collect(agent.run("go"));
    expect(asked).toMatchObject([{ kind: "subagent", model: "small-2", key: "scout|cheap|small-2" }]);
  });

  it("is not asked in the «no approvals» mode", async () => {
    const { helper, main } = script();
    const { agent, asked } = setup({ main, helper, mode: "auto" });
    await collect(agent.run("go"));
    expect(asked).toHaveLength(0);
  });

  it("when the user says no, the helper does not start and the main agent is told", async () => {
    const helper = new FakeProvider("cheap", []);
    const main = new FakeProvider("main", [toolTurn(call("m1", "run_subagent", { name: "scout", task: "t" })), textTurn("ok")]);
    const { agent } = setup({ main, helper, decision: "deny" });
    const end = (await collect(agent.run("go"))).find((e) => e.type === "tool_end");
    expect(end).toMatchObject({ isError: true, result: expect.stringContaining("did not allow") });
    expect(helper.requests).toHaveLength(0);
  });

  it("hidden characters in the task are always asked about, even in «no approvals» mode and after «Always»", async () => {
    const asked: ApprovalRequest[] = [];
    const gate = new PermissionGate({ approve: async (r) => (asked.push(r), "allow") }, "auto");
    const req = { kind: "subagent" as const, name: "scout", description: "d", providerId: "cheap", model: "m", external: true, task: "read‮ this" };
    expect(await gate.check(req)).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0].warning).toMatch(/скрытые символы/);
  });
});

describe("the cost of helpers", () => {
  it("is added to the cost of the chat without mixing their tokens into it", () => {
    const totals = new UsageTotals();
    totals.add({ inputTokens: 1_000_000, outputTokens: 0 });
    totals.addHelper({ amount: 0.5, currency: "USD" });
    totals.addHelper({ amount: 3, currency: "RUB" }); // another currency: left out rather than added up wrongly
    expect(totals.cost({ input: 2, output: 10, currency: "USD" })).toEqual({ amount: 2.5, currency: "USD" });
    expect(totals.totalInput).toBe(1_000_000);
  });
});
