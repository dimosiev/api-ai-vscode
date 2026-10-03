import * as vscode from "vscode";
import type { FileProblem, ProblemWatcher } from "@dimosi/core";

export interface ProblemTimings {
  /** How long to wait for the first report about a file whose language is known to report. */
  firstMs: number;
  /** ...and for a language that has not reported anything yet. */
  unknownMs: number;
  /** After a report, how long to wait for the next one: syntax comes first, meaning later. */
  quietMs: number;
  /** Never wait longer than this. */
  totalMs: number;
}

const DEFAULTS: ProblemTimings = { firstMs: 4000, unknownMs: 1000, quietMs: 300, totalMs: 8000 };
/** After this many changes without a report, a language is not waited for any more. */
const SILENT_AFTER = 2;

function sourceOf(d: vscode.Diagnostic): string | undefined {
  const code = typeof d.code === "object" && d.code !== null ? d.code.value : d.code;
  return [d.source, code].filter((p) => p !== undefined && p !== "").join(" ") || undefined;
}

/**
 * The errors VS Code shows for a file after the agent changed it (the red
 * squiggles). They come from language services a moment after the change, so
 * `watch` listens from before the write and waits for the reports to settle.
 * Languages without a service (plain text, Markdown) never report: after a
 * couple of changes they are no longer waited for, until they do report.
 */
export class EditorProblems implements vscode.Disposable {
  private timings: ProblemTimings;
  /** Languages that have reported on some file in this window. */
  private reporting = new Set<string>();
  /** Changes in a row that got no report, by language. */
  private silent = new Map<string, number>();
  private watchers = new Map<string, Set<() => void>>();
  private listener: vscode.Disposable;

  constructor(timings: Partial<ProblemTimings> = {}) {
    this.timings = { ...DEFAULTS, ...timings };
    this.listener = vscode.languages.onDidChangeDiagnostics((e) => {
      for (const uri of e.uris) {
        const key = uri.toString();
        const language = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key)?.languageId;
        if (language) {
          this.reporting.add(language);
          this.silent.delete(language);
        }
        for (const told of this.watchers.get(key) ?? []) told();
      }
    });
  }

  dispose(): void {
    this.listener.dispose();
    this.watchers.clear();
  }

  readonly watch: ProblemWatcher = (abs) => {
    const t = this.timings;
    const uri = vscode.Uri.file(abs);
    const key = uri.toString();
    let reports = 0;
    let lastReport = 0;
    let wake: (() => void) | undefined;
    const told = () => {
      reports++;
      lastReport = Date.now();
      wake?.();
    };
    const all = this.watchers.get(key) ?? new Set();
    this.watchers.set(key, all.add(told));
    const stop = () => {
      all.delete(told);
      if (!all.size) this.watchers.delete(key);
    };

    /** Until the time is up, a report arrives or the user presses Stop. */
    const sleep = (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          wake = undefined;
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener("abort", done, { once: true });
        wake = done;
      });

    return {
      cancel: stop,
      after: async (signal) => {
        try {
          // Language services only check files that are open as documents (a tab is not needed).
          const language = (await vscode.workspace.openTextDocument(uri)).languageId;
          const started = Date.now();
          const first = this.reporting.has(language) ? t.firstMs : (this.silent.get(language) ?? 0) >= SILENT_AFTER ? 0 : t.unknownMs;
          while (!signal?.aborted) {
            const now = Date.now();
            const left = reports ? Math.min(lastReport + t.quietMs, started + t.totalMs) - now : started + first - now;
            if (left <= 0) break;
            await sleep(left, signal);
          }
          if (!reports && !signal?.aborted) this.silent.set(language, (this.silent.get(language) ?? 0) + 1);
          return vscode.languages
            .getDiagnostics(uri)
            .filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
            .map((d): FileProblem => ({ line: d.range.start.line + 1, message: d.message, source: sourceOf(d) }));
        } finally {
          stop();
        }
      },
    };
  };
}
