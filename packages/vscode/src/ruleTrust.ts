import * as vscode from "vscode";
import { rememberingTrust, type RuleFile, type RuleTrust, type TrustDecisions } from "@dimosi/core";
import { log } from "./log";

const KEY = "dimosi.ruleTrust";
const PREVIEW_CHARS = 1500;

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

/** Shows the file in a dialog and asks; Esc means "not now". */
export async function askAboutRules(file: RuleFile): Promise<boolean | undefined> {
  const preview = file.text.length > PREVIEW_CHARS ? `${file.text.slice(0, PREVIEW_CHARS)}\n…` : file.text;
  const TRUST = "Доверять";
  const DENY = "Не доверять";
  const choice = await vscode.window.showWarningMessage(
    `Доверять правилам из ${file.label} в этом проекте?`,
    {
      modal: true,
      detail:
        `Файл найден впервые или изменился. Его текст станет указаниями для агента. ` +
        `В чужом проекте (скачанном из интернета, от подрядчика) там могут быть вредные указания, например запустить опасную команду. ` +
        `Если не уверены, выберите «Не доверять»: агент будет работать без этого файла.\n\n${file.path}\n\n${preview}`,
    },
    TRUST,
    DENY,
  );
  return choice === TRUST ? true : choice === DENY ? false : undefined;
}

export function vscodeRuleTrust(context: vscode.ExtensionContext): RuleTrust {
  return rememberingTrust(trustDecisions(context), askAboutRules);
}
