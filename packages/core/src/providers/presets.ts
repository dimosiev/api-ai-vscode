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
  /** Context window in tokens when it differs from the agent default. */
  contextWindow?: number;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    kind: "anthropic",
    // Given explicitly: otherwise the SDK takes ANTHROPIC_BASE_URL from the environment and sends the key there.
    baseURL: "https://api.anthropic.com",
    envVar: "ANTHROPIC_API_KEY",
    requiresKey: true,
    defaultModel: "claude-opus-5-5",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    baseURL: "https://api.openai.com/v1",
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
  // TeamoRouter answers in both formats with one key. Its docs: Claude through the OpenAI
  // format "can lose prompt cache, thinking", so Claude gets an entry of its own.
  {
    id: "teamo",
    label: "TeamoRouter (Claude)",
    kind: "anthropic",
    baseURL: "https://api.teamorouter.com",
    envVar: "TEAMO_API_KEY",
    requiresKey: true,
    defaultModel: "claude-opus-5-5",
  },
  {
    id: "teamo-openai",
    label: "TeamoRouter (all models)",
    kind: "openai",
    baseURL: "https://api.teamorouter.com/v1",
    envVar: "TEAMO_API_KEY",
    requiresKey: true,
    defaultModel: "claude-opus-5-5",
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
    contextWindow: 32_000,
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

/** Services whose address the user may set; the others always use their own. */
export const CUSTOM_URL_PRESETS = ["custom", "ollama"];

/**
 * The key and the conversation must not travel unencrypted: https://, or
 * plain http:// only to this computer (a local model, a test server).
 */
export function checkBaseUrl(url: string): void {
  let u: URL | undefined;
  try {
    u = new URL(url);
  } catch {
    // reported below
  }
  const local = u?.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (!u || (u.protocol !== "https:" && !local)) {
    throw new Error(
      `Адрес сервиса «${url}» не подходит: нужен адрес, который начинается с https://. ` +
        "http:// можно только для этого компьютера (localhost, 127.0.0.1): иначе ключ и переписка пойдут по сети незашифрованными.",
    );
  }
}

export interface CreateProviderOptions {
  presetId: string;
  apiKey?: string;
  /** Overrides the preset URL for "custom" (required) and "ollama"; ignored for the others. */
  baseURL?: string;
  fetch?: typeof fetch;
}

export function createProvider(opts: CreateProviderOptions): Provider {
  const preset = getPreset(opts.presetId);
  const baseURL = (CUSTOM_URL_PRESETS.includes(preset.id) && opts.baseURL) || preset.baseURL;
  if (preset.requiresKey && !opts.apiKey) {
    throw new Error(`No API key for ${preset.label}. Set one first.`);
  }
  if (preset.id === "custom" && !baseURL) {
    throw new Error("The custom provider needs a base URL.");
  }
  if (baseURL) checkBaseUrl(baseURL);
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
