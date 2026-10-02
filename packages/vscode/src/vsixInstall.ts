import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { errorText } from "./errorText";
import { log } from "./log";

/** Where the `code` command line lives inside a VS Code installation. */
export function codeCliCandidates(appRoot: string, platform: NodeJS.Platform): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  const name = platform === "win32" ? "code.cmd" : "code";
  return [
    p.join(appRoot, "bin", name), // macOS: …/Contents/Resources/app/bin/code
    p.join(appRoot, "..", "..", "bin", name), // Windows and Linux: <install>/bin/code
  ];
}

/** Installs a VSIX with VS Code's own command line, the way `code --install-extension` does. */
export function runCodeCli(vsixPath: string): Promise<void> {
  const cli = codeCliCandidates(vscode.env.appRoot, process.platform).find((c) => existsSync(c));
  if (!cli) return Promise.reject(new Error("не найдена командная строка VS Code (bin/code)"));
  return new Promise((resolve, reject) => {
    execFile(
      cli,
      ["--install-extension", vsixPath, "--force"],
      { timeout: 120_000, shell: process.platform === "win32", windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve();
        const detail = `${stderr}\n${stdout}`.split("\n").map((l) => l.trim()).filter((l) => l && !/DeprecationWarning|trace-deprecation/.test(l));
        reject(new Error(`code --install-extension: ${detail.slice(-3).join(" ") || err.message}`));
      },
    );
  });
}

/**
 * Installs a downloaded, verified VSIX. VS Code's install command is tried
 * first; if it refuses (VS Code 1.140 was seen rejecting without any message),
 * the `code` command line installs the same file.
 */
export async function installVsix(file: vscode.Uri, cli: (vsixPath: string) => Promise<void> = runCodeCli): Promise<"command" | "cli"> {
  try {
    await vscode.commands.executeCommand("workbench.extensions.installExtension", file);
    return "command";
  } catch (e) {
    const first = errorText(e);
    log.warn(`installing through the VS Code command failed: ${first}; trying the code command line`);
    try {
      await cli(file.fsPath);
    } catch (e2) {
      throw new Error(`установка не удалась: ${first}; ${errorText(e2)}`);
    }
    return "cli";
  }
}
