import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CliConfig {
  provider: string;
  /** Per-provider model choice; empty means the preset default. */
  models: Record<string, string>;
  /** Per-provider base URL override (required for "custom"). */
  baseUrls: Record<string, string>;
  mode: "ask" | "auto";
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

export async function saveConfig(config: CliConfig): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2) + "\n", "utf8");
}
