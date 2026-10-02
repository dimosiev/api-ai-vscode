import { createHash } from "node:crypto";
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
  /** For files that need trust: decisions are remembered by this hash of path and text. */
  hash?: string;
  /** Not used: the user has not trusted this file (yet). */
  skipped?: boolean;
}

/** A rules file from the project that the user did not write through dimosi. */
export interface RuleFile {
  label: string;
  path: string;
  text: string;
  hash: string;
}

/**
 * Decides whether a project's rules files (AGENTS.md, CLAUDE.md, .dimosi/)
 * may become instructions for the agent. A downloaded repository can carry
 * harmful instructions in any of them.
 */
export interface RuleTrust {
  isTrusted(file: RuleFile): Promise<boolean>;
  /** Trusts this exact text without asking: dimosi wrote it for the user. */
  remember?(filePath: string, text: string): Promise<void>;
}

/** Where a host keeps trust decisions (VS Code global state, a CLI file). */
export interface TrustDecisions {
  get(hash: string): boolean | undefined;
  set(hash: string, trusted: boolean): unknown;
}

/** Changes whenever the file's text changes, so an edited file is asked about again. */
export function ruleHash(filePath: string, text: string): string {
  return createHash("sha256").update(`${filePath}\0${text}`).digest("hex");
}

/**
 * Asks once per file version and remembers the answer. A dismissed question
 * (`ask` gives undefined) means "not now" and is asked again next time.
 * Without `ask`, unknown files are simply not trusted.
 */
export function rememberingTrust(decisions: TrustDecisions, ask?: (file: RuleFile) => Promise<boolean | undefined>): RuleTrust {
  const pending = new Map<string, Promise<boolean>>();
  return {
    async remember(filePath, text) {
      await decisions.set(ruleHash(filePath, text.trim()), true);
    },
    async isTrusted(file) {
      const known = decisions.get(file.hash);
      if (known !== undefined) return known;
      if (!ask) return false;
      let answer = pending.get(file.hash);
      if (!answer) {
        answer = ask(file)
          .then(async (a) => {
            if (a !== undefined) await decisions.set(file.hash, a);
            return a ?? false;
          })
          .finally(() => pending.delete(file.hash));
        pending.set(file.hash, answer);
      }
      return answer;
    },
  };
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

/** Whether `abs` is one of the project files loadRules reads. */
export function isProjectRulesFile(root: string, abs: string): boolean {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  return rel === "AGENTS.md" || rel === "CLAUDE.md" || rel === ".dimosi/rules.md" || /^\.dimosi\/rules\/[^/]+\.md$/i.test(rel);
}

/**
 * Collects rules in priority order: global first, then project files.
 * Re-read on every user message, so edits apply immediately. Project files
 * come with downloaded repositories, so with `trust` they are used only once
 * trusted; only the global file is the user's own for sure.
 */
export async function loadRules(root: string, globalRulesPath = defaultGlobalRulesPath(), trust?: RuleTrust): Promise<LoadedRules> {
  const candidates: Array<{ scope: RuleSource["scope"]; label: string; path: string; needsTrust?: boolean }> = [
    { scope: "global", label: "Глобальные правила", path: globalRulesPath },
    { scope: "project", label: "AGENTS.md", path: path.join(root, "AGENTS.md"), needsTrust: true },
    { scope: "project", label: "CLAUDE.md", path: path.join(root, "CLAUDE.md"), needsTrust: true },
    { scope: "project", label: `${PROJECT_RULES_DIR}/rules.md`, path: path.join(root, PROJECT_RULES_DIR, "rules.md"), needsTrust: true },
  ];
  try {
    const dir = path.join(root, PROJECT_RULES_DIR, "rules");
    const names = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith(".md")).sort();
    for (const n of names) {
      candidates.push({ scope: "project", label: `${PROJECT_RULES_DIR}/rules/${n}`, path: path.join(dir, n), needsTrust: true });
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
    const hash = c.needsTrust ? ruleHash(c.path, raw) : undefined;
    if (hash && trust && !(await trust.isTrusted({ label: c.label, path: c.path, text: raw, hash }))) {
      sources.push({ scope: c.scope, label: c.label, path: c.path, chars: raw.length, truncated: false, hash, skipped: true });
      continue;
    }
    const limit = Math.min(MAX_RULE_FILE_CHARS, budget);
    const truncated = raw.length > limit;
    const body = truncated ? raw.slice(0, limit) + "\n[... обрезано: файл слишком большой]" : raw;
    budget -= body.length;
    sources.push({ scope: c.scope, label: c.label, path: c.path, chars: raw.length, truncated, hash });
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
