import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { errorText } from "./errorText";
import { log } from "./log";

/**
 * A notice outside VS Code: on a Mac the system notification, elsewhere VS Code's own.
 * Only dimosi's fixed texts are shown, never anything from the chat.
 */
export function systemNotification(text: string): void {
  if (process.platform !== "darwin") {
    void vscode.window.showInformationMessage(text);
    return;
  }
  // The text goes as an argument, so it is never read as part of the script.
  execFile(
    "/usr/bin/osascript",
    ["-e", "on run argv", "-e", 'display notification (item 1 of argv) with title "dimosi"', "-e", "end run", text],
    { timeout: 10_000 },
    (e) => {
      if (e) log.warn(`notification not shown: ${errorText(e)}`);
    },
  );
}

/** True when the user is looking at another program: only then is a notice worth it. */
export const inBackground = (): boolean => !vscode.window.state.focused;
