import { lstatSync, promises as fs, realpathSync } from "node:fs";
import * as path from "node:path";

const ALWAYS_IGNORED = new Set([".git", "node_modules", ".DS_Store", "dist", "out", ".next", "__pycache__", ".venv", "venv"]);

/** Resolves a model-supplied path and refuses anything outside the project root. */
export function resolveInRoot(root: string, p: string): string {
  const abs = path.resolve(root, p || ".");
  assertInside(root, abs, p);
  // Follow symlinks so a link can't point outside. For a path that does not
  // exist yet, check the nearest existing parent: new folders are created there.
  let existing = abs;
  for (;;) {
    try {
      assertInside(realpathSync(root), realpathSync(existing), p);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (isSymlink(existing)) throw new Error(`Path "${p}" goes through a broken symlink.`);
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  return abs;
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function assertInside(root: string, abs: string, original: string): void {
  const rel = path.relative(root, abs);
  if (rel === "") return;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path "${original}" is outside the project root.`);
  }
}

export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/") || ".";
}

/** Minimal .gitignore support: name globs and directory entries from the root file. */
export class IgnoreMatcher {
  private patterns: RegExp[] = [];

  static async load(root: string): Promise<IgnoreMatcher> {
    const m = new IgnoreMatcher();
    try {
      const text = await fs.readFile(path.join(root, ".gitignore"), "utf8");
      for (let line of text.split(/\r?\n/)) {
        line = line.trim();
        if (!line || line.startsWith("#") || line.startsWith("!")) continue;
        line = line.replace(/^\//, "").replace(/\/$/, "");
        m.patterns.push(globToRegExp(line));
      }
    } catch {
      // no .gitignore
    }
    return m;
  }

  ignores(relPath: string, name: string): boolean {
    if (ALWAYS_IGNORED.has(name)) return true;
    return this.patterns.some((re) => re.test(name) || re.test(relPath));
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Walks files under `dir`, skipping ignored entries. Stops after `limit` results. */
export async function walk(
  root: string,
  dir: string,
  ignore: IgnoreMatcher,
  opts: { limit: number; maxDepth?: number; includeDirs?: boolean },
): Promise<{ paths: string[]; truncated: boolean }> {
  const out: string[] = [];
  let truncated = false;

  async function visit(current: string, depth: number): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = toRel(root, abs);
      if (ignore.ignores(rel, entry.name)) continue;
      if (out.length >= opts.limit) {
        truncated = true;
        return;
      }
      if (entry.isDirectory()) {
        if (opts.includeDirs) out.push(rel + "/");
        if (opts.maxDepth === undefined || depth < opts.maxDepth) await visit(abs, depth + 1);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }

  await visit(dir, 1);
  return { paths: out, truncated };
}

const SECRET_FILES = [
  /^\.env(\..+)?$/,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /^\.(npmrc|netrc|pypirc|pgpass)$/,
  /^(credentials|secrets?)(\.(json|ya?ml|toml))?$/,
  // dimosi's own release settings (update server address and SSH).
  /^release\.config\.json$/,
];
const SECRET_TEMPLATE = /\.(example|sample|template|dist|defaults?)$/;

/**
 * Files that usually hold keys and passwords. The agent does not read or
 * search them: whatever it reads goes to the AI service.
 */
export function isSecretFile(relPath: string): boolean {
  const name = relPath.split(/[\\/]/).at(-1)!.toLowerCase();
  return !SECRET_TEMPLATE.test(name) && SECRET_FILES.some((re) => re.test(name));
}
