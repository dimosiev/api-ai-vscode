import { describe, expect, it } from "vitest";
import { Log } from "@dimosi/core";
import { buildProblemReport, serverOrigin } from "../src/report";

const KEY = "sk-ant-api03-SECRETSECRETSECRET";

describe("problem report", () => {
  it("has versions, settings, the last error and the last 500 journal lines, but no key", () => {
    const log = new Log();
    log.addSecret(KEY);
    for (let i = 0; i < 600; i++) log.info(`request ${i}`);
    log.error(`task failed: Неверный API-ключ (401). (invalid x-api-key ${KEY})`);
    const report = buildProblemReport(
      {
        version: "0.3.2",
        vscodeVersion: "1.140.0",
        os: "Darwin 27.0.0 arm64",
        node: "22.12.0",
        settings: { provider: "anthropic", model: "claude-opus-5-5", approvalMode: "ask" },
        savedKeys: ["anthropic", "polza"],
      },
      log,
    );
    expect(report).toContain("- dimosi: 0.3.2");
    expect(report).toContain("- VS Code: 1.140.0");
    expect(report).toContain("- ОС: Darwin 27.0.0 arm64");
    expect(report).toContain('- provider: "anthropic"');
    expect(report).toContain("- Сохранены ключи для: anthropic, polza");
    expect(report).toContain("## Журнал (последние 500 строк)");
    expect(report).not.toContain("request 100\n");
    expect(report).toContain("request 599");
    expect(report).toMatch(/## Последняя ошибка\n\S+ \[error\] task failed: Неверный API-ключ \(401\)/);
    expect(report).not.toContain(KEY);
    expect(report).not.toContain("SECRETSECRET");
  });

  it("shows only the origin of a custom server address", () => {
    expect(serverOrigin("https://llm.example.com/v1?token=abc")).toBe("https://llm.example.com");
    expect(serverOrigin("")).toBe("");
    expect(serverOrigin("not a url")).toBe("(неверный адрес)");
  });
});
