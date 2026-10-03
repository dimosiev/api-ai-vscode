import type { ChipView, RuleView } from "../src/protocol";
import { chipEl, rulesChip, type Post } from "./cards";
import { h, svg } from "./dom";
import { ICONS } from "./icons";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** The input area: text box, attachment chips, @-mentions, paste and drop. */
export class Composer {
  readonly el: HTMLElement;
  readonly input: HTMLTextAreaElement;
  private chipsRow: HTMLElement;
  private sendBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private planBtn: HTMLButtonElement;
  private popup: HTMLElement;
  private chips: ChipView[] = [];
  private rules: RuleView[] = [];
  private activeFile: string | null = null;
  private mentionItems: string[] = [];
  private mentionIndex = 0;
  private mentionQuery: string | null = null;
  private busy = false;

  constructor(
    private post: Post,
    private hint: (message: string) => void,
  ) {
    this.input = h("textarea", {
      rows: "3",
      placeholder: "Опишите задачу… (@ — прикрепить файл, Shift+Enter — новая строка)",
      title: "Enter — отправить, Shift+Enter — новая строка, @ — прикрепить файл из проекта, можно вставить картинку",
    });
    this.chipsRow = h("div", { class: "chips" });
    this.popup = h("div", { class: "mentions", hidden: true });
    this.sendBtn = h("button", { class: "btn primary", title: "Отправить (Enter)", onclick: () => this.send() }, svg(ICONS.send, "inline-icon"), "Отправить");
    this.stopBtn = h("button", { class: "btn danger", hidden: true, title: "Остановить агента", onclick: () => this.post({ type: "stop" }) }, svg(ICONS.stop, "inline-icon"), "Стоп");
    this.planBtn = h(
      "button",
      { class: "btn subtle plan-toggle", "aria-pressed": "false", onclick: () => this.post({ type: "command", command: "dimosi.togglePlanFirst" }) },
      "Сначала план",
    );
    this.setPlanFirst(false);
    const attachBtn = h("button", { class: "icon-btn", title: "Прикрепить файлы или картинки", onclick: () => this.post({ type: "pick_files" }) }, svg(ICONS.clip));

    this.el = h(
      "div",
      { class: "composer" },
      this.chipsRow,
      h("div", { class: "input-wrap" }, this.popup, this.input),
      h("div", { class: "composer-row" }, attachBtn, this.planBtn, h("span", { class: "spacer" }), this.stopBtn, this.sendBtn),
    );

    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.input.addEventListener("input", () => this.onInput());
    this.input.addEventListener("paste", (e) => this.onPaste(e));
    this.el.addEventListener("dragover", (e) => {
      e.preventDefault();
      this.el.classList.add("dragging");
    });
    this.el.addEventListener("dragleave", () => this.el.classList.remove("dragging"));
    this.el.addEventListener("drop", (e) => this.onDrop(e));
    this.renderChips();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.sendBtn.hidden = busy;
    this.stopBtn.hidden = !busy;
    if (!busy) this.input.focus();
  }

  setPlanFirst(on: boolean): void {
    this.planBtn.classList.toggle("on", on);
    this.planBtn.setAttribute("aria-pressed", String(on));
    this.planBtn.title = on
      ? "Включено: агент изучит задачу и покажет план, ничего не меняя. Нажмите, чтобы выключить."
      : "Сначала план: агент изучит задачу и покажет план, а менять файлы начнёт только после вашего «Выполнить план».";
  }

  setChips(chips: ChipView[]): void {
    this.chips = chips;
    this.renderChips();
  }

  setRules(rules: RuleView[]): void {
    this.rules = rules;
    this.renderChips();
  }

  setActiveFile(label: string | null): void {
    this.activeFile = label;
    this.renderChips();
  }

  fill(text: string): void {
    this.input.value = text;
    this.input.focus();
  }

  showMentions(query: string, items: string[]): void {
    if (query !== this.mentionQuery) return; // stale answer
    this.mentionItems = items;
    this.mentionIndex = 0;
    this.renderMentions();
  }

  private renderChips(): void {
    const attachedLabels = new Set(this.chips.map((c) => c.label));
    const suggestion =
      this.activeFile && !attachedLabels.has(this.activeFile)
        ? h(
            "button",
            { class: "chip suggestion", title: "Прикрепить открытый файл", onclick: () => this.post({ type: "attach_active_file" }) },
            svg(ICONS.plus, "chip-icon"),
            h("span", { class: "chip-label" }, this.activeFile.split("/").pop() ?? this.activeFile),
          )
        : null;
    this.chipsRow.replaceChildren(
      rulesChip(this.rules, this.post),
      ...this.chips.map((c) => chipEl(c, () => this.post({ type: "remove_attachment", id: c.id }))),
      ...(suggestion ? [suggestion] : []),
    );
  }

  private send(): void {
    if (this.busy) return;
    const text = this.input.value.trim();
    if (!text && !this.chips.length) return;
    this.input.value = "";
    this.closeMentions();
    this.post({ type: "send", text });
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.mentionQuery !== null && this.mentionItems.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = this.mentionItems.length;
        this.mentionIndex = (this.mentionIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        this.renderMentions();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        this.pickMention(this.mentionItems[this.mentionIndex]);
        return;
      }
    }
    if (e.key === "Escape" && this.mentionQuery !== null) {
      this.closeMentions();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.send();
    }
  }

  private onInput(): void {
    const before = this.input.value.slice(0, this.input.selectionStart ?? this.input.value.length);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (!m) return this.closeMentions();
    this.mentionQuery = m[1];
    this.post({ type: "mention_query", query: m[1] });
  }

  private pickMention(relPath: string | undefined): void {
    if (!relPath) return;
    const pos = this.input.selectionStart ?? this.input.value.length;
    const before = this.input.value.slice(0, pos).replace(/@([^\s@]*)$/, "");
    this.input.value = before + this.input.value.slice(pos);
    this.input.selectionStart = this.input.selectionEnd = before.length;
    this.post({ type: "attach_path", relPath });
    this.closeMentions();
    this.input.focus();
  }

  private renderMentions(): void {
    if (!this.mentionItems.length) {
      this.popup.hidden = true;
      return;
    }
    this.popup.hidden = false;
    this.popup.replaceChildren(
      ...this.mentionItems.map((item, i) =>
        h(
          "div",
          {
            class: `mention${i === this.mentionIndex ? " active" : ""}`,
            onmousedown: (e: MouseEvent) => {
              e.preventDefault();
              this.pickMention(item);
            },
          },
          svg(ICONS.file, "chip-icon"),
          h("span", { class: "mention-name" }, item.split("/").pop() ?? item),
          h("span", { class: "mention-path" }, item),
        ),
      ),
    );
    this.popup.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  private closeMentions(): void {
    this.mentionQuery = null;
    this.mentionItems = [];
    this.popup.hidden = true;
  }

  private onPaste(e: ClipboardEvent): void {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => IMAGE_TYPES.includes(f.type));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) void this.sendImage(f, f.name && f.name !== "image.png" ? f.name : `скриншот-${new Date().toLocaleTimeString()}.png`);
  }

  private onDrop(e: DragEvent): void {
    e.preventDefault();
    this.el.classList.remove("dragging");
    const dt = e.dataTransfer;
    if (!dt) return;
    const uriList = dt.getData("text/uri-list") || dt.getData("application/vnd.code.uri-list");
    const uris = parseUriList(uriList);
    if (uris.length) {
      this.post({ type: "attach_uris", uris });
      return;
    }
    const files = [...dt.files];
    const images = files.filter((f) => IMAGE_TYPES.includes(f.type));
    for (const f of images) void this.sendImage(f, f.name);
    if (files.length > images.length) {
      this.hint("Обычные файлы перетаскивайте из списка файлов VS Code с зажатым Shift или прикрепите кнопкой со скрепкой. Картинки можно перетаскивать откуда угодно.");
    }
  }

  private async sendImage(file: File, name: string): Promise<void> {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    this.post({ type: "attach_data", name, mediaType: file.type, data });
  }
}

function parseUriList(text: string): string[] {
  if (!text) return [];
  const trimmed = text.trim();
  // VS Code may send a JSON array of URIs.
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr.map(String);
    } catch {
      // fall through
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
