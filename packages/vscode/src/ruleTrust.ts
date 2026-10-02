import * as vscode from "vscode";
import { rememberingTrust, type RuleFile, type RuleTrust, type TrustDecisions } from "@dimosi/core";
import { log } from "./log";

const KEY = "dimosi.ruleTrust";
const PREVIEW_LINES = 5;
const PREVIEW_LINE_CHARS = 100;

/** Trust decisions for project rules, kept across windows (by hash of path and text). */
export function trustDecisions(context: vscode.ExtensionContext): TrustDecisions {
  const all = () => context.globalState.get<Record<string, boolean>>(KEY, {});
  return {
    get: (hash) => all()[hash],
    set: async (hash, trusted) => {
      await context.globalState.update(KEY, { ...all(), [hash]: trusted });
      log.info(`project rules ${trusted ? "trusted" : "not trusted"} by the user`);
    },
  };
}

/** First lines of the file, enough to recognize it; the whole text is one click away. */
export function rulesPreview(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim());
  const head = lines.slice(0, PREVIEW_LINES).map((l) => (l.length > PREVIEW_LINE_CHARS ? `${l.slice(0, PREVIEW_LINE_CHARS)}…` : l));
  return head.join("\n") + (lines.length > PREVIEW_LINES ? "\n…" : "");
}

/**
 * Asks in a short dialog; Esc means "not now". Native dialogs do not scroll, so
 * the file itself is never put there in full: «Открыть файл» shows it in the editor.
 */
export async function askAboutRules(file: RuleFile): Promise<boolean | undefined> {
  const TRUST = "Доверять";
  const DENY = "Не доверять";
  const OPEN = "Открыть файл";
  const lines = file.text.split("\n").length;
  const choice = await vscode.window.showWarningMessage(
    `Доверять правилам из ${file.label} в этом проекте?`,
    {
      modal: true,
      detail:
        `Текст файла станет указаниями для агента. В чужом проекте там могут быть вредные указания. ` +
        `Не уверены — нажмите «${OPEN}» и прочитайте его.\n\n` +
        `${file.path} (${lines} строк)\n\n${rulesPreview(file.text)}`,
    },
    TRUST,
    DENY,
    OPEN,
  );
  if (choice === OPEN) {
    await vscode.window.showTextDocument(vscode.Uri.file(file.path), { preview: true });
    void vscode.window.showInformationMessage(
      `Эта задача выполняется без ${file.label}. Прочитайте файл и решите: нажмите плашку «Правила» над полем ввода или отправьте следующую задачу — dimosi спросит снова.`,
    );
    return undefined;
  }
  return choice === TRUST ? true : choice === DENY ? false : undefined;
}

export function vscodeRuleTrust(context: vscode.ExtensionContext): RuleTrust {
  return rememberingTrust(trustDecisions(context), askAboutRules);
}
