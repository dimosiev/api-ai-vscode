import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/** Where a host keeps API keys: VS Code SecretStorage, an encrypted file, etc. */
export interface KeyStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
}

const FORMAT = "dimosi-keys";
/** Files exported by version 0.1 (API AI Agent) are still accepted. */
const LEGACY_FORMATS = ["api-ai-keys"];
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

interface EncryptedFile {
  format: string;
  version: 1;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, SCRYPT);
}

/** Encrypts a name → key map with a password (AES-256-GCM, scrypt). Returns file text. */
export function encryptKeys(keys: Record<string, string>, password: string): string {
  if (!password) throw new Error("A password is required.");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(password, salt), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(keys), "utf8"), cipher.final()]);
  const file: EncryptedFile = {
    format: FORMAT,
    version: 1,
    kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64") },
    cipher: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return JSON.stringify(file, null, 2);
}

export function decryptKeys(fileText: string, password: string): Record<string, string> {
  let file: EncryptedFile;
  try {
    file = JSON.parse(fileText);
  } catch {
    throw new Error("This is not a key file.");
  }
  if (file?.format !== FORMAT && !LEGACY_FORMATS.includes(file?.format)) throw new Error("This is not a key file.");
  const key = scryptSync(password, Buffer.from(file.kdf.salt, "base64"), 32, {
    N: file.kdf.N,
    r: file.kdf.r,
    p: file.kdf.p,
    maxmem: SCRYPT.maxmem,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "base64"));
  decipher.setAuthTag(Buffer.from(file.tag, "base64"));
  try {
    const plain = Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    throw new Error("Wrong password, or the file is damaged.");
  }
}

export async function exportKeys(store: KeyStore, password: string): Promise<string> {
  const keys: Record<string, string> = {};
  for (const name of await store.list()) {
    const value = await store.get(name);
    if (value) keys[name] = value;
  }
  if (!Object.keys(keys).length) throw new Error("There are no saved keys to export.");
  return encryptKeys(keys, password);
}

/** Returns the names of the imported keys. */
export async function importKeys(store: KeyStore, fileText: string, password: string): Promise<string[]> {
  const keys = decryptKeys(fileText, password);
  for (const [name, value] of Object.entries(keys)) await store.set(name, value);
  return Object.keys(keys);
}

/** Shows only the ends of a key, e.g. "sk-a…9f3c". */
export function maskKey(key: string): string {
  return key.length <= 10 ? "…" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}
