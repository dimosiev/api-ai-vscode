// A small stand-in for the "vscode" module, so the extension's code runs
// under vitest (wired up as an alias in vitest.config.mts). It models only
// what dimosi uses. Tests steer it through `stub`.
import { promises as fs, writeFileSync } from "node:fs";
import * as nodePath from "node:path";

type Listener<T> = (e: T) => unknown;
const disposable = () => ({ dispose() {} });

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
    readonly query = "",
  ) {}
  static file(p: string): Uri {
    return new Uri("file", nodePath.resolve(p));
  }
  static parse(s: string): Uri {
    if (s.startsWith("file://")) return Uri.file(decodeURIComponent(s.slice(7)));
    const m = /^([a-z][\w+.-]*):(.*)$/i.exec(s);
    if (!m) throw new Error(`bad uri ${s}`);
    return new Uri(m[1], m[2]);
  }
  static from(c: { scheme: string; path: string; query?: string }): Uri {
    return new Uri(c.scheme, c.path, c.query ?? "");
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, nodePath.join(base.path, ...parts));
  }
  get fsPath(): string {
    return this.path;
  }
  toString(): string {
    return `${this.scheme}://${this.path}${this.query ? `?${this.query}` : ""}`;
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
}

export class Selection extends Range {
  constructor(al: number, ac: number, bl: number, bc: number) {
    super(new Position(al, ac), new Position(bl, bc));
  }
  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

export class WorkspaceEdit {
  readonly ops: Array<{ uri: Uri; range: Range; text: string }> = [];
  replace(uri: Uri, range: Range, text: string): void {
    this.ops.push({ uri, range, text });
  }
}

export class EventEmitter<T> {
  private listeners = new Set<Listener<T>>();
  readonly event = (l: Listener<T>) => {
    this.listeners.add(l);
    return { dispose: () => this.listeners.delete(l) };
  };
  get count(): number {
    return this.listeners.size;
  }
  fire(e?: T): void {
    for (const l of this.listeners) l(e as T);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

/** An editor tab's document: text that may differ from the disk, plus an undo history. */
export class TextDocument {
  isClosed = false;
  /** Enough for tests: the file's extension. */
  get languageId(): string {
    return nodePath.extname(this.uri.fsPath).slice(1) || "plaintext";
  }
  isDirty = false;
  encoding = "utf8";
  private undoStack: string[] = [];

  constructor(
    readonly uri: Uri,
    private text: string,
  ) {}

  getText(): string {
    return this.text;
  }
  positionAt(offset: number): Position {
    const before = this.text.slice(0, offset);
    const line = before.split("\n").length - 1;
    return new Position(line, offset - (before.lastIndexOf("\n") + 1));
  }
  offsetAt(p: Position): number {
    const lines = this.text.split("\n");
    let offset = 0;
    for (let i = 0; i < p.line; i++) offset += lines[i].length + 1;
    return offset + p.character;
  }
  /** The user types without saving. */
  type(text: string): void {
    this.undoStack.push(this.text);
    this.text = text;
    this.isDirty = true;
  }
  /** Ctrl+Z. */
  undo(): void {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.text = prev;
    this.isDirty = true;
  }
  replace(range: Range, text: string): void {
    this.undoStack.push(this.text);
    this.text = this.text.slice(0, this.offsetAt(range.start)) + text + this.text.slice(this.offsetAt(range.end));
    this.isDirty = true;
    recheck(this.uri);
  }
  async save(): Promise<boolean> {
    writeFileSync(this.uri.fsPath, this.text);
    this.isDirty = false;
    return true;
  }
}

export class TabInputText {
  constructor(readonly uri: Uri) {}
}

export interface Tab {
  input: unknown;
  isActive: boolean;
  isPreview: boolean;
  isDirty: boolean;
}

const tabOf = (uri: Uri) => window.tabGroups.all[0].tabs.find((t) => t.input instanceof TabInputText && t.input.uri.toString() === uri.toString());

/**
 * The language service of `stub.check`, behaving as measured in VS Code 1.140
 * (test/real): it looks at a file only while it is a loaded document that
 * has a tab, answers a moment after the file changes, and says nothing when
 * its findings stay the same.
 */
function recheck(uri: Uri): void {
  setTimeout(() => {
    const doc = workspace.textDocuments.find((d) => !d.isClosed && d.uri.toString() === uri.toString());
    if (!stub.check || !doc || !tabOf(uri)) return;
    const found = stub.check(doc);
    if (JSON.stringify(found) !== JSON.stringify(stub.diagnostics.get(uri.toString()) ?? [])) stub.report(uri, found);
  }, stub.checkDelayMs);
}

/** "vscode.open": a preview tab replaces the previous preview tab; in the background it does not come to the front. */
function openTab(uri: Uri, options: { background?: boolean; preview?: boolean } = {}): void {
  const tabs = window.tabGroups.all[0].tabs;
  if (tabOf(uri)) return;
  const front = !options.background || !tabs.some((t) => t.isActive);
  if (options.preview) {
    const old = tabs.findIndex((t) => t.isPreview);
    if (old >= 0) closeTab(tabs[old]);
  }
  if (front) for (const t of tabs) t.isActive = false;
  tabs.push({ input: new TabInputText(uri), isActive: front || !tabs.some((t) => t.isActive), isPreview: Boolean(options.preview), isDirty: false });
  recheck(uri);
}

function closeTab(tab: Tab): void {
  const tabs = window.tabGroups.all[0].tabs;
  const at = tabs.indexOf(tab);
  if (at < 0) return;
  tabs.splice(at, 1);
  if (tab.isActive && tabs.length) tabs[tabs.length - 1].isActive = true;
  // A file without a tab is not checked any more: its errors go away.
  if (tab.input instanceof TabInputText && stub.diagnostics.get(tab.input.uri.toString())?.length) stub.report(tab.input.uri, []);
}

export interface Diagnostic {
  range: Range;
  message: string;
  severity: DiagnosticSeverity;
  source?: string;
  code?: string | number | { value: string | number };
}

const diagnosticsChanged = new EventEmitter<{ uris: Uri[] }>();

/** Test controls. */
export const stub = {
  config: {} as Record<string, unknown>,
  /** Answers modal and non-modal message boxes; undefined = dismissed. */
  answer: (_message: string, _items: string[]): string | undefined => undefined,
  /** What the editor shows for each file (by `uri.toString()`). */
  diagnostics: new Map<string, Diagnostic[]>(),
  /** A language service reports on a file: the list is replaced and listeners are told. */
  report(uri: Uri, list: Diagnostic[]): void {
    this.diagnostics.set(uri.toString(), list);
    diagnosticsChanged.fire({ uris: [uri] });
  },
  /** How many parts of the extension are listening for reports right now. */
  get diagnosticListeners(): number {
    return diagnosticsChanged.count;
  },
  /** A language service: what it finds in a document (see `recheck`). */
  check: undefined as ((doc: TextDocument) => Diagnostic[]) | undefined,
  /** How long the language service thinks. */
  checkDelayMs: 5,
  /** The user opens a file in a tab and looks at it; `preview` is a single click in the Explorer (the name in italics). */
  async showFile(uri: Uri, options: { preview?: boolean } = {}): Promise<TextDocument> {
    const doc = await workspace.openTextDocument(uri);
    openTab(uri, options);
    return doc;
  },
  /** Tabs as "name", "name*" (in front), "name(p)" (preview). */
  get tabs(): string[] {
    return window.tabGroups.all[0].tabs.map((t) => `${t.input instanceof TabInputText ? nodePath.basename(t.input.uri.fsPath) : "?"}${t.isActive ? "*" : ""}${t.isPreview ? "(p)" : ""}`);
  },
  /** What the user picks in a quick pick list. */
  pick: (_items: Array<{ label: string }>): { label: string } | undefined => undefined,
  /** What the user chooses in an "open" dialog. */
  openDialog: (): Uri[] | undefined => undefined,
  messages: [] as string[],
  /** Options ({ modal, detail }) passed with each message box, in order. */
  messageOptions: [] as Array<Record<string, unknown> | undefined>,
  /** Paths opened with window.showTextDocument. */
  opened: [] as string[],
  executed: [] as Array<{ id: string; args: unknown[] }>,
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  /** Lines written to output channels. */
  output: [] as string[],
  reset(): void {
    this.output = [];
    this.config = {};
    this.answer = () => undefined;
    this.pick = () => undefined;
    this.diagnostics.clear();
    this.check = undefined;
    this.checkDelayMs = 5;
    window.tabGroups.all[0].tabs = [];
    diagnosticsChanged.dispose();
    this.openDialog = () => undefined;
    this.messages = [];
    this.messageOptions = [];
    this.opened = [];
    this.executed = [];
    workspace.textDocuments = [];
    workspace.workspaceFolders = undefined;
  },
};

const message = async (text: string, ...rest: unknown[]) => {
  stub.messages.push(text);
  stub.messageOptions.push(rest.find((r): r is Record<string, unknown> => typeof r === "object" && r !== null));
  const items = rest.filter((r): r is string => typeof r === "string");
  return stub.answer(text, items);
};

export const workspace = {
  textDocuments: [] as TextDocument[],
  workspaceFolders: undefined as Array<{ uri: Uri; name: string; index: number }> | undefined,
  async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    for (const op of edit.ops) {
      const doc = this.textDocuments.find((d) => d.uri.toString() === op.uri.toString());
      if (!doc) return false;
      doc.replace(op.range, op.text);
    }
    return true;
  },
  getConfiguration(section: string) {
    return {
      get: <T>(key: string, fallback?: T): T => (stub.config[`${section}.${key}`] as T) ?? (fallback as T),
      update: async (key: string, value: unknown) => {
        stub.config[`${section}.${key}`] = value;
      },
    };
  },
  /** Loads a file as a document without showing it, like VS Code does. */
  async openTextDocument(uri: Uri): Promise<TextDocument> {
    const open = this.textDocuments.find((d) => !d.isClosed && d.uri.toString() === uri.toString());
    if (open) return open;
    const doc = new TextDocument(uri, await fs.readFile(uri.fsPath, "utf8"));
    this.textDocuments.push(doc);
    recheck(uri);
    return doc;
  },
  onDidChangeConfiguration: () => disposable(),
  onDidChangeWorkspaceFolders: () => disposable(),
  registerTextDocumentContentProvider: () => disposable(),
  findFiles: async () => [] as Uri[],
  fs: {
    stat: async (uri: Uri) => ({ type: (await fs.stat(uri.fsPath)).isDirectory() ? FileType.Directory : FileType.File }),
    readFile: async (uri: Uri) => new Uint8Array(await fs.readFile(uri.fsPath)),
    writeFile: async (uri: Uri, data: Uint8Array) => fs.writeFile(uri.fsPath, data),
  },
};

export const window = {
  activeTextEditor: undefined as unknown,
  onDidChangeActiveTextEditor: () => disposable(),
  showInformationMessage: message,
  showWarningMessage: message,
  showErrorMessage: message,
  showTextDocument: async (doc: Uri | { uri: Uri }) => {
    stub.opened.push((doc instanceof Uri ? doc : doc.uri).fsPath);
    return undefined;
  },
  showOpenDialog: async () => stub.openDialog(),
  showSaveDialog: async () => undefined,
  showQuickPick: async (items: Array<{ label: string }>) => stub.pick(items),
  showInputBox: async () => undefined,
  registerWebviewViewProvider: () => disposable(),
  createOutputChannel: (_name: string, _opts?: { log: true }) => {
    const write = (level: string) => (message: string) => void stub.output.push(`[${level}] ${message}`);
    return { info: write("info"), warn: write("warn"), error: write("error"), dispose() {} };
  },
  tabGroups: {
    all: [{ tabs: [] as Tab[] }],
    close: async (tab: Tab | Tab[]) => {
      for (const t of Array.isArray(tab) ? tab : [tab]) closeTab(t);
      return true;
    },
  },
};

export const commands = {
  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    stub.executed.push({ id, args });
    if (id === "vscode.open") return openTab(args[0] as Uri, args[1] as { background?: boolean; preview?: boolean });
    return stub.commands.get(id)?.(...args);
  },
  registerCommand(id: string, fn: (...args: unknown[]) => unknown) {
    stub.commands.set(id, fn);
    return { dispose: () => stub.commands.delete(id) };
  },
};

export const languages = {
  registerCodeActionsProvider: () => disposable(),
  getDiagnostics: (uri: Uri) => stub.diagnostics.get(uri.toString()) ?? [],
  onDidChangeDiagnostics: diagnosticsChanged.event,
};
export const env = { appName: "Visual Studio Code", appRoot: "/nonexistent/vscode/app", clipboard: { text: "", async writeText(t: string) { this.text = t; } } };
export const version = "1.140.0";

export enum FileType {
  File = 1,
  Directory = 2,
}
export enum ConfigurationTarget {
  Global = 1,
}
export enum ProgressLocation {
  Notification = 15,
}
export enum QuickPickItemKind {
  Separator = -1,
}
export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
}
export class CodeActionKind {
  static QuickFix = new CodeActionKind();
}
export class CodeAction {
  constructor(readonly title: string) {}
}
export class TabInputTextDiff {}
