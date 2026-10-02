import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { PermissionGate } from "../permissions";
import type { ToolCallPart, ToolDefinition } from "../types";
import { IgnoreMatcher, resolveInRoot, toRel, walk } from "./workspace";

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

export interface ToolContext {
  root: string;
  gate: PermissionGate;
  signal?: AbortSignal;
  onFileChange?: (change: FileChange) => void;
  onPlan?: (items: PlanItem[]) => void;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

const MAX_READ_LINES = 2000;
const MAX_OUTPUT_CHARS = 30_000;

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

async function readTextOrNull(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
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

  async read_file(input, { root }) {
    const abs = resolveInRoot(root, str(input, "path"));
    const text = await fs.readFile(abs, "utf8");
    if (text.includes("\u0000")) throw new Error("File looks binary; not reading it.");
    const lines = text.split("\n");
    const offset = Math.max(1, num(input, "offset", 1));
    const limit = Math.min(MAX_READ_LINES, Math.max(1, num(input, "limit", MAX_READ_LINES)));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const width = String(offset + slice.length).length;
    const body = slice.map((l, i) => `${String(offset + i).padStart(width)}\t${l}`).join("\n");
    const end = offset - 1 + slice.length;
    const more = end < lines.length ? `\n... (${lines.length - end} more lines; use offset=${end + 1})` : "";
    return (body || "(empty file)") + more;
  },

  async search(input, { root }) {
    const pattern = str(input, "pattern");
    const flags = input.case_sensitive === true ? "g" : "gi";
    const re = input.regex === true
      ? new RegExp(pattern, flags)
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    const dir = resolveInRoot(root, str(input, "path", false));
    const ignore = await IgnoreMatcher.load(root);
    const { paths } = await walk(root, dir, ignore, { limit: 20_000 });
    const matches: string[] = [];
    for (const rel of paths) {
      const abs = path.join(root, rel);
      const stat = await fs.stat(abs);
      if (stat.size > 1_000_000) continue;
      const text = await fs.readFile(abs, "utf8");
      if (text.includes("\u0000")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
          if (matches.length >= 200) return matches.join("\n") + "\n... (stopped at 200 matches)";
        }
      }
    }
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

  async write_file(input, { root, gate, onFileChange }) {
    const abs = resolveInRoot(root, str(input, "path"));
    const content = str(input, "content");
    const oldContent = await readTextOrNull(abs);
    if (oldContent === content) return "File already has this content; nothing changed.";
    const ok = await gate.check({ kind: "write", path: abs, relPath: toRel(root, abs), oldContent, newContent: content });
    if (!ok) throw new Error("The user rejected this change.");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    onFileChange?.({ path: abs, relPath: toRel(root, abs), oldContent, newContent: content });
    return `${oldContent === null ? "Created" : "Updated"} ${toRel(root, abs)} (${countLines(content)} lines).`;
  },

  async edit_file(input, { root, gate, onFileChange }) {
    const abs = resolveInRoot(root, str(input, "path"));
    const oldString = str(input, "old_string");
    const newString = str(input, "new_string");
    if (!oldString) throw new Error("old_string must not be empty. Use write_file to create files.");
    const oldContent = await readTextOrNull(abs);
    if (oldContent === null) throw new Error(`File ${toRel(root, abs)} does not exist.`);
    const count = oldContent.split(oldString).length - 1;
    if (count === 0) throw new Error("old_string was not found in the file. Re-read the file and copy the text exactly.");
    if (count > 1 && input.replace_all !== true) {
      throw new Error(`old_string occurs ${count} times. Add surrounding context to make it unique, or set replace_all.`);
    }
    const newContent = input.replace_all === true
      ? oldContent.split(oldString).join(newString)
      : oldContent.replace(oldString, () => newString);
    const ok = await gate.check({ kind: "write", path: abs, relPath: toRel(root, abs), oldContent, newContent });
    if (!ok) throw new Error("The user rejected this change.");
    await fs.writeFile(abs, newContent, "utf8");
    onFileChange?.({ path: abs, relPath: toRel(root, abs), oldContent, newContent });
    return `Edited ${toRel(root, abs)} (${input.replace_all === true ? count : 1} replacement${count > 1 && input.replace_all === true ? "s" : ""}).`;
  },

  async run_command(input, { root, gate, signal }) {
    const command = str(input, "command");
    const timeout = Math.min(600, Math.max(1, num(input, "timeout_seconds", 120))) * 1000;
    const ok = await gate.check({ kind: "command", command, cwd: root });
    if (!ok) throw new Error("The user rejected this command.");
    return runShell(command, root, timeout, signal);
  },
};

function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_CHARS * 2) output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const kill = () => child.kill("SIGTERM");
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    const finish = (header: string) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      resolve(`${header}\n${truncateMiddle(output.trim(), MAX_OUTPUT_CHARS) || "(no output)"}`);
    };
    child.on("error", (e) => finish(`Failed to start: ${e.message}`));
    child.on("close", (code, sig) => {
      if (timedOut) finish(`Timed out after ${timeoutMs / 1000}s.`);
      else if (signal?.aborted) finish("Cancelled by the user.");
      else finish(`Exit code: ${code ?? sig}`);
    });
  });
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n... (${text.length - max} characters omitted) ...\n${text.slice(-half)}`;
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
