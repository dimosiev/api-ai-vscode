import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inside, ownDirs, privateDirs, realPath as real, type ExtraFolder } from "../access";
import { secretPathPatterns } from "./workspace";

/** Variables a command needs that only look like secrets. PWD is the current folder. */
const KEEP = new Set(["SSH_AUTH_SOCK", "XAUTHORITY", "PWD", "OLDPWD"]);
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|PWD|CREDENTIAL|AUTH|DSN|COOKIE|SESSION|_PAT$/i;
/** An address with a password in it: postgres://user:password@host. */
const PASSWORD_IN_URL = /:\/\/[^\s/@]*:[^\s/@]+@/;

/**
 * Environment for the agent's commands: the user's, minus anything that
 * looks like a key, token or password (by name or, for addresses, by value). A command (or a package script it
 * starts) then can't print or send the API keys the editor was started with.
 */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (KEEP.has(name) || (!SECRET_NAME.test(name) && !PASSWORD_IN_URL.test(value ?? ""))) out[name] = value;
  }
  // Nobody can answer a prompt: commands must not wait for input.
  out.CI = "1";
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

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
  /** Folders outside the project that the user opened (already checked, see createAccess). */
  folders?: ExtraFolder[];
}

export function defaultSandboxPaths(root: string, folders: ExtraFolder[] = []): SandboxPaths {
  const tmp = real(os.tmpdir());
  // macOS keeps per-user caches next to the temp folder: .../T and .../C.
  const tmpDirs = [path.basename(tmp) === "T" ? path.dirname(tmp) : tmp, "/private/tmp"];
  return { root, home: os.homedir(), tmpDirs, private: ownDirs(), folders };
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

/**
 * Rules for macOS's built-in sandbox (the one Claude Code uses there too).
 * A command may read almost everything but write only to the project, the
 * extra folders opened for writing, temp folders and package caches; private
 * folders can't be read at all. The network stays open: installs need it.
 */
export function sandboxProfile(paths: SandboxPaths): string {
  const root = real(paths.root);
  const home = real(paths.home);
  // Shallow folders first: a rule for a deeper folder comes later and wins.
  const open: ExtraFolder[] = [{ path: root, mode: "write" as const }, ...(paths.folders ?? []).map((f) => ({ ...f, path: real(f.path) }))]
    .sort((a, b) => a.path.length - b.path.length);
  const writable = open.filter((f) => f.mode === "write").map((f) => f.path);
  const priv = privateDirs(home, paths.private);
  const sub = (list: string[]) => list.map((p) => `(subpath ${q(p)})`).join(" ");
  // An open folder inside, say, Documents stays usable: it is allowed after the ban.
  const opened = (p: string) => open.filter((f) => inside(f.path, p));
  const around = priv.filter((p) => opened(p).length);
  const within = priv.filter((p) => !opened(p).length);
  const way = [...new Set(around.flatMap((p) => opened(p).flatMap((f) => foldersBetween(p, f.path))))];
  const secrets = open.map((f) => secretPathPatterns(regexQuote(f.path)));
  const regexes = (list: string[]) => list.map((r) => `(regex #"${r}")`).join(" ");
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath "/dev") ${sub(paths.tmpDirs.map(real))} ${sub(HOME_WRITABLE.map((p) => path.join(home, p)))})`,
    around.length ? `(deny file-read* file-write* ${sub(around)})` : "",
    // Tools (git init, for one) check every folder on the way to the project; listing them stays closed.
    way.length ? `(allow file-read-metadata ${way.map((p) => `(literal ${q(p)})`).join(" ")})` : "",
    ...open.map((f) =>
      f.mode === "write"
        ? `(allow file-read* file-write* (subpath ${q(f.path)}))`
        // Read only, also when it lies in a temp folder or a cache.
        : `(allow file-read* (subpath ${q(f.path)}))\n(deny file-write* (subpath ${q(f.path)}))`,
    ),
    // Secrets of the open folders (.env, keys...): a command's output goes to the AI service.
    // Only their contents: tools may still see that they exist.
    `(deny file-read-data ${regexes(secrets.flatMap((s) => s.secret))})`,
    `(allow file-read-data ${regexes(secrets.flatMap((s) => [s.template, s.dependencies]))})`,
    within.length ? `(deny file-read* file-write* ${sub(within)})` : "",
    `(allow file-read* ${sub(HOME_READABLE.map((p) => path.join(home, p)))})`,
    `(deny file-read* file-write* ${sub(HOME_PRIVATE_AGAIN.map((p) => path.join(home, p)))})`,
    // Files that run code later, outside the sandbox: VS Code tasks and git hooks.
    // The agent's own rules: a command must not give it new instructions.
    // Also run later without the sandbox: Husky git hooks, direnv, dev
    // containers, GitHub Actions. package.json is not here: `npm install <pkg>`
    // must write it; writes by the agent itself are always asked about.
    `(deny file-write* ${sub(writable.flatMap((dir) => [".vscode", ".dimosi", ".husky", ".devcontainer", ".github/workflows"].map((p) => path.join(dir, p))))} ${regexes(writable.map((dir) => `^${regexQuote(dir)}/(.*/)?\\.envrc$`))})`,
    // Programs started through macOS itself run outside the sandbox: `open`
    // (Launch Services) and Apple Events to other apps (Terminal, Finder...).
    `(deny mach-lookup (global-name-prefix "com.apple.coreservices."))`,
    "(deny appleevent-send)",
  ];
  // Before `git init` there is nothing to protect, and init must be able to create them.
  // In a repository: hooks and settings of any repository inside the folder
  // (nested ones, submodules, worktrees), and .git folders themselves, so they
  // can't be renamed, changed and put back.
  for (const dir of writable) {
    if (!existsSync(path.join(dir, ".git"))) continue;
    const git = String.raw`(.*/)?\.git`;
    const inner = String.raw`/((modules/.+/)|(worktrees/[^/]+/))?(hooks(/|$)|config$|config\.worktree$)`;
    lines.push(`(deny file-write* (regex #"^${regexQuote(dir)}/${git}(${inner}|$)"))`);
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
