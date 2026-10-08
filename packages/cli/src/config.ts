import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CliConfig {
  provider: string;
  /** Per-provider model choice; empty means the preset default. */
  models: Record<string, string>;
  /** Per-provider base URL override (required for "custom"). */
  baseUrls: Record<string, string>;
  mode: "ask" | "auto";
  /** Folders outside the project opened to the agent: `[{ "path": "...", "access": "read" | "write" }]`. */
  extraFolders?: unknown;
  /** Helpers: `[{ "name", "description", "provider"?, "model"? }]` (see parseSubagents). */
  subagents?: unknown;
}

const DEFAULTS: CliConfig = { provider: "anthropic", models: {}, baseUrls: {}, mode: "ask" };

function baseDir(name: string): string {
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? os.homedir(), name);
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), name);
}

/** Same folder as the global rules file in @dimosi/core. */
export function configDir(): string {
  return process.env.DIMOSI_HOME ?? baseDir("dimosi");
}

const POSIX = process.platform !== "win32";
/** Everything dimosi keeps in its folder; all of it is private. */
const OWN_FILES = ["config.json", "trusted-rules.json", "allowed-commands.json", "update-check.json", "keys.aienc", "dimosi.log", "dimosi.log.1", "rules.md"];

/** Creates the folder readable by the owner only (0700) and fixes an existing one. */
export async function ensureConfigDir(): Promise<string> {
  const dir = configDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (POSIX) await fs.chmod(dir, 0o700);
  return dir;
}

/** On start: an older dimosi created the folder and files readable by everyone. */
export async function secureConfigDir(): Promise<void> {
  if (!POSIX) return;
  try {
    await fs.chmod(configDir(), 0o700);
  } catch {
    return; // no folder yet
  }
  for (const f of OWN_FILES) await fs.chmod(path.join(configDir(), f), 0o600).catch(() => undefined);
}

/**
 * Writes a file in the folder for the owner only (0600), through a temporary
 * file and a rename: a crash mid-write can't leave keys.aienc half-written.
 */
export async function writePrivateFile(file: string, text: string): Promise<void> {
  await ensureConfigDir();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
    if (POSIX) await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** Version 0.1 kept its files in ".../api-ai"; copy them over once. */
export async function migrateLegacyConfig(): Promise<boolean> {
  if (process.env.DIMOSI_HOME) return false;
  const legacy = baseDir("api-ai");
  try {
    await fs.access(configDir());
    return false;
  } catch {
    // new folder does not exist yet
  }
  try {
    await fs.cp(legacy, configDir(), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

const configPath = () => path.join(configDir(), "config.json");

export async function loadConfig(): Promise<CliConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(configPath(), "utf8"));
    return { ...DEFAULTS, ...raw, models: { ...raw.models }, baseUrls: { ...raw.baseUrls } };
  } catch {
    return { ...DEFAULTS, models: {}, baseUrls: {} };
  }
}

const trustPath = () => path.join(configDir(), "trusted-rules.json");

/** Trust decisions for project AGENTS.md / CLAUDE.md, by hash of path and text. */
export async function loadTrustDecisions(): Promise<{ get(hash: string): boolean | undefined; set(hash: string, trusted: boolean): Promise<void> }> {
  let all: Record<string, boolean> = {};
  try {
    const raw = JSON.parse(await fs.readFile(trustPath(), "utf8"));
    if (raw && typeof raw === "object") all = raw;
  } catch {
    // none yet
  }
  return {
    get: (hash) => (typeof all[hash] === "boolean" ? all[hash] : undefined),
    async set(hash, trusted) {
      all = { ...all, [hash]: trusted };
      await writePrivateFile(trustPath(), JSON.stringify(all, null, 2) + "\n");
    },
  };
}

const commandRulesPath = () => path.join(configDir(), "allowed-commands.json");

/** Commands allowed with "Always", for all projects (see ProjectCommandRules). Kept here, outside any project. */
export const commandRulesStorage = {
  load(): unknown {
    try {
      return JSON.parse(readFileSync(commandRulesPath(), "utf8"));
    } catch {
      return undefined; // none yet, or damaged: no rules
    }
  },
  save: (all: unknown) => writePrivateFile(commandRulesPath(), JSON.stringify(all, null, 2) + "\n"),
};

export async function saveConfig(config: CliConfig): Promise<void> {
  await writePrivateFile(configPath(), JSON.stringify(config, null, 2) + "\n");
}
