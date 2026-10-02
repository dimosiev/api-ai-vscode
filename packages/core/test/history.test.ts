import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Agent, IMAGE_REMOVED, parseMessages, stripImages, type Message, type Provider } from "../src";

const provider: Provider = {
  id: "anthropic",
  async *stream() {},
  async listModels() {
    return [];
  },
};

const claudeRaw = [
  { type: "thinking", thinking: "plan", signature: "sig==" },
  { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.txt" } },
];

/** A history saved in the middle of a step: the tool call has no result yet. */
const midStep = (): Message[] => [
  { role: "user", parts: [{ type: "text", text: "read a.txt" }, { type: "image", mediaType: "image/png", data: "AAAA" }] },
  {
    role: "assistant",
    parts: [{ type: "tool_call", id: "toolu_1", name: "read_file", input: { path: "a.txt" } }],
    providerData: { provider: "anthropic", model: "claude-opus-5-5", raw: claudeRaw },
  },
];

describe("saved history", () => {
  it("survives a JSON round trip and is accepted back", () => {
    const loaded = parseMessages(JSON.parse(JSON.stringify(midStep())));
    expect(loaded).toEqual(midStep());
  });

  it("rejects damaged or foreign data", () => {
    expect(parseMessages(undefined)).toBeUndefined();
    expect(parseMessages({ role: "user" })).toBeUndefined();
    expect(parseMessages([{ role: "system", parts: [] }])).toBeUndefined();
    expect(parseMessages([{ role: "user", parts: [{ type: "video" }] }])).toBeUndefined();
    expect(parseMessages([{ role: "user", parts: [{ type: "text", text: 5 }] }])).toBeUndefined();
    expect(parseMessages([{ role: "assistant", parts: [], providerData: "x" }])).toBeUndefined();
  });

  it("restoring answers tool calls left without a result and keeps Claude's content unchanged", () => {
    const agent = new Agent({
      provider,
      model: "claude-opus-5-5",
      root: os.tmpdir(),
      approval: { approve: async () => "allow" },
      globalRulesPath: path.join(os.tmpdir(), "none.md"),
    });
    agent.restore(midStep());
    expect(agent.messages).toHaveLength(3);
    expect(agent.messages[1].providerData?.raw).toEqual(claudeRaw);
    expect(agent.messages[2]).toMatchObject({
      role: "user",
      parts: [{ type: "tool_result", toolCallId: "toolu_1", isError: true }],
    });
  });

  it("removes pictures only from the user's messages", () => {
    const messages = midStep();
    expect(stripImages(messages)).toBe(true);
    expect(messages[0].parts[1]).toEqual({ type: "text", text: IMAGE_REMOVED });
    expect(messages[1]).toEqual(midStep()[1]);
    expect(stripImages(messages)).toBe(false);
  });
});
