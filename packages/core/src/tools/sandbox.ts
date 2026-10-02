import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultGlobalRulesPath } from "../rules";

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
  ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".password-store", ".config/gh",
  // Tokens in plain text: git's "store" helper, curl/ftp, npm and PyPI logins.
  ".git-credentials", ".config/git/credentials", ".netrc", ".npmrc", ".pypirc",
  ".zsh_history", ".bash_history",
  "Documents", "Desktop", "Downloads", "Pictures", "Movies", "Music",
  "Library/Keychains", "Library/Mail", "Library/Messages", "Library/Safari", "Library/Cookies",
  "Library/Mobile Documents",
  "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox",
  "Library/Application Support/Code",
];

/** Package caches outside the project that builds and installs write to. */
const HOME_WRITABLE = [
  ".npm", ".cache", "Library/Caches", ".yarn", ".pnpm-store", "Library/pnpm", ".bun", ".node-gyp",
  ".cargo", ".rustup", "go", ".gradle", ".m2", "Library/Developer/Xcode/DerivedData",
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
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath "/dev") ${sub(paths.tmpDirs.map(real))} ${sub(HOME_WRITABLE.map((p) => path.join(home, p)))})`,
    around.length ? `(deny file-read* file-write* ${sub(around)})` : "",
    `(allow file-read* file-write* (subpath ${q(root)}))`,
    within.length ? `(deny file-read* file-write* ${sub(within)})` : "",
    // Files that run code later, outside the sandbox: VS Code tasks and git hooks.
    `(deny file-write* (subpath ${q(path.join(root, ".vscode"))}))`,
  ];
  // Before `git init` there is nothing to protect, and init must be able to create them.
  if (existsSync(path.join(root, ".git"))) {
    lines.push(`(deny file-write* (subpath ${q(path.join(root, ".git/hooks"))}) (literal ${q(path.join(root, ".git/config"))}))`);
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
