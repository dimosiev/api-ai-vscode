import * as vscode from "vscode";
import { describeRule, ProjectCommandRules, type CommandRule } from "@dimosi/core";

const STATE_KEY = "dimosi.commandRules";

/**
 * Commands the user allowed with "Always", kept in VS Code's own storage:
 * outside the project, so a project can't bring its own permissions.
 */
export function commandRuleStore(context: vscode.ExtensionContext, root: string): ProjectCommandRules {
  return new ProjectCommandRules(root, {
    load: () => context.globalState.get<unknown>(STATE_KEY),
    save: async (all) => void (await context.globalState.update(STATE_KEY, all)),
  });
}

type Item = vscode.QuickPickItem & { rule?: CommandRule; all?: true };

/** "Запомненные команды": what "Always" allowed in this project, with a way to take it back. */
export async function showCommandRules(context: vscode.ExtensionContext, root: string | undefined): Promise<void> {
  if (!root) return void vscode.window.showWarningMessage("Сначала откройте папку проекта.");
  const store = commandRuleStore(context, root);
  // The list is shown again after each removal, until the user closes it.
  for (;;) {
    const rules = store.list();
    if (!rules.length) {
      void vscode.window.showInformationMessage("В этом проекте нет запомненных команд. Они появляются, когда вы нажимаете «Всегда» на карточке команды.");
      return;
    }
    const items: Item[] = [
      ...rules.map((rule): Item => ({ label: `$(terminal) ${rule.text}`, description: rule.kind === "prefix" ? "и всё, что начинается так же" : "только эта команда", rule })),
      { label: "$(trash) Забыть все", description: "агент снова будет спрашивать про каждую команду", all: true },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: "Команды, которые агент выполняет без вопроса в этом проекте",
      placeHolder: "Выберите команду, чтобы агент снова спрашивал про неё",
    });
    if (!pick) return;
    const question = pick.all ? "Забыть все запомненные команды этого проекта?" : `Снова спрашивать про ${describeRule(pick.rule!)}?`;
    if (!(await vscode.window.showWarningMessage(question, { modal: true }, "Забыть"))) continue;
    if (pick.all) await store.clear();
    else await store.remove(pick.rule!);
  }
}
