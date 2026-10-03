import { promises as fs } from "node:fs";
import * as path from "node:path";

const ALWAYS_IGNORED = new Set([".git", "node_modules", ".DS_Store", "dist", "out", ".next", "__pycache__", ".venv", "venv"]);

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
  opts: { limit: number; maxDepth?: number; includeDirs?: boolean; skipDir?: (abs: string) => boolean },
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
        if (opts.skipDir?.(abs)) continue;
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

const CREDENTIALS = String.raw`^(credentials|secrets?)(\.(json|ya?ml|toml))?$`;
/** For the sandbox, which can't tell files from folders: a folder named "credentials" is common in packages. */
const CREDENTIALS_FILE = String.raw`^(credentials|secrets?)\.(json|ya?ml|toml)$`;

/** File names (lower case) that usually hold keys and passwords. Plain sources: the sandbox reuses them. */
const SECRET_NAMES = [
  String.raw`^\.env(\..+)?$`,
  String.raw`\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$`,
  String.raw`^id_(rsa|dsa|ecdsa|ed25519)$`,
  String.raw`^\.(npmrc|netrc|pypirc|pgpass)$`,
  CREDENTIALS,
  String.raw`^\.(htpasswd|my\.cnf|git-credentials)$`,
  // WordPress database password; Composer tokens.
  String.raw`^wp-config\.php$`,
  String.raw`^auth\.json$`,
  // Google keys: service accounts and OAuth clients.
  String.raw`service[-_]?account.*\.json$`,
  String.raw`^client_secret.*\.json$`,
  // Terraform variables and state hold passwords in plain text.
  String.raw`\.(tfvars|tfstate)$`,
  // dimosi's own release settings (update server address and SSH).
  String.raw`^release\.config\.json$`,
];
/** Samples such as .env.example are not secret. */
const SECRET_TEMPLATE_NAME = String.raw`\.(example|sample|template|dist|defaults?)$`;
const SECRET_FILES = SECRET_NAMES.map((src) => new RegExp(src));
const SECRET_TEMPLATE = new RegExp(SECRET_TEMPLATE_NAME);

/**
 * The same names as patterns for whole paths under `dir`, for the macOS
 * sandbox: any letter case (the disk ignores it), wildcards stay inside one
 * folder name. `escapedDir` must already be escaped for a regular expression.
 */
export function secretPathPatterns(escapedDir: string): { secret: string[]; template: string; dependencies: string } {
  const toPath = (name: string) => {
    const body = name
      .replace(/^\^/, "")
      .replace(/(?<!\\)\.(?=[+*])/g, "[^/]")
      .replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
    return `^${escapedDir}/(.*/)?${name.startsWith("^") ? "" : "[^/]*"}${body}`;
  };
  return {
    secret: SECRET_NAMES.map((n) => toPath(n === CREDENTIALS ? CREDENTIALS_FILE : n)),
    template: toPath(SECRET_TEMPLATE_NAME),
    // Dependencies ship certificates (cacert.pem) and test keys that they read themselves.
    dependencies: `^${escapedDir}/(.*/)?(node_modules|\\.venv|venv|site-packages|vendor)/`,
  };
}

/**
 * Files that usually hold keys and passwords. The agent does not read or
 * search them: whatever it reads goes to the AI service.
 */
export function isSecretFile(relPath: string): boolean {
  const name = relPath.split(/[\\/]/).at(-1)!.toLowerCase();
  return !SECRET_TEMPLATE.test(name) && SECRET_FILES.some((re) => re.test(name));
}
