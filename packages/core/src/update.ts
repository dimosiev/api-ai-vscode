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
const VSIX_FILE = /^[A-Za-z0-9._-]+\.vsix$/;
const CLI_FILE = /^[A-Za-z0-9._-]+\.tgz$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
export const MAX_NOTES_CHARS = 500;
/** latest.json is a few hundred bytes; anything bigger is not ours. */
export const MAX_MANIFEST_BYTES = 64 * 1024;
/** Release files are a few megabytes. */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/** Validates the manifest strictly: a broken or tampered file must never trigger an install. */
export function parseManifest(json: unknown): UpdateManifest {
  const m = json as Record<string, any>;
  const ok =
    m &&
    typeof m.version === "string" &&
    SEMVER.test(m.version) &&
    m.vsix &&
    typeof m.vsix.file === "string" &&
    VSIX_FILE.test(m.vsix.file) &&
    typeof m.vsix.sha256 === "string" &&
    SHA256.test(m.vsix.sha256) &&
    (m.cli === undefined ||
      (typeof m.cli.file === "string" && CLI_FILE.test(m.cli.file) && typeof m.cli.sha256 === "string" && SHA256.test(m.cli.sha256))) &&
    (m.date === undefined || (typeof m.date === "string" && DATE.test(m.date))) &&
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

/** Reads a response body, but no more than `max` bytes: a hostile server could send without end. */
async function readLimited(res: Response, max: number, what: string): Promise<Uint8Array> {
  const limit = max >= 1024 * 1024 ? `${Math.round(max / 1024 / 1024)} МБ` : `${Math.round(max / 1024)} КБ`;
  const tooBig = () => new Error(`${what} слишком большой (больше ${limit}) — обновление не установлено.`);
  if (Number(res.headers.get("content-length")) > max) throw tooBig();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  for (;;) {
    const { done, value } = reader ? await reader.read() : { done: true, value: undefined };
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader!.cancel();
      throw tooBig();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Fetches latest.json and checks its format and signature. */
export async function fetchManifest(baseUrl: string, publicKeysBase64: string[], timeoutMs = 15_000): Promise<UpdateManifest> {
  const res = await fetch(joinUrl(baseUrl, "latest.json"), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "cache-control": "no-cache" },
  });
  if (!res.ok) throw new Error(`Сервер обновлений ответил ${res.status}.`);
  const text = new TextDecoder().decode(await readLimited(res, MAX_MANIFEST_BYTES, "Файл обновлений"));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Файл обновлений повреждён или имеет неверный формат.");
  }
  const manifest = parseManifest(json);
  verifyManifest(manifest, publicKeysBase64);
  return manifest;
}

/** Downloads a release file and checks its checksum before returning it. */
export async function downloadVerified(
  baseUrl: string,
  file: { file: string; sha256: string },
  timeoutMs = 120_000,
  maxBytes = MAX_DOWNLOAD_BYTES,
): Promise<Uint8Array> {
  const res = await fetch(joinUrl(baseUrl, file.file), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Не удалось скачать ${file.file}: ответ ${res.status}.`);
  const data = await readLimited(res, maxBytes, `Файл ${file.file}`);
  if (sha256(data) !== file.sha256) {
    throw new Error(`Контрольная сумма ${file.file} не совпала — файл не установлен.`);
  }
  return data;
}
