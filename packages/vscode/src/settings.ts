import * as vscode from "vscode";
import { createProvider, getPreset, parseExtraFolders, polzaImages, type ExtraFolder, type ImageMaker, type Provider } from "@dimosi/core";
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
  };
}

export async function updateSetting(key: string, value: unknown) {
  await vscode.workspace.getConfiguration("dimosi").update(key, value, vscode.ConfigurationTarget.Global);
}

export class MissingKeyError extends Error {}

/** Requests to the services: VS Code's fetch, and the direct way when its remembered proxy is gone. */
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
    fetch: serviceFetch(),
  });
}
