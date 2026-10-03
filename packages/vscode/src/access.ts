import * as vscode from "vscode";
import { accessSummary, createAccess, extraFolderProblem, modeLabel, realPath, type AccessMode, type ExtraFolder } from "@dimosi/core";
import { readSettings, updateSetting } from "./settings";

/** The "Доступ" line of the chat panel and its tooltip. */
export function accessStatus(root: string | undefined, folders: ExtraFolder[]): { access: string; accessDetail: string } {
  if (!root) return { access: "папка проекта не открыта", accessDetail: "" };
  const policy = createAccess(root, folders);
  const skipped = policy.rejected.length ? ` · не подключено: ${policy.rejected.length}` : "";
  return {
    access: accessSummary(policy) + skipped,
    accessDetail: [
      `${root} — проект, ${modeLabel("write")}`,
      ...policy.folders.map((f) => `${f.path} — ${modeLabel(f.mode)}`),
      ...policy.rejected.map((f) => `${f.path} — не подключена: ${f.reason}`),
    ].join("\n"),
  };
}

const save = (folders: ExtraFolder[]) => updateSetting("extraFolders", folders.map((f) => ({ path: f.path, access: f.mode })));

type Item = vscode.QuickPickItem & { run?: () => unknown };

/** "Изменить" in the chat panel: the folders outside the project that the agent may reach. */
export async function editAccess(root: string | undefined): Promise<void> {
  // The list is shown again after each change, until the user closes it.
  for (;;) {
    const folders = readSettings().extraFolders;
    const items: Item[] = [
      ...folders.map((f, i): Item => {
        const problem = extraFolderProblem(f.path, root);
        return {
          label: `$(folder) ${f.path}`,
          description: problem ? `не подключена: ${problem}` : modeLabel(f.mode),
          run: () => changeFolder(folders, i),
        };
      }),
      { label: "$(add) Открыть агенту ещё одну папку…", run: () => addFolder(folders, root) },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: "Доступ агента к папкам вне проекта",
      placeHolder: folders.length ? "Выберите папку, чтобы изменить доступ или убрать её" : "Сейчас агент видит только проект",
    });
    if (!pick?.run) return;
    await pick.run();
  }
}

async function pickMode(): Promise<AccessMode | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: "Только чтение", detail: "Агент читает файлы и ищет по ним. Изменить ничего не сможет, командами тоже.", mode: "read" as const },
      { label: "Чтение и запись", detail: "Агент может менять файлы. Подтверждения работают так же, как в проекте.", mode: "write" as const },
    ],
    { title: "Что агенту можно в этой папке?" },
  );
  return pick?.mode;
}

async function addFolder(folders: ExtraFolder[], root: string | undefined): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    title: "Какую папку открыть агенту",
    openLabel: "Открыть агенту",
  });
  const folder = uris?.[0]?.fsPath;
  if (!folder) return;
  const problem = folders.some((f) => realPath(f.path) === realPath(folder)) ? "она уже есть в списке" : extraFolderProblem(folder, root);
  if (problem) {
    void vscode.window.showWarningMessage(`Папку ${folder} открыть нельзя: ${problem}.`);
    return;
  }
  const mode = await pickMode();
  if (mode) await save([...folders, { path: folder, mode }]);
}

async function changeFolder(folders: ExtraFolder[], index: number): Promise<void> {
  const folder = folders[index];
  const other: AccessMode = folder.mode === "write" ? "read" : "write";
  const pick = await vscode.window.showQuickPick(
    [
      { label: other === "write" ? "Разрешить запись" : "Оставить только чтение", action: "mode" as const },
      { label: "Убрать из списка", detail: "Агент перестанет видеть эту папку. Сама папка и файлы в ней не меняются.", action: "remove" as const },
    ],
    { title: folder.path },
  );
  if (pick?.action === "mode") await save(folders.map((f, i) => (i === index ? { ...f, mode: other } : f)));
  if (pick?.action === "remove") await save(folders.filter((_, i) => i !== index));
}
