import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  defaultGlobalRulesPath,
  exportKeys,
  GENERATE_RULES_PROMPT,
  getPreset,
  GLOBAL_RULES_TEMPLATE,
  importKeys,
  loadRules,
  maskKey,
  PRESETS,
  PROJECT_RULES_DIR,
  PROJECT_RULES_TEMPLATE,
  rememberingTrust,
} from "@dimosi/core";
import { editAccess } from "./access";
import { showCommandRules } from "./commandRules";
import { errorText } from "./errorText";
import { PROPOSED_SCHEME, ProposedContentProvider, WebviewApproval } from "./approval";
import { selectionAttachment } from "./attachments";
import { ChatViewProvider } from "./chatView";
import { SecretKeyStore } from "./keyStore";
import { log } from "./log";
import { buildProblemReport, serverOrigin } from "./report";
import { askAboutRules, trustDecisions } from "./ruleTrust";
import { buildProvider, readSettings, updateSetting } from "./settings";
import { EFFORT_LABELS } from "./protocol";
import { Updater } from "./updater";

const EDITOR_PROMPTS = {
  explain: "Объясни этот код простыми словами: что он делает и зачем. Ничего не меняй.",
  fix: "Найди ошибки и проблемы в этом коде и исправь их. Коротко объясни, что было не так.",
  improve: "Улучши этот код: читаемость, надёжность, понятные имена. Поведение не меняй. Коротко объясни изменения.",
};

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("dimosi", { log: true });
  log.setSink((level, message) => channel[level](message));
  context.subscriptions.push(channel, { dispose: () => log.setSink(undefined) });
  log.info(`dimosi ${context.extension.packageJSON.version} started: VS Code ${vscode.version}, ${describeOs()}`);
  logSettings();

  const keys = new SecretKeyStore(context);
  const proposed = new ProposedContentProvider();
  const chat = new ChatViewProvider(context, keys, (ui) => new WebviewApproval(ui, proposed));

  const command = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await fn(...args);
      } catch (e) {
        log.error(`command ${id} failed: ${errorText(e)}`);
        void vscode.window.showErrorMessage(`dimosi: ${errorText(e)}`);
      }
    });

  const root = () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.scheme === "file" ? folder.uri.fsPath : undefined;
  };

  const editorTask = (prompt: string) => async () => {
    const editor = vscode.window.activeTextEditor;
    const att = editor && selectionAttachment(editor, root());
    if (!att) return void vscode.window.showInformationMessage("Сначала выделите код в редакторе.");
    await chat.sendTask(prompt, [att]);
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposed),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("dimosi")) return;
      logSettings();
      void chat.postStatus();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void chat.postStatus()),
    keys.onDidChange(() => void chat.postStatus()),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new FixWithDimosiProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),

    command("dimosi.newChat", () => chat.newChat()),
    command("dimosi.reportProblem", () => reportProblem(context, keys)),
    command("dimosi.setApiKey", async () => {
      const presetId = await pickProvider(keys, "Для какого сервиса ввести ключ?", (p) => p.requiresKey || p.id === "custom");
      if (presetId) await askAndStoreKey(keys, presetId);
    }),
    command("dimosi.deleteApiKey", async () => {
      const names = await keys.list();
      if (!names.length) return vscode.window.showInformationMessage("Сохранённых ключей нет.");
      const name = await vscode.window.showQuickPick(names, { placeHolder: "Какой ключ удалить?" });
      if (!name) return;
      await keys.delete(name);
      void vscode.window.showInformationMessage(`Ключ ${name} удалён.`);
    }),
    command("dimosi.selectModel", () => selectModel(keys)),
    command("dimosi.exportKeys", () => exportKeysCommand(keys)),
    command("dimosi.importKeys", () => importKeysCommand(keys)),
    command("dimosi.toggleApproval", async () => {
      if (readSettings().approvalMode === "ask") {
        const ok = await vscode.window.showWarningMessage(
          "Отключить подтверждения? Агент будет сам менять файлы и запускать команды без вопросов.",
          { modal: true },
          "Отключить",
        );
        if (ok) await updateSetting("approvalMode", "auto");
      } else {
        await updateSetting("approvalMode", "ask");
      }
    }),

    command("dimosi.togglePlanFirst", () => chat.togglePlanFirst()),
    command("dimosi.selectEffort", selectEffort),
    command("dimosi.editAccess", () => editAccess(root())),
    command("dimosi.showCommandRules", () => showCommandRules(context, root())),

    // Rules
    command("dimosi.showRules", () => showRules(context, root())),
    command("dimosi.openGlobalRules", () => openOrCreate(defaultGlobalRulesPath(), GLOBAL_RULES_TEMPLATE)),
    command("dimosi.createProjectRules", async () => {
      const r = root();
      if (!r) return void vscode.window.showWarningMessage("Сначала откройте папку проекта.");
      const file = path.join(r, PROJECT_RULES_DIR, "rules.md");
      // dimosi wrote this text itself, so the trust question would be pointless.
      if (await openOrCreate(file, PROJECT_RULES_TEMPLATE)) await rememberingTrust(trustDecisions(context)).remember?.(file, PROJECT_RULES_TEMPLATE);
    }),
    command("dimosi.generateRules", async () => {
      if (!root()) return void vscode.window.showWarningMessage("Сначала откройте папку проекта.");
      await chat.sendTask(GENERATE_RULES_PROMPT);
    }),

    // Editor actions
    command("dimosi.explainSelection", editorTask(EDITOR_PROMPTS.explain)),
    command("dimosi.fixSelection", editorTask(EDITOR_PROMPTS.fix)),
    command("dimosi.improveSelection", editorTask(EDITOR_PROMPTS.improve)),
    command("dimosi.addSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      const att = editor && selectionAttachment(editor, root());
      if (!att) return void vscode.window.showInformationMessage("Сначала выделите код в редакторе.");
      await chat.show();
      chat.addAttachment(att);
      chat.post({ type: "focus_input" });
    }),
    command("dimosi.fixDiagnostic", async (uri: vscode.Uri, range: vscode.Range, message: string) => {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false });
      // Give the model a few lines around the problem.
      const start = Math.max(0, range.start.line - 5);
      const end = Math.min(doc.lineCount - 1, range.end.line + 5);
      editor.selection = new vscode.Selection(start, 0, end, doc.lineAt(end).text.length);
      const att = selectionAttachment(editor, root());
      await chat.sendTask(`Исправь ошибку в строке ${range.start.line + 1}: «${message}».`, att ? [att] : []);
    }),
  );

  const updater = new Updater(context, () => chat.busy);
  context.subscriptions.push(updater, command("dimosi.checkForUpdates", () => updater.check(true)));
  updater.start();

  void welcomeOnFirstRun(context, keys);
}

export function deactivate(): void {}

function describeOs(): string {
  return `${os.type()} ${os.release()} ${process.arch}`;
}

function logSettings(): void {
  const s = readSettings();
  log.info(
    `settings: provider ${s.provider}, model ${s.model || "(none)"}, approvals ${s.approvalMode}, max steps ${s.maxSteps}, extra folders ${s.extraFolders.length}` +
      (s.effort ? `, effort ${s.effort}` : "") +
      (s.provider === "custom" ? `, server ${serverOrigin(s.customBaseUrl)}` : ""),
  );
}

/** "dimosi: Сообщить о проблеме": versions, settings and the journal, to send to whoever helps. */
async function reportProblem(context: vscode.ExtensionContext, keys: SecretKeyStore): Promise<void> {
  const s = readSettings();
  const report = buildProblemReport(
    {
      version: context.extension.packageJSON.version,
      vscodeVersion: vscode.version,
      os: describeOs(),
      node: process.versions.node,
      settings: {
        provider: s.provider,
        model: s.model,
        customBaseUrl: serverOrigin(s.customBaseUrl),
        approvalMode: s.approvalMode,
        maxSteps: s.maxSteps,
        autoUpdate: vscode.workspace.getConfiguration("dimosi").get<boolean>("autoUpdate", true),
      },
      savedKeys: await keys.list(),
    },
    log,
  );
  const COPY = "Скопировать в буфер обмена";
  const SAVE = "Сохранить в файл…";
  const choice = await vscode.window.showInformationMessage(
    "Отчёт о проблеме готов: версии, настройки и журнал dimosi. Ключей, текста переписки и содержимого файлов в нём нет.",
    COPY,
    SAVE,
  );
  if (choice === COPY) {
    await vscode.env.clipboard.writeText(report);
    void vscode.window.showInformationMessage("Отчёт скопирован. Вставьте его в письмо или сообщение (Cmd+V / Ctrl+V).");
  } else if (choice === SAVE) {
    const date = new Date().toISOString().slice(0, 10);
    const target = await vscode.window.showSaveDialog({
      title: "Куда сохранить отчёт",
      defaultUri: vscode.Uri.file(path.join(os.homedir(), "Desktop", `dimosi-report-${date}.txt`)),
      filters: { "Текст": ["txt"] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(report, "utf8"));
    void vscode.window.showInformationMessage(`Отчёт сохранён: ${target.fsPath}`);
  }
}

/** Lightbulb on errors and warnings: "Fix with dimosi". */
class FixWithDimosiProvider implements vscode.CodeActionProvider {
  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const diag = ctx.diagnostics.find(
      (d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning,
    );
    if (!diag) return [];
    const action = new vscode.CodeAction("Исправить с помощью dimosi", vscode.CodeActionKind.QuickFix);
    action.command = {
      command: "dimosi.fixDiagnostic",
      title: "Исправить с помощью dimosi",
      arguments: [document.uri, diag.range, diag.message],
    };
    action.diagnostics = [diag];
    return [action];
  }
}

async function welcomeOnFirstRun(context: vscode.ExtensionContext, keys: SecretKeyStore): Promise<void> {
  if (context.globalState.get("dimosi.welcomed")) return;
  await context.globalState.update("dimosi.welcomed", true);
  if ((await keys.list()).length) return;
  const choice = await vscode.window.showInformationMessage(
    "dimosi установлен. Подключите нейросеть: выберите сервис и введите API-ключ, или импортируйте ключи из файла.",
    "Подключить",
    "Импортировать ключи",
  );
  if (choice === "Подключить") await vscode.commands.executeCommand("dimosi.selectModel");
  if (choice === "Импортировать ключи") await vscode.commands.executeCommand("dimosi.importKeys");
}

/** Returns true when the file was created from the template. */
async function openOrCreate(filePath: string, template: string): Promise<boolean> {
  let created = false;
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, template, "utf8");
    created = true;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(filePath));
  return created;
}

async function showRules(context: vscode.ExtensionContext, root: string | undefined): Promise<void> {
  // Lists without asking: undecided files are asked about when a task starts, or from here.
  const decisions = trustDecisions(context);
  const rules = root ? await loadRules(root, undefined, { isTrusted: async (f) => decisions.get(f.hash) ?? false }) : { sources: [] };
  type Item = vscode.QuickPickItem & { run: () => unknown };
  const items: Item[] = [];
  if (rules.sources.length) {
    items.push({ label: "Файлы правил", kind: vscode.QuickPickItemKind.Separator, run: () => {} });
    for (const r of rules.sources) {
      if (r.skipped) {
        const denied = decisions.get(r.hash!) === false;
        items.push({
          label: `$(shield) ${r.label}`,
          description: denied ? "не подключён: вы не доверяете — выберите, чтобы решить заново" : "не подключён: ждёт вашего решения — выберите, чтобы решить",
          detail: r.path,
          run: async () => {
            const text = await fs.readFile(r.path, "utf8");
            const answer = await askAboutRules({ label: r.label, path: r.path, text: text.trim(), hash: r.hash! });
            if (answer !== undefined) await decisions.set(r.hash!, answer);
          },
        });
        continue;
      }
      items.push({
        label: `${r.scope === "global" ? "$(globe)" : "$(folder)"} ${r.label}`,
        description: r.truncated ? "обрезано — файл слишком большой" : `${r.chars} символов`,
        detail: r.path,
        run: () => vscode.window.showTextDocument(vscode.Uri.file(r.path)),
      });
    }
  }
  items.push(
    { label: "Действия", kind: vscode.QuickPickItemKind.Separator, run: () => {} },
    { label: "$(globe) Открыть глобальные правила", description: "для всех проектов", run: () => vscode.commands.executeCommand("dimosi.openGlobalRules") },
  );
  if (root) {
    items.push(
      { label: "$(new-file) Создать правила проекта", description: `${PROJECT_RULES_DIR}/rules.md по шаблону`, run: () => vscode.commands.executeCommand("dimosi.createProjectRules") },
      { label: "$(sparkle) Сгенерировать правила по проекту", description: "агент изучит проект и напишет правила", run: () => vscode.commands.executeCommand("dimosi.generateRules") },
    );
  }
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: rules.sources.length ? "Правила, которые агент читает перед каждым ответом" : "Правил пока нет — создайте их",
  });
  await pick?.run();
}

async function pickProvider(
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

async function askAndStoreKey(keys: SecretKeyStore, presetId: string): Promise<boolean> {
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

const EFFORT_HINTS: Record<string, string> = {
  "": "настройка не передаётся — так dimosi работал всегда",
  low: "быстрее и дешевле; для простых правок",
  medium: "",
  high: "",
  max: "дольше и дороже; для самых трудных задач",
};

async function selectEffort(): Promise<void> {
  const current = readSettings().effort ?? "";
  const items = Object.keys(EFFORT_LABELS).map((value) => ({
    label: EFFORT_LABELS[value][0].toUpperCase() + EFFORT_LABELS[value].slice(1),
    description: [value === current ? "выбрано" : "", EFFORT_HINTS[value]].filter(Boolean).join(" · "),
    value,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: "Усердие модели",
    placeHolder: "Насколько старательно модель работает над ответом. Через Polza AI у Claude это включает размышления (оплачиваются как ответ).",
  });
  if (pick) await updateSetting("effort", pick.value);
}

async function selectModel(keys: SecretKeyStore): Promise<void> {
  const presetId = await pickProvider(keys, "Через какой сервис работать?");
  if (!presetId) return;
  const preset = getPreset(presetId);

  if (presetId === "custom") {
    const url = await vscode.window.showInputBox({
      title: "Адрес OpenAI-совместимого API",
      prompt: "Например: http://localhost:1234/v1",
      value: readSettings().customBaseUrl,
      ignoreFocusOut: true,
      validateInput: (v) => (/^https?:\/\//.test(v.trim()) ? undefined : "Адрес должен начинаться с http:// или https://"),
    });
    if (!url) return;
    await updateSetting("customBaseUrl", url.trim());
  }

  if (preset.requiresKey && !(await keys.get(presetId))) {
    if (!(await askAndStoreKey(keys, presetId))) return;
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
  const current = readSettings();
  const currentModel = current.provider === presetId ? current.model : "";
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
      { placeHolder: "Выберите модель (можно начать печатать для поиска)", matchOnDescription: true },
    );
    if (!pick) return;
    model = pick.label === MANUAL ? undefined : pick.label;
  }
  model ??= await vscode.window.showInputBox({
    title: "Имя модели",
    value: currentModel || preset.defaultModel,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Введите имя модели"),
  });
  if (!model) return;

  await updateSetting("provider", presetId);
  await updateSetting("model", model.trim() === preset.defaultModel ? "" : model.trim());
  void vscode.window.showInformationMessage(`Агент работает через ${preset.label}, модель ${model.trim()}.`);
}

async function askNewPassword(): Promise<string | undefined> {
  const password = await vscode.window.showInputBox({
    title: "Пароль для файла с ключами",
    prompt: "Придумайте пароль. Он понадобится при импорте на другом компьютере.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.length >= 6 ? undefined : "Минимум 6 символов"),
  });
  if (!password) return;
  const again = await vscode.window.showInputBox({ title: "Повторите пароль", password: true, ignoreFocusOut: true });
  if (again !== password) {
    void vscode.window.showErrorMessage("Пароли не совпадают.");
    return;
  }
  return password;
}

async function exportKeysCommand(keys: SecretKeyStore): Promise<void> {
  if (!(await keys.list()).length) {
    void vscode.window.showInformationMessage("Сохранённых ключей нет — экспортировать нечего.");
    return;
  }
  const password = await askNewPassword();
  if (!password) return;
  const target = await vscode.window.showSaveDialog({
    title: "Куда сохранить файл с ключами",
    defaultUri: vscode.Uri.file(path.join(os.homedir(), "Desktop", "dimosi-keys.aienc")),
    filters: { "Ключи dimosi": ["aienc"] },
  });
  if (!target) return;
  const text = await exportKeys(keys, password);
  await vscode.workspace.fs.writeFile(target, Buffer.from(text, "utf8"));
  void vscode.window.showInformationMessage(
    `Ключи сохранены в ${target.fsPath}. Перенесите файл на другой компьютер и выполните там «dimosi: Импортировать ключи из файла…».`,
  );
}

async function importKeysCommand(keys: SecretKeyStore): Promise<void> {
  const files = await vscode.window.showOpenDialog({
    title: "Выберите файл с ключами (.aienc)",
    canSelectMany: false,
    filters: { "Ключи dimosi": ["aienc"], "Все файлы": ["*"] },
  });
  if (!files?.length) return;
  const password = await vscode.window.showInputBox({
    title: "Пароль от файла с ключами",
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) return;
  const text = Buffer.from(await vscode.workspace.fs.readFile(files[0])).toString("utf8");
  let names: string[];
  try {
    names = await importKeys(keys, text, password);
  } catch (e) {
    const msg = errorText(e);
    throw new Error(msg.startsWith("Wrong password") ? "Неверный пароль или файл повреждён." : msg === "This is not a key file." ? "Это не файл с ключами." : msg);
  }
  void vscode.window.showInformationMessage(`Импортировано ключей: ${names.length} (${names.join(", ")}).`);
}
