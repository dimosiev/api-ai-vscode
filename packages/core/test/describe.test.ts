import { describe, expect, it } from "vitest";
import { buildSystemPrompt, describeToolCall, TOOL_DEFINITIONS, toolCallDetail, type ToolCallPart } from "../src";

const command = (input: Record<string, unknown>): ToolCallPart => ({ type: "tool_call", id: "c1", name: "run_command", input });

describe("what the user sees about a step", () => {
  it("a command with an explanation is shown by it; the command itself goes to the details", () => {
    const call = command({ command: "cd web && sed -n '1,80p' src/data/transducers.ts", description: "Смотрю, какие данные есть о датчиках" });
    expect(describeToolCall(call)).toBe("Команда: Смотрю, какие данные есть о датчиках");
    expect(toolCallDetail(call)).toBe("cd web && sed -n '1,80p' src/data/transducers.ts");
  });

  it("without an explanation the command is shown as before, with no details", () => {
    for (const description of [undefined, "", "   ", 42]) {
      const call = command({ command: "npm test", description });
      expect(describeToolCall(call)).toBe("Команда: npm test");
      expect(toolCallDetail(call)).toBeUndefined();
    }
  });

  it("the explanation is one short line, and hidden characters in it are shown", () => {
    const call = command({ command: "ls", description: `Первая строка\nвторая ${"очень ".repeat(40)}‮` });
    const title = describeToolCall(call);
    expect(title).not.toContain("\n");
    expect(title.length).toBeLessThanOrEqual("Команда: ".length + 121);
    expect(title).toMatch(/^Команда: Первая строка вторая/);
    expect(describeToolCall(command({ command: "ls", description: "ok‮" }))).not.toContain("‮");
  });

  it("run_command asks the model for the explanation", () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === "run_command")!;
    expect(Object.keys((def.inputSchema as { properties: object }).properties)).toContain("description");
  });

  it("the system prompt asks for a short line before steps, plain tools for reading and a structured report", () => {
    const prompt = buildSystemPrompt({ root: "/p", layout: "", rules: { sources: [], text: "" } });
    expect(prompt).toMatch(/one short sentence/);
    expect(prompt).toMatch(/Read and search with read_file, list_files and search/);
    expect(prompt).toMatch(/what was done, how it was checked/);
    // A helper answers the main agent, not the user.
    expect(buildSystemPrompt({ root: "/p", layout: "", rules: { sources: [], text: "" }, role: "helper" })).not.toMatch(/one short sentence/);
  });
});
