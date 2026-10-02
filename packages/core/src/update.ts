// No relative imports here: scripts/release.mjs loads this file directly with Node.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

/** latest.json on the update server. */
export interface UpdateManifest {
  version: string;
  /** Release date, YYYY-MM-DD. */
  date?: string;
  notes?: string;
  vsix: { file: string; sha256: string };
  cli?: { file: string; sha256: string };
  /** Ed25519 signature of manifestSigningPayload(), base64. */
  signature?: string;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FILE = /^[A-Za-z0-9._-]+$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
export const MAX_NOTES_CHARS = 500;

/** Validates the manifest strictly: a broken or tampered file must never trigger an install. */
export function parseManifest(json: unknown): UpdateManifest {
  const m = json as Record<string, any>;
  const ok =
    m &&
    typeof m.version === "string" &&
    SEMVER.test(m.version) &&
    m.vsix &&
    typeof m.vsix.file === "string" &&
    FILE.test(m.vsix.file) &&
    typeof m.vsix.sha256 === "string" &&
    SHA256.test(m.vsix.sha256) &&
    (m.cli === undefined ||
      (typeof m.cli.file === "string" && FILE.test(m.cli.file) && typeof m.cli.sha256 === "string" && SHA256.test(m.cli.sha256))) &&
    (m.date === undefined || typeof m.date === "string") &&
    (m.notes === undefined || (typeof m.notes === "string" && m.notes.length <= MAX_NOTES_CHARS)) &&
    (m.signature === undefined || (typeof m.signature === "string" && SIGNATURE.test(m.signature)));
  if (!ok) throw new Error("Файл обновлений повреждён или имеет неверный формат.");
  return {
    version: m.version,
    date: m.date,
    notes: m.notes,
    vsix: { file: m.vsix.file, sha256: m.vsix.sha256 },
    cli: m.cli ? { file: m.cli.file, sha256: m.cli.sha256 } : undefined,
    signature: m.signature,
  };
}

/** Exactly what gets signed: every field the client acts on or shows. */
export function manifestSigningPayload(m: UpdateManifest): Buffer {
  return Buffer.from(
    [
      "dimosi-update-v1",
      `version=${m.version}`,
      `date=${m.date ?? ""}`,
      `notes=${JSON.stringify(m.notes ?? "")}`,
      `vsix=${m.vsix.file} ${m.vsix.sha256}`,
      `cli=${m.cli ? `${m.cli.file} ${m.cli.sha256}` : "-"}`,
    ].join("\n"),
    "utf8",
  );
}

/** Signs with the owner's private key (base64 PKCS#8 DER, kept in a password manager). */
export function signManifest(m: UpdateManifest, privateKeyBase64: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyBase64.trim(), "base64"), format: "der", type: "pkcs8" });
  return sign(null, manifestSigningPayload(m), key).toString("base64");
}

/**
 * Throws unless the manifest is signed by one of the trusted keys (base64
 * SPKI DER, built into the extension). This is what makes a hacked update
 * server harmless: it can't produce a valid signature.
 */
export function verifyManifest(m: UpdateManifest, publicKeysBase64: string[]): void {
  if (!m.signature) throw new Error("Файл обновлений не подписан — обновление не установлено.");
  const signature = Buffer.from(m.signature, "base64");
  const payload = manifestSigningPayload(m);
  for (const k of publicKeysBase64) {
    const key = createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" });
    if (verify(null, payload, key, signature)) return;
  }
  throw new Error("Подпись файла обновлений не сходится — обновление не установлено.");
}

/** True when `candidate` is a higher x.y.z version than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function joinUrl(base: string, file: string): string {
  return base.endsWith("/") ? base + file : `${base}/${file}`;
}

/** Fetches latest.json and checks its format and signature. */
export async function fetchManifest(baseUrl: string, publicKeysBase64: string[], timeoutMs = 15_000): Promise<UpdateManifest> {
  const res = await fetch(joinUrl(baseUrl, "latest.json"), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "cache-control": "no-cache" },
  });
  if (!res.ok) throw new Error(`Сервер обновлений ответил ${res.status}.`);
  const manifest = parseManifest(await res.json());
  verifyManifest(manifest, publicKeysBase64);
  return manifest;
}

/** Downloads a release file and checks its checksum before returning it. */
export async function downloadVerified(
  baseUrl: string,
  file: { file: string; sha256: string },
  timeoutMs = 120_000,
): Promise<Uint8Array> {
  const res = await fetch(joinUrl(baseUrl, file.file), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Не удалось скачать ${file.file}: ответ ${res.status}.`);
  const data = new Uint8Array(await res.arrayBuffer());
  if (sha256(data) !== file.sha256) {
    throw new Error(`Контрольная сумма ${file.file} не совпала — файл не установлен.`);
  }
  return data;
}
