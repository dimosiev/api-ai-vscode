import * as vscode from "vscode";
import type { KeyStore } from "@dimosi/core";

const INDEX_KEY = "dimosi.keyNames";

/**
 * Keys go to VS Code SecretStorage (macOS Keychain, Windows Credential
 * Manager, libsecret on Linux). SecretStorage can't enumerate, so the key
 * names (not values) are kept in globalState.
 */
export class SecretKeyStore implements KeyStore {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private context: vscode.ExtensionContext) {}

  get(name: string) {
    return Promise.resolve(this.context.secrets.get(`dimosi.key.${name}`));
  }

  async set(name: string, value: string) {
    await this.context.secrets.store(`dimosi.key.${name}`, value);
    const names = new Set(await this.list());
    names.add(name);
    await this.context.globalState.update(INDEX_KEY, [...names].sort());
    this.changed.fire();
  }

  async delete(name: string) {
    await this.context.secrets.delete(`dimosi.key.${name}`);
    await this.context.globalState.update(
      INDEX_KEY,
      (await this.list()).filter((n) => n !== name),
    );
    this.changed.fire();
  }

  async list() {
    return this.context.globalState.get<string[]>(INDEX_KEY, []);
  }
}
