import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  Agent,
  DEFAULT_CONTEXT_WINDOW,
  describeToolCall,
  formatCost,
  formatTokens,
  getPreset,
  isSecretFile,
  UsageTotals,
  type ImagePart,
  type Message,
  type Pricing,
  type TextPart,
} from "@dimosi/core";
import { errorText } from "./errorText";
import { WebviewApproval } from "./approval";
import { fileAttachment, imageAttachment, isSecretPath, type Attachment } from "./attachments";
import { ChangeTracker } from "./changes";
import { editorFiles } from "./editorFiles";
import { log } from "./log";
import { vscodeRuleTrust } from "./ruleTrust";
import {
  CHAT_FORMAT,
  deleteChatFile,
  readChatFile,
  restoredTranscript,
  serializeChat,
  Transcript,
  writeChatFile,
  type SavedChat,
} from "./chatStore";
import type { SecretKeyStore } from "./keyStore";
import type { FromWebview, ToWebview } from "./protocol";
import { buildProvider, MissingKeyError, readSettings } from "./settings";

const CONTEXT_WARNING_TOKENS = 150_000;
const EXCLUDE_GLOB = "**/{node_modules,.git,dist,out,build,.next,.venv,venv,__pycache__}/**";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "dimosi.chat";

  readonly approval: WebviewApproval;
  private view?: vscode.WebviewView;
  private ready?: Promise<void>;
  private markReady?: () => void;
  private agent?: Agent;
  private controller?: AbortController;
  private attachments: Attachment[] = [];
  private trackers = new Map<number, ChangeTracker>();
  private turn = 0;
  private chatUsage = new UsageTotals();
  private fileCache?: { at: number; files: string[] };
  private starting = false;
  /** What the panel shows, so it can be redrawn after a reload or when the view is recreated. */
  private transcript = new Transcript();
  /** History of a restored chat, handed to the agent when it is created. */
  private restoredMessages?: Message[];
  private loaded = false;
  /** Saves run one after another, so an older snapshot never overwrites a newer one. */
  private saving: Promise<void> = Promise.resolve();
  /** Bumped by "New chat": events of the stopped task no longer belong to the panel. */
  private generation = 0;

  constructor(
    private context: vscode.ExtensionContext,
    private keys: SecretKeyStore,
    approval: (ui: ChatViewProvider) => WebviewApproval,
  ) {
    this.approval = approval(this);
    this.resetReady();
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.postActiveFile()),
    );
  }

  // ---------- view lifecycle ----------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((msg: FromWebview) => {
      this.onMessage(msg).catch((e) => {
        log.error(`panel action ${msg.type} failed: ${errorText(e)}`);
        this.post({ type: "error", message: errorText(e) });
      });
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.approval.cancelAll();
      this.controller?.abort();
      this.resetReady();
    });
  }

  private resetReady(): void {
    this.ready = new Promise((resolve) => (this.markReady = resolve));
  }

  post(msg: ToWebview): void {
    this.transcript.add(msg);
    void this.view?.webview.postMessage(msg);
  }

  reveal(): void {
    if (this.view) this.view.show(true);
    else void vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  /** Opens the panel and waits until the webview script is running. */
  async show(): Promise<void> {
    if (!this.view?.visible) await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    await this.ready;
  }

  get busy(): boolean {
    return this.controller !== undefined || this.starting;
  }

  private root(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.scheme === "file" ? folder.uri.fsPath : undefined;
  }

  // ---------- public actions ----------

  newChat(): void {
    this.generation++;
    this.controller?.abort();
    this.approval.cancelAll();
    this.agent?.reset();
    this.restoredMessages = undefined;
    this.transcript.clear();
    this.trackers.clear();
    const file = this.chatFile();
    if (file) this.saving = this.saving.then(() => deleteChatFile(file)).catch(() => undefined);
    this.chatUsage = new UsageTotals();
    this.attachments = [];
    this.post({ type: "clear" });
    this.postAttachments();
    void this.postStatus();
  }

  async postStatus(): Promise<void> {
    const s = readSettings();
    const preset = getPreset(s.provider);
    const hasKey = !preset.requiresKey || Boolean(await this.keys.get(s.provider));
    this.post({
      type: "status",
      provider: preset.label,
      model: s.model || "модель не выбрана",
      approval: s.approvalMode,
      needsSetup: !hasKey || !s.model,
      hasFolder: Boolean(this.root()),
    });
  }

  addAttachment(att: Attachment): void {
    if (!this.attachments.some((a) => a.key === att.key)) this.attachments.push(att);
    this.postAttachments();
  }

  /** Sends a task from outside the panel (editor actions, rules generation). */
  async sendTask(text: string, extra: Attachment[] = []): Promise<void> {
    await this.show();
    if (this.busy) {
      void vscode.window.showWarningMessage("dimosi ещё работает над предыдущей задачей. Дождитесь окончания или нажмите «Стоп».");
      return;
    }
    for (const att of extra) this.addAttachment(att);
    await this.send(text);
  }

  // ---------- messages from the webview ----------

  private async onMessage(msg: FromWebview): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.loadSavedChat();
        if (this.transcript.items.length) this.post({ type: "restore", items: this.transcript.items });
        if (this.busy) this.post({ type: "busy", busy: true });
        this.markReady?.();
        await this.postStatus();
        this.postAttachments();
        this.postActiveFile();
        break;
      case "send":
        await this.send(msg.text);
        break;
      case "stop":
        this.controller?.abort();
        break;
      case "command":
        // Only our own commands, plus "open folder" from the setup hint.
        if (msg.command.startsWith("dimosi.") || msg.command === "workbench.action.files.openFolder") {
          await vscode.commands.executeCommand(msg.command, ...(msg.args ?? []));
        }
        break;
      case "approval_response":
        this.approval.respond(msg.id, msg.decision);
        break;
      case "open_diff":
        await this.approval.openDiff(msg.id);
        break;
      case "open_file": {
        const root = this.root();
        if (root) await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, msg.relPath)), { preview: true });
        break;
      }
      case "open_path":
        await vscode.window.showTextDocument(vscode.Uri.file(msg.path), { preview: true });
        break;
      case "revert":
        await this.revert(msg.turn, msg.relPath);
        break;
      case "pick_files": {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
          title: "Прикрепить файлы к сообщению",
        });
        for (const uri of uris ?? []) await this.attachUri(uri);
        break;
      }
      case "attach_active_file": {
        const editor = vscode.window.activeTextEditor;
        if (editor) await this.attachUri(editor.document.uri);
        break;
      }
      case "attach_path": {
        const root = this.root();
        if (root) await this.attachUri(vscode.Uri.file(path.join(root, msg.relPath)));
        break;
      }
      case "attach_uris":
        for (const raw of msg.uris) {
          try {
            await this.attachUri(vscode.Uri.parse(raw, true));
          } catch {
            this.post({ type: "error", message: `Не удалось прикрепить: ${raw}` });
          }
        }
        break;
      case "attach_data":
        try {
          this.addAttachment(imageAttachment(msg.name, msg.mediaType, msg.data));
        } catch (e) {
          this.post({ type: "error", message: errorText(e) });
        }
        break;
      case "remove_attachment":
        this.attachments = this.attachments.filter((a) => a.id !== msg.id);
        this.postAttachments();
        break;
      case "mention_query":
        this.post({ type: "mentions", query: msg.query, items: await this.findFiles(msg.query) });
        break;
    }
  }

  private async attachUri(uri: vscode.Uri): Promise<void> {
    try {
      this.addAttachment(await fileAttachment(uri, this.root()));
    } catch (e) {
      this.post({ type: "error", message: errorText(e) });
    }
  }

  private postAttachments(): void {
    this.post({ type: "attachments", chips: this.attachments.map(({ id, label, kind }) => ({ id, label, kind })) });
  }

  private postActiveFile(): void {
    const editor = vscode.window.activeTextEditor;
    const root = this.root();
    // Files with keys are not offered: attaching them is refused anyway.
    if (!editor || editor.document.uri.scheme !== "file" || isSecretPath(editor.document.uri.fsPath)) {
      this.post({ type: "active_file", label: null });
      return;
    }
    const p = editor.document.uri.fsPath;
    const label = root && p.startsWith(root + path.sep) ? path.relative(root, p).split(path.sep).join("/") : path.basename(p);
    this.post({ type: "active_file", label });
  }

  private async findFiles(query: string): Promise<string[]> {
    const root = this.root();
    if (!root) return [];
    if (!this.fileCache || Date.now() - this.fileCache.at > 30_000) {
      const uris = await vscode.workspace.findFiles("**/*", EXCLUDE_GLOB, 5000);
      this.fileCache = {
        at: Date.now(),
        files: uris.filter((u) => !isSecretFile(u.fsPath)).map((u) => path.relative(root, u.fsPath).split(path.sep).join("/")).sort(),
      };
    }
    const q = query.toLowerCase();
    const scored = this.fileCache.files
      .map((f) => {
        const lower = f.toLowerCase();
        const base = lower.slice(lower.lastIndexOf("/") + 1);
        const score = !q ? 1 : base.startsWith(q) ? 3 : base.includes(q) ? 2 : lower.includes(q) ? 1 : 0;
        return { f, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.f.length - b.f.length);
    return scored.slice(0, 50).map((x) => x.f);
  }

  // ---------- running the agent ----------

  private async send(text: string): Promise<void> {
    text = text.trim();
    if (this.busy || (!text && !this.attachments.length)) return;
    // Set before the first await, so a second click can't start a parallel run.
    this.starting = true;
    try {
      await this.start(text);
    } finally {
      this.starting = false;
    }
  }

  private async start(text: string): Promise<void> {
    const root = this.root();
    if (!root) {
      this.post({
        type: "error",
        message: "Откройте папку проекта: меню File → Open Folder… (Файл → Открыть папку).",
        action: { label: "Открыть папку", command: "workbench.action.files.openFolder" },
      });
      return;
    }

    const settings = readSettings();
    let provider;
    try {
      if (!settings.model) throw new Error("Не выбрана модель.");
      provider = await buildProvider(settings, this.keys);
    } catch (e) {
      log.warn(`cannot start a task: ${errorText(e)}`);
      this.post({
        type: "error",
        message: errorText(e),
        action: e instanceof MissingKeyError
          ? { label: "Ввести ключ", command: "dimosi.setApiKey" }
          : { label: "Выбрать модель", command: "dimosi.selectModel" },
      });
      return;
    }

    // Keep the conversation unless the folder changed.
    if (!this.agent || this.agent.root !== root) {
      this.agent = new Agent({
        provider,
        model: settings.model,
        root,
        approval: this.approval,
        files: editorFiles,
        log,
        ruleTrust: vscodeRuleTrust(this.context),
      });
      if (this.restoredMessages) this.agent.restore(this.restoredMessages);
      this.restoredMessages = undefined;
    }
    const agent = this.agent;
    agent.provider = provider;
    agent.model = settings.model;
    agent.maxSteps = settings.maxSteps;
    agent.sandbox = settings.sandbox;
    agent.contextWindow = getPreset(settings.provider).contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    agent.gate.mode = settings.approvalMode;

    const attachments = this.attachments;
    this.attachments = [];
    this.postAttachments();
    const parts: Array<TextPart | ImagePart> = [
      ...attachments.flatMap((a) => a.parts),
      { type: "text", text: text || "Посмотри вложения." },
    ];

    const turn = ++this.turn;
    const tracker = new ChangeTracker(editorFiles);
    this.trackers.set(turn, tracker);
    const usage = new UsageTotals();
    // The price list may load slowly; never make the agent wait for it.
    let price: Pricing | undefined;
    const postUsage = () => {
      if (!usage.totalInput && !usage.output) return;
      this.post({
        type: "usage",
        tokens: `${formatTokens(usage.totalInput)} → ${formatTokens(usage.output)}`,
        cost: formatCost(usage.cost(price)),
        chatCost: formatCost(this.chatUsage.cost(price)),
        context: formatTokens(usage.lastContext),
        contextWarning: usage.lastContext > CONTEXT_WARNING_TOKENS,
      });
    };
    void (provider.getPricing?.(settings.model) ?? Promise.resolve(undefined)).then(
      (p) => {
        price = p;
        if (p) postUsage();
      },
      () => undefined,
    );

    this.post({ type: "user", text, chips: attachments.map(({ id, label, kind }) => ({ id, label, kind })) });
    this.post({ type: "busy", busy: true });
    this.post({ type: "activity", text: "Думает…" });
    this.controller = new AbortController();
    this.approval.signal = this.controller.signal;
    let toolId = 0;
    const ids = new Map<string, number>();
    const generation = this.generation;
    const running = { turn, tracker };
    try {
      for await (const ev of agent.run(parts, this.controller.signal)) {
        if (generation !== this.generation) break; // "New chat" was pressed
        switch (ev.type) {
          case "rules":
            this.post({
              type: "rules",
              rules: ev.sources.map((r) => ({ label: r.label, path: r.path, scope: r.scope, truncated: r.truncated, skipped: r.skipped })),
            });
            break;
          case "text":
            this.post({ type: "text", text: ev.text });
            this.post({ type: "activity", text: "Пишет ответ…" });
            break;
          case "tool_start":
            ids.set(ev.call.id, ++toolId);
            this.post({ type: "tool_start", id: toolId, title: describeToolCall(ev.call), name: ev.call.name });
            this.post({ type: "activity", text: `${describeToolCall(ev.call)}…` });
            break;
          case "tool_end":
            this.post({ type: "tool_end", id: ids.get(ev.call.id) ?? 0, result: ev.result.slice(0, 4000), isError: ev.isError });
            this.post({ type: "activity", text: "Думает…" });
            this.saveChat(running);
            break;
          case "plan":
            this.post({ type: "plan", items: ev.items });
            break;
          case "file_changed":
            tracker.record(ev.change);
            break;
          case "usage":
            usage.add(ev.usage);
            this.chatUsage.add(ev.usage);
            postUsage();
            break;
          case "error":
            this.post({ type: "error", message: ev.message });
            break;
          case "done":
            break;
        }
      }
    } catch (e) {
      log.error(`task crashed: ${errorText(e)}`);
      this.post({ type: "error", message: errorText(e) });
    } finally {
      this.controller = undefined;
      this.approval.signal = undefined;
      this.approval.cancelAll();
      const current = generation === this.generation;
      if (current && !tracker.isEmpty) this.post({ type: "changes", turn, files: tracker.summary() });
      this.post({ type: "busy", busy: false });
      if (current) this.saveChat();
    }
  }

  // ---------- saved chat ----------

  private chatFile(): string | undefined {
    const dir = this.context.storageUri;
    return dir?.scheme === "file" ? path.join(dir.fsPath, "chat.json") : undefined;
  }

  /** Restores the folder's last chat once per window; a bad file just means a new chat. */
  private async loadSavedChat(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const file = this.chatFile();
    const root = this.root();
    if (!file || !root || this.agent || this.transcript.items.length) return;
    const saved = await readChatFile(file, root);
    if (!saved) {
      if (existsSync(file)) log.warn("the saved chat is damaged or from another version; starting a new chat");
      return;
    }
    log.info(`chat restored: ${saved.messages.length} messages, ${saved.trackers.length} revert cards${saved.interrupted ? ", interrupted mid-task" : ""}`);
    this.turn = Math.max(this.turn, saved.turn);
    for (const t of saved.trackers) this.trackers.set(t.turn, ChangeTracker.fromJSON(t, editorFiles));
    this.restoredMessages = saved.messages;
    this.transcript.items = restoredTranscript(saved, this.trackers);
  }

  /** Snapshots the chat now and writes it in the background. `running` is set mid-task. */
  private saveChat(running?: { turn: number; tracker: ChangeTracker }): void {
    const file = this.chatFile();
    const root = this.root();
    if (!file || !root) return;
    const chat: SavedChat = {
      format: CHAT_FORMAT,
      root,
      turn: this.turn,
      messages: this.agent?.messages ?? this.restoredMessages ?? [],
      transcript: this.transcript.snapshot(running),
      trackers: [...this.trackers.entries()].filter(([, t]) => !t.isEmpty).map(([turn, t]) => ({ turn, ...t.toJSON() })),
      interrupted: Boolean(running),
    };
    // Serialized right away: the history keeps changing while the file is written.
    const { text, dropped } = serializeChat(chat);
    if (dropped.length) log.warn(`chat is over the size limit; left out of the saved copy: ${dropped.join(", ")}`);
    this.saving = this.saving
      .then(() => (text ? writeChatFile(file, text) : deleteChatFile(file)))
      .catch((e) => log.warn(`could not save the chat: ${errorText(e)}`));
  }

  private async revert(turn: number, relPath: string | null): Promise<void> {
    const tracker = this.trackers.get(turn);
    if (!tracker) return;
    const targets = relPath ? [relPath] : tracker.revertible();
    if (!relPath) {
      const ok = await vscode.window.showWarningMessage(
        `Откатить все изменения агента в этой задаче (${targets.length} файл.)?`,
        { modal: true },
        "Откатить",
      );
      if (!ok) return;
    }
    for (const rel of targets) {
      let result = await tracker.revert(rel);
      if (!result.ok && result.reason === "modified_since") {
        const force = await vscode.window.showWarningMessage(
          `Файл ${rel} изменили уже после агента. Всё равно вернуть версию до агента? Ваши последующие правки в нём пропадут.`,
          { modal: true },
          "Вернуть",
        );
        if (force) result = await tracker.revert(rel, true);
        else continue;
      }
      if (!result.ok) {
        log.warn(`revert of ${rel} failed: ${result.message}`);
        this.post({ type: "error", message: `Не удалось откатить ${rel}: ${result.message}` });
      }
    }
    this.post({ type: "changes", turn, files: tracker.summary() });
    this.saveChat();
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css"));
    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>dimosi</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
