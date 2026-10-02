import { spawn } from "node:child_process";
import { existsSync, promises as fs, realpathSync } from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Worker } from "node:worker_threads";
import type { PermissionGate } from "../permissions";
import type { ToolCallPart, ToolDefinition } from "../types";
import { commandEnv, defaultSandboxPaths, sandboxAvailable, sandboxedCommand } from "./sandbox";
import { IgnoreMatcher, isSecretFile, resolveInRoot, toRel, walk } from "./workspace";

export interface FileChange {
  /** Absolute path. */
  path: string;
  relPath: string;
  /** null when the file was created. */
  oldContent: string | null;
  newContent: string;
}

export type PlanStatus = "pending" | "in_progress" | "done";

export interface PlanItem {
  title: string;
  status: PlanStatus;
}

/**
 * How tools read and write the files they change. The CLI works with the
 * disk; VS Code goes through open editors, so unsaved edits are seen and
 * the agent's change can be undone with Ctrl+Z.
 */
export interface FileAccess {
  /** Current text; null if the file does not exist. Throws NotUtf8Error for anything that is not UTF-8. */
  readText(abs: string): Promise<string | null>;
  /** Creates or replaces the file (parent folders included). Returns the text that actually landed. */
  writeText(abs: string, text: string): Promise<string>;
}

/** The file is binary or uses an old encoding; changing it would corrupt it. */
export class NotUtf8Error extends Error {
  constructor() {
    super("not UTF-8");
  }
}

export const diskFiles: FileAccess = {
  async readText(abs) {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new NotUtf8Error();
    }
  },
  async writeText(abs, text) {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, "utf8");
    return text;
  },
};

export interface ToolContext {
  root: string;
  gate: PermissionGate;
  /** Defaults to diskFiles. */
  files?: FileAccess;
  signal?: AbortSignal;
  onFileChange?: (change: FileChange) => void;
  onPlan?: (items: PlanItem[]) => void;
  /** Override for tests; defaults to SEARCH_TIMEOUT_MS. */
  searchTimeoutMs?: number;
  /** Run commands in the macOS sandbox. Default: true (ignored elsewhere). */
  sandbox?: boolean;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

const MAX_READ_LINES = 2000;
/** One reply must not flood the model's context (minified files, huge JSON). */
const MAX_READ_CHARS = 50_000;
const MAX_LINE_CHARS = 2000;
const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 30_000;
const SEARCH_TIMEOUT_MS = 15_000;

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_files",
    description:
      "List files and directories in the project (respects .gitignore). Directories end with '/'.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to the project root. Default: root." },
        depth: { type: "integer", description: "How many levels deep to list. Default 2." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: `Read a text file. Returns numbered lines (up to ${MAX_READ_LINES} per call; use offset to page).`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        offset: { type: "integer", description: "1-based line to start from. Default 1." },
        limit: { type: "integer", description: `Number of lines. Default ${MAX_READ_LINES}.` },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description: "Search file contents in the project. Returns 'path:line: text' matches.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text to find (or a regular expression if regex=true)." },
        regex: { type: "boolean", description: "Treat pattern as a JavaScript regular expression." },
        path: { type: "string", description: "Directory to search in. Default: root." },
        case_sensitive: { type: "boolean", description: "Default false." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Create a file or overwrite it with the full new content. Parent directories are created. The user reviews a diff before it is applied.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        content: { type: "string", description: "Complete file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact snippet in an existing file. old_string must match exactly once unless replace_all is true. Prefer this over write_file for small changes. Read the file first.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        old_string: { type: "string", description: "Exact text to replace, including whitespace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence. Default false." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "update_plan",
    description:
      "Show the user your step-by-step plan for the current task and its progress. Send the full list every time; keep exactly one step in_progress while working.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "All steps of the plan, in order.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short step description in the user's language." },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
            },
            required: ["title", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the project root (build, tests, git, package managers...). The user approves each command. Returns exit code and combined output.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
        timeout_seconds: { type: "integer", description: "Default 120, max 600." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

type Input = Record<string, unknown>;

export async function executeTool(call: ToolCallPart, ctx: ToolContext): Promise<ToolResult> {
  try {
    if ("__invalid_arguments" in call.input) {
      throw new Error(`Tool arguments were not valid JSON: ${String(call.input.__invalid_arguments).slice(0, 500)}`);
    }
    const handler = HANDLERS[call.name];
    if (!handler) throw new Error(`Unknown tool "${call.name}".`);
    return { content: await handler(call.input, ctx), isError: false };
  } catch (e) {
    return { content: e instanceof Error ? e.message : String(e), isError: true };
  }
}

function str(input: Input, key: string, required = true): string {
  const v = input[key];
  if (typeof v === "string") return v;
  if (v === undefined && !required) return "";
  throw new Error(`Missing or invalid "${key}" (expected a string).`);
}

function num(input: Input, key: string, fallback: number): number {
  const v = input[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
}

/** Reads a file the agent is about to change. Refuses anything that is not valid UTF-8. */
async function readTextOrNull(files: FileAccess, abs: string, relPath: string): Promise<string | null> {
  try {
    return await files.readText(abs);
  } catch (e) {
    if (!(e instanceof NotUtf8Error)) throw e;
    // Writing a non-UTF-8 file back as UTF-8 would silently destroy its text.
    throw new Error(
      `${relPath} is not a UTF-8 text file (it may be binary or use an old encoding such as windows-1251). ` +
        "It is not changed to avoid corrupting it. Tell the user it has to be converted to UTF-8 first.",
    );
  }
}

const inGit = (rel: string) => rel.toLowerCase().split(/[\\/]/).includes(".git");

/**
 * Git internals (hooks run code on commit) are never written by the agent:
 * in any letter case (macOS ignores it), at any depth (nested repositories),
 * and not through a link either.
 */
function assertWritable(root: string, abs: string): void {
  let existing = abs;
  while (!existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  if (inGit(toRel(root, abs)) || inGit(path.relative(realpathSync(root), realpathSync(existing)))) {
    throw new Error("Writing inside .git is not allowed.");
  }
}

const HANDLERS: Record<string, (input: Input, ctx: ToolContext) => Promise<string>> = {
  async list_files(input, { root }) {
    const dir = resolveInRoot(root, str(input, "path", false));
    const ignore = await IgnoreMatcher.load(root);
    const { paths, truncated } = await walk(root, dir, ignore, {
      limit: 500,
      maxDepth: Math.max(1, num(input, "depth", 2)),
      includeDirs: true,
    });
    if (!paths.length) return "(empty)";
    return paths.join("\n") + (truncated ? "\n... (truncated at 500 entries)" : "");
  },

  async read_file(input, { root, files = diskFiles }) {
    const abs = resolveInRoot(root, str(input, "path"));
    if (isSecretFile(toRel(root, abs))) {
      throw new Error(
        `${toRel(root, abs)} may contain secrets (keys, passwords), so it is not read: its text would be sent to the AI service. ` +
          "If something from it is needed, ask the user (for example, the names of the settings, not their values).",
      );
    }
    const { size } = await fs.stat(abs);
    if (size > MAX_READ_BYTES) {
      throw new Error(`File is too large to read (${Math.round(size / 1024 / 1024)} MB). Use search to find the relevant part.`);
    }
    // The model must see what the user sees (in VS Code: unsaved edits), or its next edit won't match.
    let text: string;
    try {
      text = (await files.readText(abs)) ?? "";
    } catch (e) {
      if (!(e instanceof NotUtf8Error)) throw e;
      text = await fs.readFile(abs, "utf8");
    }
    if (text.includes("\u0000")) throw new Error("File looks binary; not reading it.");
    const lines = text.split("\n");
    const offset = Math.max(1, num(input, "offset", 1));
    const limit = Math.min(MAX_READ_LINES, Math.max(1, num(input, "limit", MAX_READ_LINES)));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const width = String(offset + slice.length).length;
    const out: string[] = [];
    let chars = 0;
    for (const [i, raw] of slice.entries()) {
      const line = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)} ... (line cut, ${raw.length} characters)` : raw;
      const numbered = `${String(offset + i).padStart(width)}\t${line}`;
      if (out.length && chars + numbered.length > MAX_READ_CHARS) break;
      out.push(numbered);
      chars += numbered.length + 1;
    }
    const end = offset - 1 + out.length;
    const more = end < lines.length ? `\n... (${lines.length - end} more lines; use offset=${end + 1})` : "";
    return (out.join("\n") || "(empty file)") + more;
  },

  async search(input, { root, signal, searchTimeoutMs }) {
    const pattern = str(input, "pattern");
    const flags = input.case_sensitive === true ? "" : "i";
    const source = input.regex === true ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    new RegExp(source, flags); // reports a broken pattern as a normal tool error
    const dir = resolveInRoot(root, str(input, "path", false));
    const ignore = await IgnoreMatcher.load(root);
    const { paths } = await walk(root, dir, ignore, { limit: 20_000 });
    signal?.throwIfAborted();
    const { matches, stopped } = await searchInWorker(root, paths.filter((p) => !isSecretFile(p)), source, flags, signal, searchTimeoutMs ?? SEARCH_TIMEOUT_MS);
    if (stopped) return matches.join("\n") + "\n... (stopped at 200 matches)";
    return matches.length ? matches.join("\n") : "No matches.";
  },

  async update_plan(input, { onPlan }) {
    if (!Array.isArray(input.items)) throw new Error('"items" must be an array.');
    const statuses: PlanStatus[] = ["pending", "in_progress", "done"];
    const items: PlanItem[] = input.items.slice(0, 30).map((raw, i) => {
      const item = raw as Record<string, unknown>;
      if (typeof item?.title !== "string" || !item.title.trim()) throw new Error(`Step ${i + 1} has no title.`);
      const status = statuses.includes(item.status as PlanStatus) ? (item.status as PlanStatus) : "pending";
      return { title: item.title.trim().slice(0, 200), status };
    });
    onPlan?.(items);
    const done = items.filter((i) => i.status === "done").length;
    return `Plan updated (${done}/${items.length} done).`;
  },

  async write_file(input, { root, gate, files = diskFiles, onFileChange }) {
    const abs = resolveInRoot(root, str(input, "path"));
    assertWritable(root, abs);
    const content = str(input, "content");
    const oldContent = await readTextOrNull(files, abs, toRel(root, abs));
    if (oldContent === content) return "File already has this content; nothing changed.";
    const ok = await gate.check({ kind: "write", path: abs, relPath: toRel(root, abs), oldContent, newContent: content });
    if (!ok) throw new Error("The user rejected this change.");
    // The path is checked again: a link could have been swapped while the user decided.
    resolveInRoot(root, str(input, "path"));
    const written = await files.writeText(abs, content);
    onFileChange?.({ path: abs, relPath: toRel(root, abs), oldContent, newContent: written });
    return `${oldContent === null ? "Created" : "Updated"} ${toRel(root, abs)} (${countLines(content)} lines).`;
  },

  async edit_file(input, { root, gate, files = diskFiles, onFileChange }) {
    const abs = resolveInRoot(root, str(input, "path"));
    assertWritable(root, abs);
    let oldString = str(input, "old_string");
    let newString = str(input, "new_string");
    if (!oldString) throw new Error("old_string must not be empty. Use write_file to create files.");
    const oldContent = await readTextOrNull(files, abs, toRel(root, abs));
    if (oldContent === null) throw new Error(`File ${toRel(root, abs)} does not exist.`);
    let count = oldContent.split(oldString).length - 1;
    if (count === 0 && oldContent.includes("\r\n")) {
      // read_file hides \r, so the model sends LF text for a Windows (CRLF) file.
      const crlf = (t: string) => t.replace(/\r?\n/g, "\r\n");
      const n = oldContent.split(crlf(oldString)).length - 1;
      if (n > 0) {
        oldString = crlf(oldString);
        newString = crlf(newString);
        count = n;
      }
    }
    if (count === 0) throw new Error("old_string was not found in the file. Re-read the file and copy the text exactly.");
    if (count > 1 && input.replace_all !== true) {
      throw new Error(`old_string occurs ${count} times. Add surrounding context to make it unique, or set replace_all.`);
    }
    const newContent = input.replace_all === true
      ? oldContent.split(oldString).join(newString)
      : oldContent.replace(oldString, () => newString);
    const ok = await gate.check({ kind: "write", path: abs, relPath: toRel(root, abs), oldContent, newContent });
    if (!ok) throw new Error("The user rejected this change.");
    resolveInRoot(root, str(input, "path"));
    const written = await files.writeText(abs, newContent);
    onFileChange?.({ path: abs, relPath: toRel(root, abs), oldContent, newContent: written });
    return `Edited ${toRel(root, abs)} (${input.replace_all === true ? count : 1} replacement${count > 1 && input.replace_all === true ? "s" : ""}).`;
  },

  async run_command(input, { root, gate, signal, sandbox = true }) {
    const command = str(input, "command");
    const timeout = Math.min(600, Math.max(1, num(input, "timeout_seconds", 120))) * 1000;
    const sandboxed = sandbox && process.platform === "darwin";
    const unprotected = sandboxed && !sandboxAvailable();
    // Without the sandbox a command can reach the whole computer: the user decides every time.
    const warning = unprotected ? "Песочница macOS не запустилась: команда будет работать со всеми вашими правами." : undefined;
    const ok = await gate.check({ kind: "command", command, cwd: root, warning });
    if (!ok) throw new Error("The user rejected this command.");
    if (!sandboxed) return runShell(command, root, timeout, signal);
    if (unprotected) {
      return "Note: the macOS sandbox could not start, so this command ran without it.\n" + (await runShell(command, root, timeout, signal));
    }
    const result = await runShell(command, root, timeout, signal, true);
    return /Operation not permitted/.test(result)
      ? `${result}\n\n${SANDBOX_HINT}`
      : result;
  },
};

const SANDBOX_HINT =
  "Note: dimosi runs commands in a sandbox. It blocks writing outside the project (temp folders and package caches are allowed), " +
  "changing .git/hooks, .git/config, .vscode and .dimosi, and reading private folders (~/.ssh, ~/Documents, ~/Desktop, ~/Downloads and others). " +
  "Do not try to work around it. If the command really needs this, tell the user: they can run it in their own terminal.";

function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal, sandboxed = false): Promise<string> {
  if (signal?.aborted) return Promise.resolve("Cancelled by the user.");
  const isWindows = process.platform === "win32";
  const sandbox = sandboxed ? sandboxedCommand(command, defaultSandboxPaths(cwd)) : undefined;
  return new Promise((resolve) => {
    const child = spawn(sandbox?.file ?? command, sandbox?.args ?? [], {
      cwd,
      shell: !sandbox,
      // Own process group, so the whole tree can be stopped (POSIX).
      detached: !isWindows,
      windowsHide: true,
      // Nobody can answer a prompt: commands must not wait for input.
      stdio: ["ignore", "pipe", "pipe"],
      env: commandEnv(),
    });
    const output = new OutputBuffer(MAX_OUTPUT_CHARS);
    const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
    child.stdout.on("data", (chunk: Buffer) => output.append(decoders[0].write(chunk)));
    child.stderr.on("data", (chunk: Buffer) => output.append(decoders[1].write(chunk)));

    let stopReason: string | undefined;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (header: string) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      signal?.removeEventListener("abort", onAbort);
      // Background processes may still hold the pipes open; stop listening to them.
      child.stdout.destroy();
      child.stderr.destroy();
      output.append(decoders[0].end() + decoders[1].end());
      resolve(`${header}\n${output.text().trim() || "(no output)"}`);
    };
    const stop = (reason: string) => {
      if (stopReason) return;
      stopReason = reason;
      killTree(child.pid, "SIGTERM");
      // Not in `timers`: the result may be ready before a child that ignores
      // SIGTERM is gone, and that child must still be killed.
      setTimeout(() => killTree(child.pid, "SIGKILL"), 2000).unref();
      // Never hang, even if something survives the kill.
      timers.push(setTimeout(() => finish(reason), 5000));
    };
    const onAbort = () => stop("Cancelled by the user.");
    signal?.addEventListener("abort", onAbort, { once: true });
    timers.push(setTimeout(() => stop(`Timed out after ${timeoutMs / 1000}s.`), timeoutMs));

    child.on("error", (e) => finish(`Failed to start: ${e.message}`));
    child.on("close", (code, sig) => finish(stopReason ?? `Exit code: ${code ?? sig}`));
    // "close" waits for every process holding the output; give them a moment, then return.
    child.on("exit", (code, sig) => {
      timers.push(setTimeout(() => finish(stopReason ?? `Exit code: ${code ?? sig}`), 1000));
    });
  });
}

function killTree(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(-pid, sig);
    }
  } catch {
    // already gone
  }
}

/** Keeps the beginning and the end of long output: errors are usually at the end. */
class OutputBuffer {
  private head = "";
  private tail = "";
  private total = 0;
  constructor(private max: number) {}

  append(s: string): void {
    if (!s) return;
    this.total += s.length;
    const half = Math.floor(this.max / 2);
    if (this.head.length < half) {
      const take = half - this.head.length;
      this.head += s.slice(0, take);
      s = s.slice(take);
    }
    this.tail = (this.tail + s).slice(-half);
  }

  text(): string {
    const omitted = this.total - this.head.length - this.tail.length;
    return omitted > 0 ? `${this.head}\n... (${omitted} characters omitted) ...\n${this.tail}` : this.head + this.tail;
  }
}

// Runs in a worker thread: a catastrophic regular expression must not freeze
// the host (in VS Code that is every extension). Plain JS, so it survives bundling.
const SEARCH_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { root, paths, source, flags } = workerData;
const re = new RegExp(source, flags);
const matches = [];
let stopped = false;
outer: for (const rel of paths) {
  const abs = path.join(root, rel);
  let text;
  try {
    if (fs.statSync(abs).size > 1000000) continue;
    text = fs.readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\\u0000")) continue;
  const lines = text.split("\\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      matches.push(rel + ":" + (i + 1) + ": " + lines[i].trim().slice(0, 300));
      if (matches.length >= 200) { stopped = true; break outer; }
    }
  }
}
parentPort.postMessage({ matches, stopped });
`;

function searchInWorker(
  root: string,
  paths: string[],
  source: string,
  flags: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ matches: string[]; stopped: boolean }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(SEARCH_WORKER, { eval: true, workerData: { root, paths, source, flags } });
    const done = (fn: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`Search took longer than ${timeoutMs / 1000}s and was stopped. The regular expression may be too complex; use a simpler pattern or a narrower path.`))),
      timeoutMs,
    );
    const onAbort = () => done(() => reject(new Error("Cancelled by the user.")));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (result: { matches: string[]; stopped: boolean }) => done(() => resolve(result)));
    worker.once("error", (e) => done(() => reject(e)));
  });
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** One-line human summary of a tool call, for UIs. */
export function describeToolCall(call: ToolCallPart): string {
  const i = call.input;
  const s = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  switch (call.name) {
    case "list_files":
      return `Просмотр папки ${s("path") || "."}`;
    case "read_file":
      return `Чтение ${s("path")}`;
    case "search":
      return `Поиск "${s("pattern")}"${s("path") ? ` в ${s("path")}` : ""}`;
    case "write_file":
      return `Запись ${s("path")}`;
    case "edit_file":
      return `Правка ${s("path")}`;
    case "run_command":
      return `Команда: ${s("command")}`;
    case "update_plan":
      return "План работы";
    default:
      return call.name;
  }
}
