import * as vscode from "vscode";
import type { FileProblem, ProblemWatcher } from "@dimosi/core";

export interface ProblemTimings {
  /** Wait for a language known to report, before its usual delay has been seen. */
  knownMs: number;
  /** Wait for a language that has not reported anything yet. */
  unknownMs: number;
  /** After a report, how long to wait for the next one. */
  quietMs: number;
  /** The shortest and the longest wait for the first report. */
  minMs: number;
  maxMs: number;
}

// Measured in VS Code 1.140 (test/real): JSON and CSS report in about 0.1 s,
// TypeScript in about 0.45 s. A file that stays free of errors gets no report
// at all, so the wait for the first one has to end by time.
const DEFAULTS: ProblemTimings = { knownMs: 1500, unknownMs: 1000, quietMs: 250, minMs: 400, maxMs: 4000 };
/** After this many changes without a report, an unknown language is not waited for any more. */
const SILENT_AFTER = 2;
/** Checked by VS Code itself, without extra extensions. */
const BUILT_IN = ["typescript", "typescriptreact", "javascript", "javascriptreact", "json", "jsonc", "css", "scss", "less", "html"];

function sourceOf(d: vscode.Diagnostic): string | undefined {
  const code = typeof d.code === "object" && d.code !== null ? d.code.value : d.code;
  return [d.source, code].filter((p) => p !== undefined && p !== "").join(" ") || undefined;
}

function tabOf(uri: vscode.Uri): vscode.Tab | undefined {
  const key = uri.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key) return tab;
    }
  }
  return undefined;
}

/**
 * The errors VS Code shows for a file after the agent changed it (the red
 * squiggles). VS Code checks only files that are open in a tab, a moment
 * after the change: `watch` listens from before the write, puts the file in
 * a background tab if it has none (and closes that tab afterwards), and
 * waits for the report. How long depends on the language: one that has
 * reported before is given about twice its usual delay; one that never
 * reports (plain text, Markdown) is not waited for after a couple of changes.
 */
export class EditorProblems implements vscode.Disposable {
  private timings: ProblemTimings;
  /** Languages that report errors in this window. */
  private reporting = new Set(BUILT_IN);
  /** The slowest recent first report, by language. */
  private delay = new Map<string, number>();
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

  /** How long to wait for the first report about a file in this language. */
  private firstWait(language: string): number {
    const t = this.timings;
    if (!this.reporting.has(language)) return (this.silent.get(language) ?? 0) >= SILENT_AFTER ? 0 : t.unknownMs;
    const usual = this.delay.get(language);
    return usual === undefined ? t.knownMs : Math.min(t.maxMs, Math.max(t.minMs, usual * 2 + 200));
  }

  readonly watch: ProblemWatcher = (abs) => {
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
        let ownTab = false;
        try {
          const language = (await vscode.workspace.openTextDocument(uri)).languageId;
          const first = this.firstWait(language);
          if (first > 0 && !tabOf(uri)) {
            // In the background: the user's own tab stays in front and keeps the keyboard.
            await vscode.commands.executeCommand("vscode.open", uri, { background: true, preview: true, preserveFocus: true });
            ownTab = true;
          }
          const started = Date.now();
          let firstReport: number | undefined;
          while (!signal?.aborted) {
            if (reports) firstReport ??= lastReport;
            const now = Date.now();
            const left = reports ? lastReport + this.timings.quietMs - now : started + first - now;
            if (left <= 0) break;
            await sleep(left, signal);
          }
          if (firstReport !== undefined) {
            // The slowest recent report counts; older ones fade.
            this.delay.set(language, Math.max(firstReport - started, (this.delay.get(language) ?? 0) * 0.8));
          } else if (!signal?.aborted && !this.reporting.has(language)) {
            this.silent.set(language, (this.silent.get(language) ?? 0) + 1);
          }
          return vscode.languages
            .getDiagnostics(uri)
            .filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
            .map((d): FileProblem => ({ line: d.range.start.line + 1, message: d.message, source: sourceOf(d) }));
        } finally {
          stop();
          // A tab opened only for the check is closed again, unless it ended up in front.
          const tab = ownTab ? tabOf(uri) : undefined;
          if (tab && !tab.isActive && !tab.isDirty) await vscode.window.tabGroups.close(tab, true).then(undefined, () => undefined);
        }
      },
    };
  };
}
