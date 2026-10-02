import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultGlobalRulesPath } from "../rules";
import { secretPathPatterns } from "./workspace";

/** Variables a command needs that only look like secrets. */
const KEEP = new Set(["SSH_AUTH_SOCK", "XAUTHORITY"]);
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

/**
 * Environment for the agent's commands: the user's, minus anything that
 * looks like a key, token or password. A command (or a package script it
 * starts) then can't print or send the API keys the editor was started with.
 */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (KEEP.has(name) || !SECRET_NAME.test(name)) out[name] = value;
  }
  // Nobody can answer a prompt: commands must not wait for input.
  out.CI = "1";
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Home folders with keys, passwords and personal files: no reading, no writing. */
const HOME_PRIVATE = [
  ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".password-store",
  // Settings of command-line tools, often with their logins (gh, cloud tools...). git's own folder is opened again below.
  ".config",
  // Logins of cloud and build tools.
  ".azure", ".terraform.d", ".gem/credentials", ".cargo/credentials", ".cargo/credentials.toml",
  ".gradle/gradle.properties", ".m2/settings.xml", ".claude", ".claude.json",
  // Tokens in plain text: git's "store" helper, curl/ftp, npm and PyPI logins.
  ".git-credentials", ".config/git/credentials", ".netrc", ".npmrc", ".pypirc",
  // Shell settings and history: tokens are often exported there.
  ".zsh_history", ".bash_history", ".zsh_sessions", ".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile",
  "Documents", "Desktop", "Downloads", "Pictures", "Movies", "Music",
  "Library/Keychains", "Library/Mail", "Library/Messages", "Library/Safari", "Library/Cookies",
  "Library/Mobile Documents",
  // Data of App Store apps (Telegram, WhatsApp, Notes...) and of messengers.
  "Library/Containers", "Library/Group Containers",
  "Library/Application Support/Slack", "Library/Application Support/Telegram Desktop", "Library/Application Support/Bitwarden",
  "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox",
  "Library/Application Support/Yandex", "Library/Application Support/BraveSoftware",
  "Library/Application Support/Arc", "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Code", "Library/Application Support/Code - Insiders",
  "Library/Application Support/Cursor", "Library/Application Support/VSCodium",
];

/** Inside private folders, but needed by everyday tools: git's settings. Read only. */
const HOME_READABLE = [".config/git"];
/** ...except what is private inside them again. */
const HOME_PRIVATE_AGAIN = [".config/git/credentials"];

/**
 * Package caches outside the project that builds and installs write to.
 * Only the caches: next to them live installed programs (~/.cargo/bin,
 * ~/go/bin, ~/.bun/bin...) that the user later runs outside the sandbox.
 */
const HOME_WRITABLE = [
  ".npm", ".cache", "Library/Caches", ".yarn/berry/cache", ".pnpm-store", "Library/pnpm/store", ".bun/install/cache", ".node-gyp",
  ".cargo/registry", ".cargo/git", "go/pkg/mod", ".gradle/caches", ".gradle/wrapper/dists", ".m2/repository",
  "Library/Developer/Xcode/DerivedData",
];

export interface SandboxPaths {
  root: string;
  home: string;
  /** Writable temporary folders. */
  tmpDirs: string[];
  /** Extra private folders (dimosi's own settings and keys). */
  private: string[];
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function defaultSandboxPaths(root: string): SandboxPaths {
  const tmp = real(os.tmpdir());
  // macOS keeps per-user caches next to the temp folder: .../T and .../C.
  const tmpDirs = [path.basename(tmp) === "T" ? path.dirname(tmp) : tmp, "/private/tmp"];
  return { root, home: os.homedir(), tmpDirs, private: [path.dirname(defaultGlobalRulesPath())] };
}

/** Seatbelt string literal. */
function q(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Seatbelt regex literal for a path: everything special is escaped. */
function regexQuote(p: string): string {
  return p.replace(/[.*+?^${}()|[\]\\/"-]/g, "\\$&");
}

/** `from` and the folders below it on the way to `to` (not `to` itself). */
function foldersBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let p = path.dirname(to); inside(p, from); p = path.dirname(p)) out.push(p);
  return out;
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + "/");

/**
 * Rules for macOS's built-in sandbox (the one Claude Code uses there too).
 * A command may read almost everything but write only to the project,
 * temp folders and package caches; private folders can't be read at all.
 * The network stays open: installs need it.
 */
export function sandboxProfile(paths: SandboxPaths): string {
  const root = real(paths.root);
  const home = real(paths.home);
  const priv = [...HOME_PRIVATE.map((p) => path.join(home, p)), ...paths.private.map(real)];
  const sub = (list: string[]) => list.map((p) => `(subpath ${q(p)})`).join(" ");
  // A project inside, say, Documents stays usable: its folder is allowed after the ban.
  const around = priv.filter((p) => inside(root, p));
  const within = priv.filter((p) => !inside(root, p));
  const way = around.flatMap((p) => foldersBetween(p, root));
  const secrets = secretPathPatterns(regexQuote(root));
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath "/dev") ${sub(paths.tmpDirs.map(real))} ${sub(HOME_WRITABLE.map((p) => path.join(home, p)))})`,
    around.length ? `(deny file-read* file-write* ${sub(around)})` : "",
    // Tools (git init, for one) check every folder on the way to the project; listing them stays closed.
    way.length ? `(allow file-read-metadata ${way.map((p) => `(literal ${q(p)})`).join(" ")})` : "",
    `(allow file-read* file-write* (subpath ${q(root)}))`,
    // The project's own secrets (.env, keys...): a command's output goes to the AI service.
    `(deny file-read* ${secrets.secret.map((r) => `(regex #"${r}")`).join(" ")})`,
    `(allow file-read* (regex #"${secrets.template}"))`,
    within.length ? `(deny file-read* file-write* ${sub(within)})` : "",
    `(allow file-read* ${sub(HOME_READABLE.map((p) => path.join(home, p)))})`,
    `(deny file-read* file-write* ${sub(HOME_PRIVATE_AGAIN.map((p) => path.join(home, p)))})`,
    // Files that run code later, outside the sandbox: VS Code tasks and git hooks.
    `(deny file-write* (subpath ${q(path.join(root, ".vscode"))}))`,
    // The agent's own rules: a command must not give it new instructions.
    `(deny file-write* (subpath ${q(path.join(root, ".dimosi"))}))`,
    // Also run later without the sandbox: Husky git hooks, direnv, dev
    // containers, GitHub Actions. package.json is not here: `npm install <pkg>`
    // must write it; writes by the agent itself are always asked about.
    `(deny file-write* ${sub([".husky", ".devcontainer", ".github/workflows"].map((p) => path.join(root, p)))} (regex #"^${regexQuote(root)}/(.*/)?\\.envrc$"))`,
    // Programs started through macOS itself run outside the sandbox: `open`
    // (Launch Services) and Apple Events to other apps (Terminal, Finder...).
    `(deny mach-lookup (global-name-prefix "com.apple.coreservices."))`,
    "(deny appleevent-send)",
  ];
  // Before `git init` there is nothing to protect, and init must be able to create them.
  // In a repository: hooks and settings of any repository inside the project
  // (nested ones, submodules, worktrees), and .git folders themselves, so they
  // can't be renamed, changed and put back.
  if (existsSync(path.join(root, ".git"))) {
    const git = String.raw`(.*/)?\.git`;
    const inner = String.raw`/((modules/.+/)|(worktrees/[^/]+/))?(hooks(/|$)|config$|config\.worktree$)`;
    lines.push(`(deny file-write* (regex #"^${regexQuote(root)}/${git}(${inner}|$)"))`);
  }
  return lines.filter(Boolean).join("\n");
}

/** Program and arguments that run `command` through /bin/sh inside the sandbox. */
export function sandboxedCommand(command: string, paths: SandboxPaths): { file: string; args: string[] } {
  return { file: SANDBOX_EXEC, args: ["-p", sandboxProfile(paths), "/bin/sh", "-c", command] };
}

let available: boolean | undefined;

/** macOS only; it also fails when dimosi itself already runs inside a sandbox. */
export function sandboxAvailable(): boolean {
  if (available === undefined) {
    available = process.platform === "darwin"
      && existsSync(SANDBOX_EXEC)
      && spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore", timeout: 5000 }).status === 0;
  }
  return available;
}

/** Tests only: pretend the sandbox does (not) start; undefined probes again. */
export function overrideSandboxAvailable(value: boolean | undefined): void {
  available = value;
}
