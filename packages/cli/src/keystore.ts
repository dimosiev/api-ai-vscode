import { promises as fs } from "node:fs";
import * as path from "node:path";
import { decryptKeys, encryptKeys, type KeyStore } from "@dimosi/core";
import { configDir, writePrivateFile } from "./config";

export const keyFilePath = () => path.join(configDir(), "keys.aienc");

export async function keyFileExists(): Promise<boolean> {
  try {
    await fs.access(keyFilePath());
    return true;
  } catch {
    return false;
  }
}

/**
 * Keys live in one password-encrypted file (the same format as the VS Code
 * export), so moving the CLI to another machine is copying that file.
 */
export class EncryptedFileKeyStore implements KeyStore {
  private constructor(
    private keys: Record<string, string>,
    private password: string,
  ) {}

  /** Opens the existing file, or starts an empty store that will be created on first save. */
  static async open(password: string): Promise<EncryptedFileKeyStore> {
    if (!(await keyFileExists())) return new EncryptedFileKeyStore({}, password);
    const text = await fs.readFile(keyFilePath(), "utf8");
    return new EncryptedFileKeyStore(decryptKeys(text, password), password);
  }

  async get(name: string) {
    return this.keys[name];
  }

  async set(name: string, value: string) {
    this.keys[name] = value;
    await this.save();
  }

  async delete(name: string) {
    delete this.keys[name];
    await this.save();
  }

  async list() {
    return Object.keys(this.keys).sort();
  }

  private async save() {
    await writePrivateFile(keyFilePath(), encryptKeys(this.keys, this.password));
  }
}
