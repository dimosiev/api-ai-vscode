import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  Agent,
  createAccess,
  DEFAULT_CONTEXT_WINDOW,
  describeToolCall,
  formatCost,
  formatTokens,
  getPreset,
  isSecretFile,
  resolvePath,
  UsageTotals,
  type ImagePart,
  type Message,
  type Pricing,
  type TextPart,
} from "@dimosi/core";
import { errorText } from "./errorText";
import { accessStatus } from "./access";
import { WebviewApproval } from "./approval";
import { fileAttachment, imageAttachment, isSecretPath, type Attachment } from "./attachments";
import { ChangeTracker } from "./changes";
import { commandRuleStore } from "./commandRules";
import { editorFiles } from "./editorFiles";
import { log } from "./log";
import { EditorProblems } from "./problems";
import { vscodeRuleTrust } from "./ruleTrust";
import {
  archiveChat,
  CHAT_FORMAT,
  chatTitle,
  countTasks,
  deleteArchivedChat,
  deleteChatFile,
  listChats,
  readArchivedChat,
  readChatFile,
  restoredTranscript,
  serializeChat,
  Transcript,
  unarchiveChat,
  writeChatFile,
  type ChatInfo,
  type SavedChat,
} from "./chatStore";
import type { SecretKeyStore } from "./keyStore";
import type { FromWebview, ToWebview } from "./protocol";
import { isPicturePath, pictureDataUrl } from "./pictures";
import { buildImages, MissingKeyError, readSettings, rememberedProvider } from "./settings";

const CONTEXT_WARNING_TOKENS = 150_000;
/** Commands the panel's buttons run; the panel can ask for nothing else. */
const PANEL_COMMANDS = new Set([
  "dimosi.selectModel",
  "dimosi.toggleApproval",
  "dimosi.importKeys",
  "dimosi.showRules",
  "dimosi.setApiKey",
  "dimosi.editAccess",
  "dimosi.showCommandRules",
  "dimosi.togglePlanFirst",
  "dimosi.selectEffort",
  "workbench.action.files.openFolder",
]);
const DECISIONS = new Set<string>(["allow", "deny", "allow_always"]);

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
  /** "Plan first" for this window; off again after a reload. */
  private planFirst = false;
  /** One for the whole window: it learns which languages report errors. */
  private problems = new EditorProblems();
  /** What the panel shows, so it can be redrawn after a reload or when the view is recreated. */
  private transcript = new Transcript();
  /** History of a restored chat, handed to the agent when it is created. */
  private restoredMessages?: Message[];
  private loaded = false;
  /** Saves run one after another, so an older snapshot never overwrites a newer one. */
  private saving: Promise<void> = Promise.resolve();
  /** Bumped by "New chat": events of the stopped task no longer belong to the panel. */
  private generation = 0;
  /** The task in progress: its revert card is not in the transcript yet. */
  private running?: { turn: number; tracker: ChangeTracker };
  /** Another chat is being opened: no task may start until it is in place. */
  private switching = false;
  private provider = rememberedProvider();

  constructor(
    private context: vscode.ExtensionContext,
    private keys: SecretKeyStore,
    approval: (ui: ChatViewProvider) => WebviewApproval,
  ) {
    this.approval = approval(this);
    this.resetReady();
    context.subscriptions.push(
      this.problems,
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
    return this.controller !== undefined || this.starting || this.switching;
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
    void this.putAway().then((kept) => {
      if (!kept) void vscode.window.showWarningMessage("Не удалось сохранить прежний чат в прошлых чатах: с первым сообщением в новом чате он будет потерян. Причина — в журнале («Вывод → dimosi»).");
    });
    this.forget();
    this.attachments = [];
    this.post({ type: "clear" });
    this.postAttachments();
    void this.postStatus();
  }

  /** The chat in memory is gone; its file is dealt with by the caller. */
  private forget(): void {
    this.agent?.reset();
    this.restoredMessages = undefined;
    this.transcript.clear();
    this.trackers.clear();
    this.running = undefined;
    this.chatUsage = new UsageTotals();
  }

  /**
   * Moves the current chat to the earlier ones, as it is now. A chat where the
   * user wrote nothing is just deleted. `keep`: an earlier chat that must not
   * be pushed out by this one. False: the chat could not be moved and is still
   * the current file.
   */
  private putAway(keep?: string): Promise<boolean> {
    const file = this.chatFile();
    const dir = this.chatsDir();
    if (!file || !dir) return Promise.resolve(true);
    let work: () => Promise<unknown>;
    if (!this.loaded) {
      // The panel was not shown in this window yet: the saved chat is only on the disk.
      this.loaded = true;
      const root = this.root();
      work = async () => {
        const saved = root ? await readChatFile(file, root) : undefined;
        const tasks = saved ? countTasks(saved.transcript) : 0;
        if (!saved || !tasks) return deleteChatFile(file);
        return archiveChat(file, dir, { title: chatTitle(saved.transcript), savedAt: Date.now(), tasks }, { keep });
      };
    } else {
      const tasks = countTasks(this.transcript.items);
      if (!tasks) work = () => deleteChatFile(file);
      else {
        // A task stopped by this very action is kept with its revert card, and without the "window was reloaded" note.
        this.saveChat(this.running, false);
        const info = { title: chatTitle(this.transcript.items), savedAt: Date.now(), tasks };
        work = () => archiveChat(file, dir, info, { keep });
      }
    }
    const done = this.saving.then(work).then(
      () => true,
      (e) => (log.warn(`could not keep the chat: ${errorText(e)}`), false),
    );
    this.saving = done.then(() => undefined);
    return done;
  }

  /** The list of earlier chats: open one or delete it. */
  async showChats(): Promise<void> {
    const dir = this.chatsDir();
    const root = this.root();
    if (!dir || !root) return void vscode.window.showWarningMessage("Сначала откройте папку проекта: чаты хранятся отдельно для каждой папки.");
    // The command can come before the panel was ever shown: the saved chat must be known first.
    await this.loadSavedChat();
    await this.saving;
    const chats = await listChats(dir);
    if (!chats.length) return void vscode.window.showInformationMessage("Прошлых чатов пока нет. Чат попадает сюда, когда вы начинаете новый.");
    const picked = await vscode.window.showQuickPick(
      chats.map((chat) => ({ label: chat.title, description: chatSummary(chat), chat })),
      { title: "Прошлые чаты этой папки", placeHolder: "Выберите чат, чтобы открыть или удалить его", matchOnDescription: true },
    );
    if (!picked) return;
    const action = await vscode.window.showQuickPick([{ label: "Открыть" }, { label: "Удалить" }], { title: picked.chat.title });
    if (action?.label === "Открыть") await this.openChat(picked.chat);
    else if (action?.label === "Удалить") {
      const ok = await vscode.window.showWarningMessage(`Удалить чат «${picked.chat.title}»? Вернуть его будет нельзя.`, { modal: true }, "Удалить");
      if (!ok) return;
      // In the queue with the saves: they write the same list.
      const id = picked.chat.id;
      this.saving = this.saving.then(() => deleteArchivedChat(dir, id)).catch((e) => log.warn(`could not delete the chat: ${errorText(e)}`));
      await this.saving;
    }
  }

  private async openChat(chat: ChatInfo): Promise<void> {
    const file = this.chatFile();
    const dir = this.chatsDir();
    const root = this.root();
    if (!file || !dir || !root) return;
    if (this.busy) return void vscode.window.showWarningMessage("dimosi ещё работает над задачей. Дождитесь окончания или нажмите «Стоп», потом откройте другой чат.");
    this.switching = true;
    try {
      const saved = await readArchivedChat(dir, chat.id, root);
      if (!saved) return void vscode.window.showWarningMessage("Этот чат не удалось открыть: его файл повреждён или сохранён другой версией dimosi. Его можно удалить из списка.");
      this.generation++;
      this.approval.cancelAll();
      if (!(await this.putAway(chat.id))) {
        return void vscode.window.showWarningMessage("Не удалось убрать текущий чат в прошлые, поэтому другой чат не открыт: иначе текущий был бы потерян. Причина — в журнале («Вывод → dimosi»).");
      }
      const moved = this.saving.then(() => unarchiveChat(dir, chat.id, file)).then(
        () => true,
        (e) => (log.warn(`could not make the chat current: ${errorText(e)}`), false),
      );
      this.saving = moved.then(() => undefined);
      if (!(await moved)) return void vscode.window.showWarningMessage("Не удалось открыть чат. Он остался в списке прошлых чатов. Причина — в журнале («Вывод → dimosi»).");
      this.forget();
      this.adopt(saved);
      log.info(`earlier chat opened: ${saved.messages.length} messages, ${saved.trackers.length} revert cards`);
      this.post({ type: "restore", items: this.transcript.items });
      await this.postStatus();
    } finally {
      this.switching = false;
    }
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
      planFirst: this.planFirst,
      effort: s.effort ?? "",
      ...accessStatus(this.root(), s.extraFolders),
    });
  }

  togglePlanFirst(): void {
    this.planFirst = !this.planFirst;
    void this.postStatus();
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
      case "run_plan":
        if (this.busy) break;
        this.planFirst = false;
        await this.postStatus();
        await this.send("Выполняй план.");
        break;
      case "command":
        // Exactly the buttons the panel has, never with arguments.
        if (PANEL_COMMANDS.has(msg.command) && !("args" in msg)) await vscode.commands.executeCommand(msg.command);
        break;
      case "approval_response":
        // Anything but a known answer is a "no".
        this.approval.respond(msg.id, DECISIONS.has(msg.decision) ? msg.decision : "deny");
        break;
      case "open_diff":
        await this.approval.openDiff(msg.id);
        break;
      case "open_file": {
        const abs = this.inProject(msg.relPath);
        // A picture opens in VS Code's viewer, not as text.
        if (abs && isPicturePath(abs)) await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(abs));
        else if (abs) await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true });
        break;
      }
      case "load_picture": {
        const abs = this.inProject(msg.relPath);
        this.post({ type: "picture_data", relPath: msg.relPath, src: (abs && (await pictureDataUrl(abs))) ?? null });
        break;
      }
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
        const abs = this.inProject(msg.relPath);
        if (abs) await this.attachUri(vscode.Uri.file(abs));
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

  /** A path the panel sent, if it really is inside the project or an extra folder (links followed). */
  private inProject(relPath: string): string | undefined {
    const root = this.root();
    if (!root) return undefined;
    try {
      return resolvePath(createAccess(root, readSettings().extraFolders), relPath);
    } catch {
      return undefined;
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
      provider = await this.provider(settings, this.keys);
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
        problems: this.problems.watch,
        commandRules: commandRuleStore(this.context, root),
        log,
        ruleTrust: vscodeRuleTrust(this.context),
      });
    }
    const agent = this.agent;
    // A chat restored after a reload or opened from the list.
    if (this.restoredMessages) agent.restore(this.restoredMessages);
    this.restoredMessages = undefined;
    agent.provider = provider;
    agent.model = settings.model;
    agent.maxSteps = settings.maxSteps;
    agent.sandbox = settings.sandbox;
    agent.extraFolders = settings.extraFolders;
    agent.planFirst = this.planFirst;
    agent.effort = settings.effort;
    agent.images = await buildImages(settings, this.keys).catch(() => undefined);
    const planning = this.planFirst;
    let finished = false;
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
    this.running = running;
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
          case "image":
            this.post({ type: "picture", relPath: ev.relPath });
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
            finished = true;
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
      if (this.running === running) this.running = undefined;
      if (current && !tracker.isEmpty) this.post({ type: "changes", turn, files: tracker.summary() });
      if (current && planning && finished) this.post({ type: "plan_ready" });
      this.post({ type: "busy", busy: false });
      if (current) this.saveChat();
    }
  }

  // ---------- saved chat ----------

  private chatFile(): string | undefined {
    const dir = this.context.storageUri;
    return dir?.scheme === "file" ? path.join(dir.fsPath, "chat.json") : undefined;
  }

  /** The earlier chats of this folder, next to the current one. */
  private chatsDir(): string | undefined {
    const dir = this.context.storageUri;
    return dir?.scheme === "file" ? path.join(dir.fsPath, "chats") : undefined;
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
    this.adopt(saved);
  }

  /** Makes a saved chat the one in memory; the agent gets its history with the next message. */
  private adopt(saved: SavedChat): void {
    this.turn = Math.max(this.turn, saved.turn);
    for (const t of saved.trackers) this.trackers.set(t.turn, ChangeTracker.fromJSON(t, editorFiles));
    this.restoredMessages = saved.messages;
    this.transcript.items = restoredTranscript(saved, this.trackers);
  }

  /** Snapshots the chat now and writes it in the background. `running` is set mid-task. */
  private saveChat(running?: { turn: number; tracker: ChangeTracker }, interrupted = Boolean(running)): void {
    const file = this.chatFile();
    const root = this.root();
    if (!file || !root) return;
    const chat: SavedChat = {
      format: CHAT_FORMAT,
      root,
      turn: this.turn,
      // A chat that was restored or opened from the list is still on its way to the agent.
      messages: this.restoredMessages ?? this.agent?.messages ?? [],
      transcript: this.transcript.snapshot(running),
      trackers: [...this.trackers.entries()].filter(([, t]) => !t.isEmpty).map(([turn, t]) => ({ turn, ...t.toJSON() })),
      interrupted,
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

function chatSummary(chat: ChatInfo): string {
  const when = chat.savedAt ? new Date(chat.savedAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  return [when, chat.tasks ? `сообщений: ${chat.tasks}` : ""].filter(Boolean).join(" · ");
}
