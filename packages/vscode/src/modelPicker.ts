import * as vscode from "vscode";
import { getPreset, maskKey, PRESETS } from "@dimosi/core";
import { errorText } from "./errorText";
import type { SecretKeyStore } from "./keyStore";
import { buildProvider, readSettings, updateSetting } from "./settings";

export async function pickProvider(
  keys: SecretKeyStore,
  placeHolder: string,
  filter: (p: (typeof PRESETS)[number]) => boolean = () => true,
): Promise<string | undefined> {
  const saved = new Set(await keys.list());
  const current = readSettings().provider;
  const items = PRESETS.filter(filter).map((p) => ({
    label: p.label,
    description: p.id === current ? "сейчас выбран" : "",
    detail: !p.requiresKey ? "ключ не обязателен" : saved.has(p.id) ? "ключ сохранён ✓" : "нужен API-ключ",
    id: p.id,
  }));
  const choice = await vscode.window.showQuickPick(items, { placeHolder });
  return choice?.id;
}

export async function askAndStoreKey(keys: SecretKeyStore, presetId: string): Promise<boolean> {
  const preset = getPreset(presetId);
  const value = await vscode.window.showInputBox({
    title: `API-ключ для ${preset.label}`,
    prompt: "Вставьте ключ (Cmd+V / Ctrl+V) и нажмите Enter. Ключ хранится в защищённом хранилище системы.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Ключ не может быть пустым"),
  });
  if (!value) return false;
  await keys.set(presetId, value.trim());
  void vscode.window.showInformationMessage(`Ключ для ${preset.label} сохранён (${maskKey(value.trim())}).`);
  return true;
}


/**
 * The model on a service, picked from the list the service itself gives (any service, not
 * only the chat's), or typed in. Asks for the key and the address first if they are missing.
 * undefined: the user closed the dialog.
 */
export async function chooseModel(keys: SecretKeyStore, presetId: string, currentModel: string, placeHolder = "Выберите модель (можно начать печатать для поиска)"): Promise<string | undefined> {
  const preset = getPreset(presetId);
  if (presetId === "custom") {
    const url = await vscode.window.showInputBox({
      title: "Адрес OpenAI-совместимого API",
      prompt: "Например: http://localhost:1234/v1",
      value: readSettings().customBaseUrl,
      ignoreFocusOut: true,
      validateInput: (v) => (/^https?:\/\//.test(v.trim()) ? undefined : "Адрес должен начинаться с http:// или https://"),
    });
    if (!url) return undefined;
    await updateSetting("customBaseUrl", url.trim());
  }

  if (preset.requiresKey && !(await keys.get(presetId))) {
    if (!(await askAndStoreKey(keys, presetId))) return undefined;
  }

  let models: string[] = [];
  try {
    const provider = await buildProvider({ ...readSettings(), provider: presetId }, keys, presetId);
    models = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Загружаю список моделей ${preset.label}…` },
      () => provider.listModels(),
    );
  } catch (e) {
    void vscode.window.showWarningMessage(`Не удалось получить список моделей: ${errorText(e)}`);
  }

  const MANUAL = "$(edit) Ввести имя модели вручную";
  const ordered = [...new Set([preset.defaultModel, ...models].filter(Boolean))];
  let model: string | undefined;
  if (ordered.length) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: MANUAL },
        ...ordered.map((m) => ({
          label: m,
          description: [m === preset.defaultModel ? "рекомендуется" : "", m === currentModel ? "текущая" : ""].filter(Boolean).join(", "),
        })),
      ],
      { placeHolder, matchOnDescription: true },
    );
    if (!pick) return undefined;
    model = pick.label === MANUAL ? undefined : pick.label;
  }
  model ??= await vscode.window.showInputBox({
    title: "Имя модели",
    value: currentModel || preset.defaultModel,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Введите имя модели"),
  });
  if (!model) return undefined;
  return model.trim();
}
