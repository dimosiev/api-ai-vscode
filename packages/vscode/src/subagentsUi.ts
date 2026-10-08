import * as vscode from "vscode";
import { BUILTIN_SUBAGENTS, getPreset, parseSubagents, PRESETS, withBuiltinSubagents, type SubagentDef } from "@dimosi/core";
import { chooseModel } from "./modelPicker";
import type { SecretKeyStore } from "./keyStore";
import { readSettings, updateSetting } from "./settings";

type Item = vscode.QuickPickItem & { def?: SubagentDef; add?: true };

/** How the helper's service and model read for the user. */
function whereItRuns(def: SubagentDef, chat: { provider: string; model: string }): string {
  const provider = def.provider ?? chat.provider;
  const model = def.model ?? (provider === chat.provider ? chat.model : getPreset(provider).defaultModel);
  return `${def.provider ? getPreset(provider).label : "сервис чата"} · ${model}${def.model || def.provider ? "" : " (как в чате)"}`;
}

const save = (list: SubagentDef[]) => updateSetting("subagents", list.map(({ name, description, provider, model, maxSteps }) => ({ name, description, ...(provider && { provider }), ...(model && { model }), ...(maxSteps && { maxSteps }) })));

/**
 * «Помощники»: the helpers the agent can start, each with its own service and model. Done with
 * questions and lists, so that no setting has to be typed by hand.
 */
export async function manageSubagents(keys: SecretKeyStore): Promise<void> {
  for (;;) {
    const settings = readSettings();
    const all = withBuiltinSubagents(settings.subagents);
    const items: Item[] = [
      ...all.map((def): Item => ({
        label: `$(hubot) ${def.name}`,
        description: whereItRuns(def, settings),
        detail: def.description + (BUILTIN_SUBAGENTS.some((b) => b.name === def.name) && !settings.subagents.some((u) => u.name === def.name) ? " (встроенный)" : ""),
        def,
      })),
      { label: "$(add) Добавить помощника", add: true },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: "Помощники агента",
      placeHolder: "Помощник читает проект на отдельной (обычно более дешёвой) модели и присылает агенту короткий итог. Выберите, чтобы изменить.",
    });
    if (!pick) return;
    if (pick.add) await addSubagent(keys, all);
    else await editSubagent(keys, pick.def!);
  }
}

async function addSubagent(keys: SecretKeyStore, existing: SubagentDef[]): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: "Имя помощника",
    prompt: "Латинскими буквами, например: reader или scout. По нему агент будет вызывать помощника.",
    ignoreFocusOut: true,
    validateInput: (v) =>
      !/^[a-z][a-z0-9-]{0,31}$/.test(v.trim()) ? "Маленькие латинские буквы, цифры и дефис, начинать с буквы"
      : existing.some((d) => d.name === v.trim()) ? "Помощник с таким именем уже есть"
      : undefined,
  });
  if (!name) return;
  const description = await vscode.window.showInputBox({
    title: "Для чего этот помощник?",
    prompt: "Одна фраза. Её читает главный агент, чтобы понять, когда звать помощника. Например: «Быстро ищет по проекту и отвечает на вопросы о коде».",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Опишите задачу помощника"),
  });
  if (!description) return;
  const def: SubagentDef = { name: name.trim(), description: description.trim() };
  if (!(await pickWhere(keys, def))) return;
  await save([...readSettings().subagents, def]);
  void vscode.window.showInformationMessage(`Помощник «${def.name}» добавлен. Агент увидит его в новом чате; первый запуск спросит разрешения.`);
}

async function editSubagent(keys: SecretKeyStore, def: SubagentDef): Promise<void> {
  const mine = readSettings().subagents.some((u) => u.name === def.name);
  const action = await vscode.window.showQuickPick(
    [
      { label: "$(sparkle) Выбрать сервис и модель", id: "where" },
      { label: "$(edit) Изменить описание", id: "description" },
      ...(mine ? [{ label: "$(trash) Удалить помощника", id: "delete" }] : []),
    ],
    { title: `Помощник «${def.name}»` },
  );
  if (!action) return;
  const list = readSettings().subagents.filter((u) => u.name !== def.name);
  if (action.id === "delete") {
    if (await vscode.window.showWarningMessage(`Удалить помощника «${def.name}»?`, { modal: true }, "Удалить")) await save(list);
    return;
  }
  const next = { ...def };
  if (action.id === "where") {
    if (!(await pickWhere(keys, next))) return;
  } else {
    const description = await vscode.window.showInputBox({ title: "Для чего этот помощник?", value: def.description, ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : "Опишите задачу помощника") });
    if (!description) return;
    next.description = description.trim();
  }
  // The built-in helper becomes the user's own once changed; its place in the list does not matter.
  await save(parseSubagents([...list, next]));
}

/** Asks for the service and the model; changes `def`. false: the user closed a dialog. */
async function pickWhere(keys: SecretKeyStore, def: SubagentDef): Promise<boolean> {
  const chat = readSettings();
  const saved = new Set(await keys.list());
  const SAME = "same";
  const service = await vscode.window.showQuickPick(
    [
      { label: "Как в основном чате", description: getPreset(chat.provider).label, detail: "тот же сервис и ключ; можно выбрать другую модель", id: SAME },
      ...PRESETS.filter((p) => p.id !== chat.provider).map((p) => ({
        label: p.label,
        detail: !p.requiresKey ? "ключ не обязателен" : saved.has(p.id) ? "ключ сохранён ✓" : "нужен API-ключ (спросим дальше)",
        id: p.id,
      })),
    ],
    { title: `Помощник «${def.name}»: на каком сервисе работать?`, placeHolder: "Тексты файлов, которые помощник прочитает, уйдут выбранному сервису." },
  );
  if (!service) return false;
  const providerId = service.id === SAME ? chat.provider : service.id;
  const sameAsChat = providerId === chat.provider;
  const model = await chooseModel(keys, providerId, def.model ?? "", `Модель для помощника «${def.name}» (подойдёт быстрая и дешёвая, но умеющая работать с инструментами)`);
  if (!model) return false;
  def.provider = sameAsChat ? undefined : providerId;
  def.model = model;
  return true;
}
