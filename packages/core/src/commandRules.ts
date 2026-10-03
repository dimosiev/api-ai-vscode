import { realPath } from "./access";

/**
 * What "Always" remembers for commands. "prefix": any plain command that
 * begins with these words (`npm test` also covers `npm test -- --watch`).
 * "exact": this very command and nothing else.
 */
export interface CommandRule {
  kind: "prefix" | "exact";
  text: string;
}

/** Where a gate keeps the rules; without one they live until the new chat. */
export interface CommandRuleStore {
  list(): CommandRule[];
  add(rule: CommandRule): Promise<void>;
}

/**
 * Anything that lets the shell run a second command or put text somewhere
 * else: chains, pipes, substitutions, redirections, line breaks. A command
 * with any of these never passes by its beginning: `npm test && rm -rf …`
 * must not run under the permission for `npm test`. Quoted text is not
 * parsed: a quoted `;` just means the user is asked.
 */
const SHELL_SYNTAX = /[;&|<>()`$\\\n\r]/;

/**
 * Programs whose arguments are another command: what they begin with says
 * nothing about what will run.
 */
const RUNS_ANOTHER = new Set([
  "sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh", "cmd", "powershell", "pwsh",
  "env", "xargs", "eval", "exec", "sudo", "doas", "nohup", "time", "command", "builtin", "nice", "timeout", "watch", "ssh", "find",
]);

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

const words = (command: string) => command.trim().split(/\s+/).filter(Boolean);

/** The rule "Always" would save for this command. */
export function commandRule(command: string): CommandRule {
  const exact: CommandRule = { kind: "exact", text: command.trim() };
  if (SHELL_SYNTAX.test(command)) return exact;
  const w = words(command);
  // `npm run build`: the script is the third word; `npm run` alone would cover every script.
  const length = PACKAGE_MANAGERS.has(w[0]) && w[1] === "run" ? 3 : 2;
  const head = w.slice(0, length);
  if (head.length < length || RUNS_ANOTHER.has(head[0])) return exact;
  // An option (`node -e …`), a variable (`FOO=1 cmd`) or quotes: nothing safe to generalise.
  if (head.some((word, i) => (i > 0 && word.startsWith("-")) || /["'=]/.test(word))) return exact;
  return { kind: "prefix", text: head.join(" ") };
}

export function ruleMatches(rule: CommandRule, command: string): boolean {
  if (rule.kind === "exact") return command.trim() === rule.text;
  // Checked again here: the saved list is read from a file.
  if (SHELL_SYNTAX.test(command) || SHELL_SYNTAX.test(rule.text) || words(rule.text).length < 2) return false;
  const normal = words(command).join(" ");
  return normal === rule.text || normal.startsWith(rule.text + " ");
}

const sameRule = (a: CommandRule, b: CommandRule) => a.kind === b.kind && a.text === b.text;

/** How a rule is shown to the user. */
export function describeRule(rule: CommandRule): string {
  return rule.kind === "prefix" ? `команды, которые начинаются с «${rule.text}»` : `только команда «${rule.text}»`;
}

/** The host's storage outside the project: all projects' rules, keyed by project folder. */
export interface CommandRulesStorage {
  load(): unknown;
  save(all: Record<string, CommandRule[]>): Promise<void>;
}

const MAX_RULES = 200;

/**
 * One project's remembered commands. They are kept by the host outside the
 * project, so a project someone else made can't bring its own permissions,
 * and per project, so `npm test` allowed here is still asked about elsewhere.
 */
export class ProjectCommandRules implements CommandRuleStore {
  /** The project's real path. */
  readonly key: string;

  constructor(
    root: string,
    private storage: CommandRulesStorage,
  ) {
    this.key = realPath(root);
  }

  /** Everything saved; anything that does not look like rules is dropped. */
  private all(): Record<string, CommandRule[]> {
    const raw = this.storage.load();
    const out: Record<string, CommandRule[]> = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const [key, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const rules = list.filter(
        (r): r is CommandRule => Boolean(r) && (r.kind === "prefix" || r.kind === "exact") && typeof r.text === "string" && r.text.trim() !== "",
      );
      if (rules.length) out[key] = rules.map((r) => ({ kind: r.kind, text: r.text }));
    }
    return out;
  }

  list(): CommandRule[] {
    return this.all()[this.key] ?? [];
  }

  private async replace(rules: CommandRule[]): Promise<void> {
    const all = this.all();
    if (rules.length) all[this.key] = rules.slice(-MAX_RULES);
    else delete all[this.key];
    await this.storage.save(all);
  }

  async add(rule: CommandRule): Promise<void> {
    const rules = this.list();
    if (!rules.some((r) => sameRule(r, rule))) await this.replace([...rules, rule]);
  }

  async remove(rule: CommandRule): Promise<void> {
    await this.replace(this.list().filter((r) => !sameRule(r, rule)));
  }

  async clear(): Promise<void> {
    await this.replace([]);
  }
}
