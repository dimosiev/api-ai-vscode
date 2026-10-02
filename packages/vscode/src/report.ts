// Text of "dimosi: Сообщить о проблеме". Must not import "vscode": tested directly.
import type { Log } from "@dimosi/core";

export interface ReportInput {
  version: string;
  vscodeVersion: string;
  os: string;
  node: string;
  /** dimosi settings; keys are never among them (they live in SecretStorage). */
  settings: Record<string, unknown>;
  /** Services that have a saved key: names only. */
  savedKeys: string[];
}

/** Everything needed to understand a problem, with every known key masked. */
export function buildProblemReport(input: ReportInput, log: Log): string {
  const settings = Object.entries(input.settings).map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`);
  const lines = log.recent();
  const text = [
    "# Отчёт о проблеме dimosi",
    "",
    `- dimosi: ${input.version}`,
    `- VS Code: ${input.vscodeVersion}`,
    `- ОС: ${input.os}`,
    `- Node.js: ${input.node}`,
    `- Сохранены ключи для: ${input.savedKeys.join(", ") || "нет"}`,
    "",
    "## Настройки",
    ...settings,
    "",
    "## Последняя ошибка",
    log.lastError ?? "нет",
    "",
    `## Журнал (последние ${lines.length} строк)`,
    ...lines,
    "",
  ].join("\n");
  // Masked once more as a whole: the report leaves the computer.
  return log.redact(text);
}

/** Only the address of a custom server: a path or query may carry a token. */
export function serverOrigin(url: string): string {
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "(неверный адрес)";
  }
}
