import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MAX_RULE_FILE_CHARS = 30_000;
export const MAX_RULES_CHARS = 80_000;

export interface RuleSource {
  scope: "global" | "project";
  /** Display name, e.g. ".dimosi/rules/style.md". */
  label: string;
  path: string;
  chars: number;
  truncated: boolean;
}

export interface LoadedRules {
  sources: RuleSource[];
  /** Rules ready to place in the system prompt; empty when there are none. */
  text: string;
}

/** Shared by the VS Code extension and the CLI, so one file serves both. */
export function defaultGlobalRulesPath(): string {
  const base = process.env.DIMOSI_HOME
    ?? (process.platform === "win32"
      ? path.join(process.env.APPDATA ?? os.homedir(), "dimosi")
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "dimosi"));
  return path.join(base, "rules.md");
}

export const PROJECT_RULES_DIR = ".dimosi";

async function readIfExists(p: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) return undefined;
    return await fs.readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Collects rules in priority order: global first, then project files.
 * Re-read on every user message, so edits apply immediately.
 */
export async function loadRules(root: string, globalRulesPath = defaultGlobalRulesPath()): Promise<LoadedRules> {
  const candidates: Array<{ scope: RuleSource["scope"]; label: string; path: string }> = [
    { scope: "global", label: "Глобальные правила", path: globalRulesPath },
    { scope: "project", label: "AGENTS.md", path: path.join(root, "AGENTS.md") },
    { scope: "project", label: "CLAUDE.md", path: path.join(root, "CLAUDE.md") },
    { scope: "project", label: `${PROJECT_RULES_DIR}/rules.md`, path: path.join(root, PROJECT_RULES_DIR, "rules.md") },
  ];
  try {
    const dir = path.join(root, PROJECT_RULES_DIR, "rules");
    const names = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith(".md")).sort();
    for (const n of names) {
      candidates.push({ scope: "project", label: `${PROJECT_RULES_DIR}/rules/${n}`, path: path.join(dir, n) });
    }
  } catch {
    // no rules directory
  }

  const sources: RuleSource[] = [];
  const blocks: string[] = [];
  let budget = MAX_RULES_CHARS;
  for (const c of candidates) {
    const raw = (await readIfExists(c.path))?.trim();
    if (!raw || budget <= 0) continue;
    const limit = Math.min(MAX_RULE_FILE_CHARS, budget);
    const truncated = raw.length > limit;
    const body = truncated ? raw.slice(0, limit) + "\n[... обрезано: файл слишком большой]" : raw;
    budget -= body.length;
    sources.push({ scope: c.scope, label: c.label, path: c.path, chars: raw.length, truncated });
    blocks.push(`## ${c.label}${c.scope === "global" ? " (from the user, apply to every project)" : ""}\n${body}`);
  }
  return { sources, text: blocks.join("\n\n") };
}

export const GLOBAL_RULES_TEMPLATE = `# Мои правила для всех проектов

<!-- Эти правила агент dimosi читает перед каждым ответом, в любом проекте.
     Пишите обычным языком, по одному правилу на строку. -->

- Отвечай на русском языке.
- Перед изменениями кратко объясняй, что собираешься сделать.
- Не удаляй файлы без явной просьбы.
`;

export const PROJECT_RULES_TEMPLATE = `# Правила проекта

<!-- Агент dimosi читает этот файл перед каждым ответом.
     Опишите проект и свои требования — чем конкретнее, тем лучше. -->

## О проекте
- Что это за проект и для кого:
- Главные технологии:

## Стиль кода
-

## Запреты
-

## Команды
- Запуск:
- Тесты:
`;

/** Task text for "generate rules from the project". */
export const GENERATE_RULES_PROMPT = `Изучи этот проект (структуру, конфигурацию, несколько ключевых файлов) и создай файл ${PROJECT_RULES_DIR}/rules.md с правилами проекта на русском языке. Разделы: «О проекте» (назначение, технологии), «Стиль кода» (что видно из кода: отступы, именование, подходы), «Структура» (где что лежит), «Команды» (запуск, сборка, тесты — только реально существующие), «Запреты» (что нельзя трогать или делать). Пиши кратко и конкретно, только то, что подтверждается файлами проекта. Если файл уже есть — дополни его, не удаляя написанное пользователем.`;
