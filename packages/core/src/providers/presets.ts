import type { Provider } from "../types";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";

export interface ProviderPreset {
  id: string;
  label: string;
  kind: "anthropic" | "openai";
  baseURL?: string;
  /** Environment variable the CLI checks before the key store. */
  envVar?: string;
  requiresKey: boolean;
  defaultModel: string;
  includeUsage?: boolean;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    kind: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    requiresKey: true,
    defaultModel: "claude-opus-5-5",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    envVar: "OPENAI_API_KEY",
    requiresKey: true,
    defaultModel: "gpt-6.1-sol",
    includeUsage: true,
  },
  {
    id: "polza",
    label: "Polza AI",
    kind: "openai",
    baseURL: "https://polza.ai/api/v1",
    envVar: "POLZA_API_KEY",
    requiresKey: true,
    defaultModel: "anthropic/claude-opus-5.5",
    includeUsage: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    baseURL: "https://openrouter.ai/api/v1",
    envVar: "OPENROUTER_API_KEY",
    requiresKey: true,
    defaultModel: "anthropic/claude-opus-5.5",
    includeUsage: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    baseURL: "https://api.deepseek.com/v1",
    envVar: "DEEPSEEK_API_KEY",
    requiresKey: true,
    defaultModel: "deepseek-chat",
    includeUsage: true,
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    kind: "openai",
    baseURL: "http://localhost:11434/v1",
    requiresKey: false,
    defaultModel: "qwen3-coder",
    includeUsage: true,
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    kind: "openai",
    envVar: "CUSTOM_API_KEY",
    requiresKey: false,
    defaultModel: "",
  },
];

export function getPreset(id: string): ProviderPreset {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown provider "${id}". Known: ${PRESETS.map((p) => p.id).join(", ")}`);
  return preset;
}

export interface CreateProviderOptions {
  presetId: string;
  apiKey?: string;
  /** Overrides the preset URL; required for "custom". */
  baseURL?: string;
  fetch?: typeof fetch;
}

export function createProvider(opts: CreateProviderOptions): Provider {
  const preset = getPreset(opts.presetId);
  const baseURL = opts.baseURL || preset.baseURL;
  if (preset.requiresKey && !opts.apiKey) {
    throw new Error(`No API key for ${preset.label}. Set one first.`);
  }
  if (preset.id === "custom" && !baseURL) {
    throw new Error("The custom provider needs a base URL.");
  }
  if (preset.kind === "anthropic") {
    return new AnthropicProvider({ id: preset.id, apiKey: opts.apiKey!, baseURL, fetch: opts.fetch });
  }
  return new OpenAIProvider({
    id: preset.id,
    apiKey: opts.apiKey ?? "",
    baseURL,
    includeUsage: preset.includeUsage,
    fetch: opts.fetch,
  });
}
