import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import { downloadVerified, fetchManifest, isNewerVersion, type UpdateManifest } from "@dimosi/core";

const UPDATE_URL = __DIMOSI_UPDATE_URL__;
const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INSTALLED_KEY = "dimosi.update.installedVersion";

/**
 * Self-update from the owner's server: VS Code only auto-updates Marketplace
 * extensions. Checks latest.json, verifies the checksum, installs the new
 * VSIX in the background and offers a window reload.
 */
export class Updater implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private context: vscode.ExtensionContext,
    /** True while the agent is working: installing then would interrupt the user. */
    private isBusy: () => boolean,
  ) {}

  get enabled(): boolean {
    return Boolean(UPDATE_URL) && vscode.workspace.getConfiguration("dimosi").get<boolean>("autoUpdate", true);
  }

  get currentVersion(): string {
    return this.context.extension.packageJSON.version as string;
  }

  start(): void {
    if (!UPDATE_URL) return;
    this.timer = setTimeout(() => {
      void this.check(false);
      this.timer = setInterval(() => void this.check(false), CHECK_INTERVAL_MS);
    }, FIRST_CHECK_DELAY_MS);
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearInterval(this.timer);
  }

  /** `manual` shows every outcome; background checks stay silent unless an update is installed. */
  async check(manual: boolean): Promise<void> {
    if (!UPDATE_URL) {
      if (manual) void vscode.window.showInformationMessage("Эта сборка dimosi собрана без адреса обновлений.");
      return;
    }
    if (!manual && !this.enabled) return;
    if (this.running) return;
    this.running = true;
    try {
      const manifest = await fetchManifest(UPDATE_URL);
      const installed = this.context.globalState.get<string>(INSTALLED_KEY);
      if (!isNewerVersion(manifest.version, this.currentVersion)) {
        if (manual) void vscode.window.showInformationMessage(`У вас последняя версия dimosi (${this.currentVersion}).`);
        return;
      }
      if (installed === manifest.version) {
        // Already installed, waiting for a window reload.
        await this.offerReload(manifest);
        return;
      }
      await this.waitUntilIdle();
      await this.install(manifest);
    } catch (e) {
      if (manual) void vscode.window.showErrorMessage(`dimosi: не удалось проверить обновления. ${(e as Error).message}`);
      else console.warn("[dimosi] update check failed:", e);
    } finally {
      this.running = false;
    }
  }

  private async install(manifest: UpdateManifest): Promise<void> {
    const data = await downloadVerified(UPDATE_URL, manifest.vsix);
    const dir = vscode.Uri.joinPath(this.context.globalStorageUri, "updates");
    await fs.mkdir(dir.fsPath, { recursive: true });
    const file = vscode.Uri.joinPath(dir, manifest.vsix.file);
    await fs.writeFile(file.fsPath, data);
    await vscode.commands.executeCommand("workbench.extensions.installExtension", file);
    await this.context.globalState.update(INSTALLED_KEY, manifest.version);
    await fs.rm(file.fsPath, { force: true });
    await this.offerReload(manifest);
  }

  private async offerReload(manifest: UpdateManifest): Promise<void> {
    const notes = manifest.notes ? ` ${manifest.notes}` : "";
    const choice = await vscode.window.showInformationMessage(
      `dimosi обновлён до версии ${manifest.version}.${notes} Перезагрузите окно, чтобы включить новую версию.`,
      "Перезагрузить",
      "Позже",
    );
    if (choice === "Перезагрузить") await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }

  private async waitUntilIdle(): Promise<void> {
    while (this.isBusy()) await new Promise((r) => setTimeout(r, 15_000));
  }
}
