import { lstatSync, realpathSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultGlobalRulesPath } from "./rules";

// One rule for what the agent may reach: the project plus the folders the user
// opened. The file tools and the command sandbox both read it from here, so
// they can't disagree.

export type AccessMode = "read" | "write";

/** A folder outside the project that the user opened to the agent. */
export interface ExtraFolder {
  path: string;
  mode: AccessMode;
}

export interface AccessPolicy {
  /** The project: always readable and writable. */
  root: string;
  /** Extra folders that passed the checks, by real path. */
  folders: ExtraFolder[];
  /** Folders from the settings that are not used, with the reason for the user. */
  rejected: Array<{ path: string; reason: string }>;
  /** Closed whatever is opened: keys, passwords, personal files, dimosi's own settings. */
  private: string[];
}

/** Home folders with keys, passwords and personal files: no reading, no writing. */
export const HOME_PRIVATE = [
  ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".password-store",
  // Settings of command-line tools, often with their logins (gh, cloud tools...). git's own folder is opened again in the sandbox.
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

/**
 * Personal folders where the user keeps their own work. A folder inside one
 * may be opened by name (a project there works the same way); the rest of it
 * stays closed, and the personal folder itself can't be opened whole. Folders
 * with keys and program data can't be opened at all.
 */
const HOME_PERSONAL = ["Documents", "Desktop", "Downloads", "Pictures", "Movies", "Music"];

export const MAX_EXTRA_FOLDERS = 20;

/** Line breaks and other control characters: the path goes into the system prompt. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** `child` is `parent` itself or lies below it. */
export function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/** Private folders as full paths: the list above plus dimosi's own. */
export function privateDirs(home: string, own: string[]): string[] {
  const h = realPath(home);
  return [...HOME_PRIVATE.map((p) => path.join(h, p)), ...own.map(realPath)];
}

/** The folder with dimosi's settings, keys and trust decisions. */
export const ownDirs = (): string[] => [path.dirname(defaultGlobalRulesPath())];

/** Reads the list as written in the settings: `[{ "path": "...", "access": "read" | "write" }]`. */
export function parseExtraFolders(raw: unknown): ExtraFolder[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtraFolder[] = [];
  for (const item of raw) {
    const p = typeof item === "string" ? item : (item as { path?: unknown } | null)?.path;
    if (typeof p !== "string" || !p.trim()) continue;
    out.push({ path: p.trim(), mode: (item as { access?: unknown }).access === "write" ? "write" : "read" });
  }
  return out;
}

export interface AccessOptions {
  /** Override for tests; defaults to the user's home folder. */
  home?: string;
  /** Override for tests; defaults to dimosi's settings folder. */
  own?: string[];
}

/** Why a folder can't be opened to the agent (for the user), or its real path. */
function checkFolder(folder: string, root: string | undefined, home: string, priv: string[]): { path: string } | { reason: string } {
  if (CONTROL.test(folder)) return { reason: "в пути есть скрытые символы" };
  const expanded = folder === "~" || folder.startsWith("~/") ? path.join(home, folder.slice(1)) : folder;
  if (!path.isAbsolute(expanded)) return { reason: "нужен полный путь, например /Users/имя/папка" };
  let real: string;
  try {
    real = realpathSync(expanded);
    if (!statSync(real).isDirectory()) return { reason: "это файл, а не папка" };
  } catch {
    return { reason: "папка не найдена" };
  }
  if (CONTROL.test(real)) return { reason: "в пути есть скрытые символы" };
  if (inside(home, real)) return { reason: "слишком широко: откройте конкретную папку, а не всю домашнюю или весь диск" };
  const personal = HOME_PERSONAL.map((p) => path.join(home, p));
  if (priv.some((p) => inside(real, p) && !personal.includes(p))) {
    return { reason: "закрытая папка: в ней ключи, пароли или данные программ" };
  }
  // The whole of Documents or ~/Library: what is closed inside would stay closed, but the rest is too much to open at once.
  if (priv.some((p) => inside(p, real))) return { reason: "слишком широко: внутри есть закрытые папки (личные файлы, ключи, данные программ). Откройте конкретную папку внутри" };
  if (root !== undefined && inside(real, realPath(root))) return { reason: "она внутри проекта и уже доступна" };
  return { path: real };
}

/** The reason a folder can't be opened, for the user; undefined if it can. */
export function extraFolderProblem(folder: string, root?: string, opts: AccessOptions = {}): string | undefined {
  const home = realPath(opts.home ?? os.homedir());
  const result = checkFolder(folder, root, home, privateDirs(home, opts.own ?? ownDirs()));
  return "reason" in result ? result.reason : undefined;
}

export function createAccess(root: string, extra: ExtraFolder[] = [], opts: AccessOptions = {}): AccessPolicy {
  const home = realPath(opts.home ?? os.homedir());
  const priv = privateDirs(home, opts.own ?? ownDirs());
  const policy: AccessPolicy = { root, folders: [], rejected: [], private: priv };
  for (const folder of extra) {
    const checked = checkFolder(folder.path, root, home, priv);
    if ("reason" in checked) {
      policy.rejected.push({ path: folder.path, reason: checked.reason });
    } else if (policy.folders.some((f) => f.path === checked.path)) {
      policy.rejected.push({ path: folder.path, reason: "уже есть в списке" });
    } else if (policy.folders.length >= MAX_EXTRA_FOLDERS) {
      policy.rejected.push({ path: folder.path, reason: `не больше ${MAX_EXTRA_FOLDERS} папок` });
    } else {
      policy.folders.push({ path: checked.path, mode: folder.mode });
    }
  }
  return policy;
}

/** The project and the extra folders, by real path. */
function openFolders(policy: AccessPolicy): ExtraFolder[] {
  return [{ path: realPath(policy.root), mode: "write" }, ...policy.folders];
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Where a path really leads, links followed. For a path that does not exist
 * yet, the nearest existing parent decides: new folders are created there.
 */
function realTarget(abs: string, original = abs): string {
  let existing = abs;
  for (;;) {
    try {
      return path.join(realpathSync(existing), path.relative(existing, abs));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (isSymlink(existing)) throw new Error(`Path "${original}" goes through a broken symlink.`);
      const parent = path.dirname(existing);
      if (parent === existing) return abs;
      existing = parent;
    }
  }
}

/** In a private folder that none of the open folders was chosen inside of. */
function isPrivate(policy: AccessPolicy, real: string, holders: ExtraFolder[]): boolean {
  return policy.private.some((p) => inside(real, p) && !holders.some((h) => inside(h.path, p)));
}

/** A folder met while listing files that must not be looked into. */
export function isClosedFolder(policy: AccessPolicy, abs: string): boolean {
  const real = realPath(abs);
  return isPrivate(policy, real, openFolders(policy).filter((f) => inside(real, f.path)));
}

/**
 * Resolves a model-supplied path (relative to the project, or absolute) and
 * refuses anything outside the project and the extra folders, anything in a
 * private folder, and writing where the user allowed only reading.
 */
export function resolvePath(policy: AccessPolicy, p: string, need: AccessMode = "read"): string {
  const abs = path.resolve(policy.root, p || ".");
  const real = realTarget(abs, p);
  const holders = openFolders(policy).filter((f) => inside(real, f.path));
  if (!holders.length) {
    throw new Error(`Path "${p}" is outside the project root${policy.folders.length ? " and the extra folders the user opened" : ""}.`);
  }
  if (isPrivate(policy, real, holders)) {
    throw new Error(`Path "${p}" is in a private folder (keys, passwords, personal files). It stays closed whatever else is opened.`);
  }
  if (need === "write" && !holders.some((f) => f.mode === "write")) {
    throw new Error(
      `Path "${p}" is in a folder the user opened for reading only, so it is not changed. ` +
        "If the change is needed, tell the user: they can allow writing there (chat panel: «Доступ» → «Изменить»).",
    );
  }
  return abs;
}

/** Resolves a path and refuses anything outside the project root. */
export function resolveInRoot(root: string, p: string): string {
  return resolvePath(createAccess(root), p);
}

const slashes = (p: string) => p.split(path.sep).join("/");

/** How a path is shown to the model and the user: relative inside the project, full outside it. */
export function showPath(policy: AccessPolicy, abs: string): string {
  return inside(abs, policy.root) ? slashes(path.relative(policy.root, abs)) || "." : slashes(abs);
}

/**
 * The open folder a path belongs to, for listing and searching: the folder
 * whose .gitignore applies, the place to start from, and how to show what is
 * found (see showPath).
 */
export function folderOf(policy: AccessPolicy, abs: string): { dir: string; start: string; show: (rel: string) => string } {
  if (inside(abs, policy.root)) return { dir: policy.root, start: abs, show: (rel) => rel };
  const real = realTarget(abs);
  const dir = policy.folders.find((f) => inside(real, f.path))?.path ?? path.dirname(real);
  return { dir, start: real, show: (rel) => slashes(path.join(dir, rel)) };
}

/** A path relative to the open folder it really lies in (links followed). */
export function relativeInFolder(policy: AccessPolicy, abs: string): string {
  const real = realTarget(abs);
  const holder = openFolders(policy).find((f) => inside(real, f.path));
  return holder ? path.relative(holder.path, real) : real;
}

/** "проект + 2 папки": what the agent can reach, for the user. */
export function accessSummary(policy: AccessPolicy): string {
  const n = policy.folders.length;
  if (!n) return "проект";
  const word = n % 10 === 1 && n % 100 !== 11 ? "папка" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "папки" : "папок";
  return `проект + ${n} ${word}`;
}

export const modeLabel = (mode: AccessMode): string => (mode === "write" ? "чтение и запись" : "только чтение");
