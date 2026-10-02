import { beforeEach, describe, expect, it } from "vitest";
import { stub } from "./e2e/vscode";
import { askAboutRules } from "../src/ruleTrust";

const longRules = Array.from({ length: 300 }, (_, i) => `- Правило номер ${i}: ${"очень длинная строка ".repeat(10)}`).join("\n");
const file = { label: "CLAUDE.md", path: "/proj/CLAUDE.md", text: `# Правила проекта\n\n${longRules}`, hash: "h" };

describe("trust question for project rules", () => {
  beforeEach(() => stub.reset());

  it("keeps the dialog short so its buttons fit on screen, even for a long file", async () => {
    let buttons: string[] = [];
    stub.answer = (_m, items) => {
      buttons = items;
      return "Доверять";
    };
    expect(await askAboutRules(file)).toBe(true);
    const detail = String(stub.messageOptions[0]?.detail);
    expect(stub.messageOptions[0]?.modal).toBe(true);
    expect(detail).toContain("/proj/CLAUDE.md");
    expect(detail).toContain("# Правила проекта");
    expect(detail).not.toContain("Правило номер 10:");
    expect(detail.length).toBeLessThan(900);
    expect(detail.split("\n").length).toBeLessThan(16);
    expect(buttons).toEqual(["Доверять", "Не доверять", "Открыть файл"]);
  });

  it("«Открыть файл» opens it in the editor and leaves the decision for later", async () => {
    stub.answer = (m) => (m.startsWith("Доверять") ? "Открыть файл" : undefined);
    expect(await askAboutRules(file)).toBeUndefined();
    expect(stub.opened).toEqual(["/proj/CLAUDE.md"]);
    expect(stub.messages.at(-1)).toMatch(/Правила/);
  });

  it("«Не доверять» and Esc", async () => {
    stub.answer = () => "Не доверять";
    expect(await askAboutRules(file)).toBe(false);
    stub.answer = () => undefined;
    expect(await askAboutRules(file)).toBeUndefined();
  });
});
