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
  /** Sites whose pages may be read without asking. */
  sites?(): string[];
  addSite?(host: string): Promise<void>;
  /** Helpers (see subagentKey) that may start without asking. */
  helpers?(): string[];
  addHelper?(key: string): Promise<void>;
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
  "env", "xargs", "eval", "exec", "sudo", "doas", "su", "nohup", "time", "command", "builtin", "nice", "timeout", "watch", "ssh", "find",
  "caffeinate", "arch", "script", "stdbuf", "setsid", "chroot", "flock", "parallel", "unbuffer",
  // Not runners, but every address is a decision of its own (as with fetch_page).
  "curl", "wget",
]);

/**
 * The same, where it takes two words to say "run this other program":
 * `npm exec tsc` must not allow `npm exec anything-else`.
 */
const RUNS_ANOTHER_AFTER: Record<string, string[]> = {
  npm: ["exec", "x"],
  pnpm: ["exec", "dlx"],
  yarn: ["exec", "dlx"],
  bun: ["x"],
  docker: ["run", "exec", "compose"],
  podman: ["run", "exec"],
  kubectl: ["run", "exec"],
  uv: ["run", "tool"],
  poetry: ["run"],
  pipenv: ["run"],
  pdm: ["run"],
  hatch: ["run"],
  conda: ["run"],
  bundle: ["exec"],
  // `git submodule foreach <command>`
  git: ["submodule"],
};

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** `npm run build`: the script is the third word. */
const RUN_SCRIPT = new Set(["run", "run-script"]);

const words = (command: string) => command.trim().split(/\s+/).filter(Boolean);

/** The rule "Always" would save for this command. */
export function commandRule(command: string): CommandRule {
  const exact: CommandRule = { kind: "exact", text: command.trim() };
  if (SHELL_SYNTAX.test(command)) return exact;
  const w = words(command);
  // `npm run build`: `npm run` alone would cover every script.
  const length = PACKAGE_MANAGERS.has(w[0]) && RUN_SCRIPT.has(w[1]) ? 3 : 2;
  const head = w.slice(0, length);
  if (head.length < length || RUNS_ANOTHER.has(head[0]) || RUNS_ANOTHER_AFTER[head[0]]?.includes(head[1])) return exact;
  // An option (`node -e …`), a variable (`FOO=1 cmd`) or quotes: nothing safe to generalise.
  if (head.some((word, i) => (i > 0 && word.startsWith("-")) || /["'=]/.test(word))) return exact;
  return { kind: "prefix", text: head.join(" ") };
}

export function ruleMatches(rule: CommandRule, command: string): boolean {
  if (rule.kind === "exact") return command.trim() === rule.text;
  // Checked again here: the saved list is read from a file, and a rule saved
  // by an older version may be wider than what would be remembered today.
  const today = commandRule(rule.text);
  if (SHELL_SYNTAX.test(command) || today.kind !== "prefix" || today.text !== rule.text) return false;
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
/** Where the allowed sites are kept: one list for all projects (no project folder has this name). */
const SITES_KEY = "sites";
/** The same for the helpers allowed to start without asking. */
const HELPERS_KEY = "helpers";

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

  sites(): string[] {
    return (this.all()[SITES_KEY] ?? []).map((r) => r.text);
  }

  private async replaceSites(hosts: string[]): Promise<void> {
    const all = this.all();
    if (hosts.length) all[SITES_KEY] = hosts.slice(-MAX_RULES).map((text) => ({ kind: "exact", text }));
    else delete all[SITES_KEY];
    await this.storage.save(all);
  }

  async addSite(host: string): Promise<void> {
    if (!this.sites().includes(host)) await this.replaceSites([...this.sites(), host]);
  }

  async removeSite(host: string): Promise<void> {
    await this.replaceSites(this.sites().filter((h) => h !== host));
  }

  helpers(): string[] {
    return (this.all()[HELPERS_KEY] ?? []).map((r) => r.text);
  }

  private async replaceHelpers(keys: string[]): Promise<void> {
    const all = this.all();
    if (keys.length) all[HELPERS_KEY] = keys.slice(-MAX_RULES).map((text) => ({ kind: "exact", text }));
    else delete all[HELPERS_KEY];
    await this.storage.save(all);
  }

  async addHelper(key: string): Promise<void> {
    if (!this.helpers().includes(key)) await this.replaceHelpers([...this.helpers(), key]);
  }

  async removeHelper(key: string): Promise<void> {
    await this.replaceHelpers(this.helpers().filter((k) => k !== key));
  }
}
