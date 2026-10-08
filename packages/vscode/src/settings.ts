import * as vscode from "vscode";
import { createProvider, getPreset, parseEffort, parseExtraFolders, parseSubagents, polzaImages, type Effort, type ExtraFolder, type ImageMaker, type Provider, type SubagentDef, type SubagentResolver } from "@dimosi/core";
import type { SecretKeyStore } from "./keyStore";
import { fetchWithDirectFallback, vscodeOriginalFetch } from "./directFetch";
import { log } from "./log";

export interface Settings {
  provider: string;
  model: string;
  customBaseUrl: string;
  approvalMode: "ask" | "auto";
  maxSteps: number;
  sandbox: boolean;
  /** Folders outside the project opened to the agent, as written in the settings. */
  extraFolders: ExtraFolder[];
  /** The Polza AI model that draws pictures; empty: the default one. */
  imageModel: string;
  /** How hard the model works; not set: the model's own default. */
  effort?: Effort;
  /** The user's helpers (without the built-in ones). */
  subagents: SubagentDef[];
}

export function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration("dimosi");
  const provider = cfg.get<string>("provider", "anthropic");
  return {
    provider,
    model: cfg.get<string>("model", "").trim() || getPreset(provider).defaultModel,
    customBaseUrl: cfg.get<string>("customBaseUrl", "").trim(),
    approvalMode: cfg.get<"ask" | "auto">("approvalMode", "ask"),
    maxSteps: cfg.get<number>("maxSteps", 50),
    sandbox: cfg.get<boolean>("sandbox", true),
    extraFolders: parseExtraFolders(cfg.get<unknown>("extraFolders", [])),
    imageModel: cfg.get<string>("imageModel", "").trim(),
    effort: parseEffort(cfg.get<string>("effort", "")),
    subagents: parseSubagents(cfg.get<unknown>("subagents", [])),
  };
}

export async function updateSetting(key: string, value: unknown) {
  await vscode.workspace.getConfiguration("dimosi").update(key, value, vscode.ConfigurationTarget.Global);
}

export class MissingKeyError extends Error {}

/** The services that are reachable without the VPN and so may be asked directly. */
export const directFallbackFor = (presetId: string): boolean => presetId === "polza";

/**
 * Requests to Polza AI: VS Code's fetch, and the direct way when its remembered proxy is gone.
 * Only Polza AI: the other services are used through the VPN, and a request to them
 * must not leave from the user's own address when the VPN fails.
 */
const serviceFetch = (): typeof fetch =>
  fetchWithDirectFallback({
    primary: (input, init) => fetch(input, init),
    direct: vscodeOriginalFetch,
    onFallback: (reason) => log.warn(`request sent without VS Code's proxy: through it ${reason}`),
  });

/** Pictures are made through Polza AI with its key, whatever service the chat model comes from. */
export async function buildImages(settings: Settings, keys: SecretKeyStore): Promise<ImageMaker | undefined> {
  const apiKey = await keys.get("polza");
  if (!apiKey) return undefined;
  log.addSecret(apiKey);
  return polzaImages({ apiKey, model: settings.imageModel, fetch: serviceFetch() });
}

export async function buildProvider(settings: Settings, keys: SecretKeyStore, presetId = settings.provider): Promise<Provider> {
  const preset = getPreset(presetId);
  const apiKey = await keys.get(presetId);
  log.addSecret(apiKey); // masked if a server ever echoes it back
  if (preset.requiresKey && !apiKey) {
    throw new MissingKeyError(`Нет API-ключа для ${preset.label}.`);
  }
  return createProvider({
    presetId,
    apiKey,
    baseURL: presetId === "custom" ? settings.customBaseUrl : undefined,
    fetch: directFallbackFor(presetId) ? serviceFetch() : undefined,
  });
}

/**
 * The service for the chat, built once and kept while the service, its address and the key stay
 * the same. The service object remembers what the server refused (cache marks, effort) and the
 * price list: built anew for every message, it would send the refused request again each time.
 */
export function rememberedProvider(): (settings: Settings, keys: SecretKeyStore) => Promise<Provider> {
  let last: { id: string; provider: Provider } | undefined;
  return async (settings, keys) => {
    const id = JSON.stringify([settings.provider, settings.customBaseUrl, await keys.get(settings.provider)]);
    if (last?.id !== id) last = { id, provider: await buildProvider(settings, keys) };
    return last.provider;
  };
}

/**
 * The services of the helpers that run on another service than the chat. Built once and kept,
 * like the chat's own service: it remembers what the server refused and the price list.
 * A missing key is explained to the main agent, which then does the task itself.
 */
export function rememberedSubagentResolver(): (settings: Settings, keys: SecretKeyStore) => SubagentResolver {
  const built = new Map<string, Provider>();
  return (settings, keys) => async (def) => {
    if (!def.provider) return undefined;
    let preset;
    try {
      preset = getPreset(def.provider);
    } catch {
      throw new Error(`Helper "${def.name}": no such service "${def.provider}". Tell the user to check the helper's settings. Do the task yourself.`);
    }
    const key = await keys.get(def.provider);
    if (preset.requiresKey && !key) {
      throw new Error(`Helper "${def.name}" runs on ${preset.label}, but the user has no API key for it. Tell the user (command "dimosi: Выбрать сервис и модель"). Do the task yourself.`);
    }
    const id = JSON.stringify([def.provider, def.provider === "custom" ? settings.customBaseUrl : "", key]);
    let provider = built.get(id);
    if (!provider) {
      provider = await buildProvider(settings, keys, def.provider);
      built.set(id, provider);
    }
    return { provider, model: def.model || preset.defaultModel, contextWindow: preset.contextWindow };
  };
}
