import type { Interface } from "node:readline/promises";
import { createTwoFilesPatch } from "diff";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  cyan: wrap("36"),
};

export function renderDiff(relPath: string, oldContent: string | null, newContent: string): string {
  const patch = createTwoFilesPatch(
    oldContent === null ? "/dev/null" : `a/${relPath}`,
    `b/${relPath}`,
    oldContent ?? "",
    newContent,
    "",
    "",
    { context: 3 },
  );
  const lines = patch.split("\n").filter((l) => !l.startsWith("Index:") && !l.startsWith("===="));
  const MAX = 200;
  const shown = lines.slice(0, MAX).map((l) => {
    if (l.startsWith("+++") || l.startsWith("---")) return c.bold(l);
    if (l.startsWith("+")) return c.green(l);
    if (l.startsWith("-")) return c.red(l);
    if (l.startsWith("@@")) return c.cyan(l);
    return l;
  });
  if (lines.length > MAX) shown.push(c.dim(`... (${lines.length - MAX} more diff lines)`));
  return shown.join("\n");
}

/**
 * Line-based prompts on top of readline. Lines are queued, so input that
 * arrives before the question (pasted text, piped stdin) is never lost.
 */
export class Prompter {
  private queue: string[] = [];
  private waiters: Array<(line: string | null) => void> = [];
  private closed = false;

  constructor(readonly rl: Interface) {
    rl.on("line", (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.queue.push(line);
    });
    rl.on("close", () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w(null);
    });
  }

  /** Resolves with the trimmed line, or null if input closed or the signal aborted. */
  async ask(prompt: string, opts: { hidden?: boolean; signal?: AbortSignal } = {}): Promise<string | null> {
    if (opts.signal?.aborted) return null;
    const anyRl = this.rl as unknown as { _writeToOutput: (s: string) => void };
    const original = anyRl._writeToOutput;
    if (this.closed) {
      // Input is exhausted (piped stdin): print the prompt for context, answer from the queue.
      process.stdout.write(prompt);
      const line = this.queue.shift();
      process.stdout.write((line ?? "") && !opts.hidden ? `${line}\n` : "\n");
      return line === undefined ? null : line.trim();
    }
    this.rl.setPrompt(prompt);
    this.rl.prompt();
    if (opts.hidden) {
      // Swallow the echo of typed characters; keep the final newline.
      anyRl._writeToOutput = (s: string) => {
        if (s.includes("\n") || s.includes("\r")) original.call(this.rl, "\n");
      };
    }
    try {
      const line = await this.next(opts.signal);
      if (line !== null && !process.stdin.isTTY && opts.hidden) process.stdout.write("\n");
      return line === null ? null : line.trim();
    } finally {
      anyRl._writeToOutput = original;
    }
  }

  private next(signal?: AbortSignal): Promise<string | null> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = (line: string | null) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(line);
      };
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        process.stdout.write("\n");
        resolve(null);
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
