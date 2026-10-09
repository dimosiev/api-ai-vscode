import * as vscode from "vscode";
import { CHATGPT_KEY, signInChatGPT, signOutChatGPT } from "@dimosi/core";
import type { SecretKeyStore } from "./keyStore";
import { log } from "./log";

const USAGE_PAGE = "ChatGPT → Settings (Настройки) → Usage (Использование)";

/** "dimosi: Войти через ChatGPT": the browser, the user's consent, the sign-in kept in the Keychain. */
export async function signInWithChatGPT(keys: SecretKeyStore): Promise<void> {
  const account = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Вход через ChatGPT: войдите и разрешите доступ в открывшемся браузере…", cancellable: true },
    (_progress, cancel) => {
      const stop = new AbortController();
      cancel.onCancellationRequested(() => stop.abort());
      return signInChatGPT({
        keys,
        signal: stop.signal,
        onSecret: (value) => log.addSecret(value),
        openBrowser: async (url) => {
          // As text: VS Code re-encodes a parsed address, and the service compares it letter by letter.
          if (!(await vscode.env.openExternal(url.replaceAll("+", "%20") as unknown as vscode.Uri))) throw new Error("Не удалось открыть браузер для входа.");
        },
      });
    },
  );
  log.info("signed in with ChatGPT");
  void vscode.window.showInformationMessage(
    `Вход в ChatGPT выполнен${account.email ? ` (${account.email})` : ""}. Запросы dimosi через сервис «ChatGPT (подписка)» идут за счёт вашей подписки. Расход и лимит для dimosi: ${USAGE_PAGE}.`,
  );
}

/** "dimosi: Выйти из ChatGPT". */
export async function signOutOfChatGPT(keys: SecretKeyStore): Promise<void> {
  if (!(await keys.get(CHATGPT_KEY))) return void vscode.window.showInformationMessage("Вход в ChatGPT не выполнен: выходить не из чего.");
  const { revoked } = await signOutChatGPT({ keys });
  log.info(`signed out of ChatGPT, ${revoked ? "confirmed by the service" : "not confirmed by the service"}`);
  if (revoked) void vscode.window.showInformationMessage("Вы вышли из ChatGPT: dimosi больше не может тратить подписку.");
  else void vscode.window.showWarningMessage("Вход удалён с этого компьютера, но OpenAI не подтвердил отключение. Отключите dimosi сами в настройках ChatGPT (раздел подключённых приложений).");
}
