import * as vscode from "vscode";
import { createProvider, getPreset, type Provider } from "@dimosi/core";
import type { SecretKeyStore } from "./keyStore";
import { log } from "./log";

export interface Settings {
  provider: string;
  model: string;
  customBaseUrl: string;
  approvalMode: "ask" | "auto";
  maxSteps: number;
  sandbox: boolean;
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
  };
}

export async function updateSetting(key: string, value: unknown) {
  await vscode.workspace.getConfiguration("dimosi").update(key, value, vscode.ConfigurationTarget.Global);
}

export class MissingKeyError extends Error {}

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
  });
}
