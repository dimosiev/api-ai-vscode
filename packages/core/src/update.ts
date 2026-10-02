import { createHash } from "node:crypto";

/** latest.json on the update server. */
export interface UpdateManifest {
  version: string;
  /** Release date, YYYY-MM-DD. */
  date?: string;
  notes?: string;
  vsix: { file: string; sha256: string };
  cli?: { file: string; sha256: string };
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FILE = /^[A-Za-z0-9._-]+$/;

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
      (typeof m.cli.file === "string" && FILE.test(m.cli.file) && typeof m.cli.sha256 === "string" && SHA256.test(m.cli.sha256)));
  if (!ok) throw new Error("Файл обновлений повреждён или имеет неверный формат.");
  return {
    version: m.version,
    date: typeof m.date === "string" ? m.date : undefined,
    notes: typeof m.notes === "string" ? m.notes.slice(0, 500) : undefined,
    vsix: { file: m.vsix.file, sha256: m.vsix.sha256 },
    cli: m.cli ? { file: m.cli.file, sha256: m.cli.sha256 } : undefined,
  };
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

/** Fetches and validates latest.json. */
export async function fetchManifest(baseUrl: string, timeoutMs = 15_000): Promise<UpdateManifest> {
  const res = await fetch(joinUrl(baseUrl, "latest.json"), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "cache-control": "no-cache" },
  });
  if (!res.ok) throw new Error(`Сервер обновлений ответил ${res.status}.`);
  return parseManifest(await res.json());
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
