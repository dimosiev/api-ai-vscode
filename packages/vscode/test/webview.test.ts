// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { FromWebview, ToWebview } from "../src/protocol";

const posted: FromWebview[] = [];

function send(msg: ToWebview) {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const nextFrame = () => new Promise((r) => setTimeout(r, 30));

beforeAll(async () => {
  (globalThis as any).acquireVsCodeApi = () => ({ postMessage: (m: FromWebview) => posted.push(m) });
  Element.prototype.scrollIntoView ??= function () {}; // not implemented in jsdom
  (globalThis as any).requestAnimationFrame ??= (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
  document.body.innerHTML = '<div id="app"></div>';
  await import("../webview/main");
});

describe("chat webview", () => {
  it("says it is ready and shows the setup screen when no key is configured", () => {
    expect(posted[0]).toEqual({ type: "ready" });
    send({ type: "status", provider: "Polza AI", model: "anthropic/claude-opus-5.5", approval: "ask", needsSetup: true, hasFolder: true });
    expect($(".model-name")?.textContent).toBe("anthropic/claude-opus-5.5");
    expect($(".welcome")?.textContent).toContain("Выбрать сервис и ввести ключ");
    ($$(".welcome .btn.primary")[0]).click();
    expect(posted.at(-1)).toEqual({ type: "command", command: "dimosi.selectModel" });
  });

  it("shows examples once set up, and an example fills the input", () => {
    send({ type: "status", provider: "Polza AI", model: "m", approval: "ask", needsSetup: false, hasFolder: true });
    const example = $(".example")!;
    example.click();
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe(example.textContent);
  });

  it("sends on Enter and renders a full turn", async () => {
    const input = document.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "создай файл";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(posted.at(-1)).toEqual({ type: "send", text: "создай файл" });

    send({ type: "user", text: "создай файл", chips: [{ id: "a1", label: "src/app.ts", kind: "file" }] });
    send({ type: "busy", busy: true });
    send({ type: "rules", rules: [{ label: "AGENTS.md", path: "/p/AGENTS.md", scope: "project", truncated: false }] });
    send({ type: "plan", items: [{ title: "Шаг 1", status: "in_progress" }, { title: "Шаг 2", status: "pending" }] });
    send({ type: "text", text: "Создаю **файл**.\n\n<script>alert(1)</script>" });
    await nextFrame();

    expect($(".welcome")).toBeNull();
    expect($(".user-msg")?.textContent).toContain("src/app.ts");
    expect($(".rules-chip")?.textContent).toBe("Правила: 1");
    expect($(".plan-progress")?.textContent).toBe("0/2");
    const assistant = $(".assistant")!;
    expect(assistant.querySelector("strong")?.textContent).toBe("файл");
    expect(assistant.querySelector("script")).toBeNull(); // raw HTML is escaped
    expect(assistant.textContent).toContain("<script>");
    expect($(".btn.danger")?.hidden).toBe(false); // Stop visible

    send({ type: "tool_start", id: 1, title: "Чтение a.txt", name: "read_file" });
    send({ type: "tool_end", id: 1, result: "1\thello", isError: false });
    expect($(".tool.ok .tool-title")?.textContent).toBe("Чтение a.txt");
  });

  it("asks for approval in the chat and reports the decision", () => {
    send({
      type: "approval_request",
      id: "a1",
      kind: "write",
      relPath: "hello.txt",
      created: true,
      diff: { rows: [{ t: "hunk", text: "@@" }, { t: "add", text: "Привет", new: 1 }], added: 1, removed: 0, truncated: false },
    });
    const card = $(".approval")!;
    expect(card.textContent).toContain("Создать файл hello.txt");
    expect(card.querySelector(".diff-row.add")?.textContent).toContain("Привет");
    (card.querySelector(".btn.primary") as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "approval_response", id: "a1", decision: "allow" });
    send({ type: "approval_resolved", id: "a1", decision: "allow" });
    expect(card.classList.contains("resolved")).toBe(true);
    expect(card.querySelector(".approval-actions")).toBeNull();
    expect(card.textContent).toContain("Разрешено");
  });

  it("a file that runs code later gets a warning and no Always button", () => {
    send({
      type: "approval_request",
      id: "p1",
      kind: "write",
      relPath: ".vscode/tasks.json",
      created: true,
      diff: { rows: [{ t: "add", text: "{}", new: 1 }], added: 1, removed: 0, truncated: false },
      warning: "Это файл настроек VS Code.",
    });
    const card = $$(".approval").at(-1)!;
    expect(card.classList.contains("protected")).toBe(true);
    expect(card.querySelector(".approval-warning")?.textContent).toContain("Это файл настроек VS Code.");
    expect([...card.querySelectorAll(".approval-actions .btn")].map((b) => b.textContent)).not.toContain("Всегда");
    ($$(".approval-actions .btn").find((b) => b.textContent === "Отклонить") as HTMLElement).click();
    send({ type: "approval_resolved", id: "p1", decision: "deny" });
  });

  it("a dangerous command gets a warning and no Always button", () => {
    send({ type: "approval_request", id: "c9", kind: "command", command: "git push", warning: "Отправка кода." });
    const card = $$(".approval").at(-1)!;
    expect(card.classList.contains("protected")).toBe(true);
    expect(card.querySelector(".approval-warning")?.textContent).toContain("Отправка кода.");
    expect([...card.querySelectorAll(".approval-actions .btn")].map((b) => b.textContent)).not.toContain("Всегда");
    ($$(".approval-actions .btn").find((b) => b.textContent === "Отклонить") as HTMLElement).click();
    send({ type: "approval_resolved", id: "c9", decision: "deny" });
  });

  it("an ordinary command says what Always will remember, and afterwards links to the list", () => {
    send({ type: "approval_request", id: "c10", kind: "command", command: "npm test -- --watch", always: { kind: "prefix", text: "npm test" } });
    const card = $$(".approval").at(-1)!;
    const always = [...card.querySelectorAll(".approval-actions .btn")].find((b) => b.textContent?.startsWith("Всегда")) as HTMLElement;
    expect(always.textContent).toBe("Всегда для «npm test …»");
    expect(always.title).toContain("начинаются с «npm test»");
    always.click();
    expect(posted.at(-1)).toEqual({ type: "approval_response", id: "c10", decision: "allow_always" });
    send({ type: "approval_resolved", id: "c10", decision: "allow_always" });
    expect(card.querySelector(".approval-result")?.textContent).toContain("Больше не спрашиваю в этом проекте про команды, которые начинаются с «npm test»");
    (card.querySelector(".approval-result .btn") as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "command", command: "dimosi.showCommandRules" });

    send({ type: "approval_request", id: "c11", kind: "command", command: "npm test && npm run build", always: { kind: "exact", text: "npm test && npm run build" } });
    const exact = $$(".approval").at(-1)!;
    expect([...exact.querySelectorAll(".approval-actions .btn")].map((b) => b.textContent)).toContain("Всегда для этой команды");
    send({ type: "approval_resolved", id: "c11", decision: "allow" });
    expect(exact.querySelector(".approval-result")?.textContent).toBe("Разрешено");
  });

  it("a streaming reply is redrawn at most ten times a second, and completely at the end", async () => {
    send({ type: "user", text: "длинный ответ", chips: [] });
    send({ type: "text", text: "Начало. " });
    const reply = $$(".assistant").at(-1)!;
    let redraws = 0;
    const observer = new MutationObserver(() => redraws++);
    observer.observe(reply, { childList: true });
    for (let i = 1; i <= 200; i++) send({ type: "text", text: `слово${i} ` });
    // 200 pieces arrived at once: not 200 redraws, and the text is not there yet.
    expect(reply.textContent).not.toContain("слово200");
    const until = Date.now() + 5000;
    while (!reply.textContent?.includes("слово200") && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    expect(reply.textContent).toContain("слово200");
    expect(redraws).toBeLessThanOrEqual(2);
    // The end of the task draws what is left without waiting.
    send({ type: "text", text: "Конец." });
    send({ type: "busy", busy: false });
    expect(reply.textContent).toContain("Конец.");
    observer.disconnect();
  });

  it("a web page card shows the whole address and offers to remember the site", () => {
    send({ type: "approval_request", id: "f1", kind: "fetch", url: "https://docs.example.com/guide?topic=fetch", host: "docs.example.com" });
    const card = $$(".approval").at(-1)!;
    expect(card.querySelector(".approval-title")?.textContent).toBe("Прочитать страницу в интернете");
    expect(card.querySelector(".command")?.textContent).toBe("https://docs.example.com/guide?topic=fetch");
    expect([...card.querySelectorAll(".approval-actions .btn")].map((b) => b.textContent)).toEqual(["Прочитать", "Отклонить", "Всегда для docs.example.com"]);
    send({ type: "approval_resolved", id: "f1", decision: "allow_always" });
    expect(card.querySelector(".approval-result")?.textContent).toContain("Больше не спрашиваю во всех проектах про страницы сайта docs.example.com");
  });

  it("a picture card shows the description, the model and the price, without an Always button; the picture is drawn when its content arrives", () => {
    send({ type: "approval_request", id: "img1", kind: "image", prompt: "баннер о погоде", relPath: "img/weather.png", model: "qwen/image-2", price: "4 ₽" });
    const card = $('.approval[data-id="img1"]')!;
    expect(card.querySelector(".approval-title")?.textContent).toBe("Создать картинку img/weather.png");
    expect(card.querySelector(".command")?.textContent).toBe("баннер о погоде");
    expect(card.querySelector(".approval-note")?.textContent).toContain("Платный запрос к модели qwen/image-2 через Polza AI: одна картинка стоит 4 ₽");
    expect([...card.querySelectorAll(".approval-actions .btn")].map((b) => b.textContent)).toEqual(["Создать", "Отклонить"]);
    (card.querySelector(".btn.primary") as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "approval_response", id: "img1", decision: "allow" });
    send({ type: "approval_resolved", id: "img1", decision: "allow" });

    send({ type: "picture", relPath: "img/weather.png" });
    expect(posted.at(-1)).toEqual({ type: "load_picture", relPath: "img/weather.png" });
    const picture = $('.picture[data-path="img/weather.png"]')!;
    expect(picture.querySelector("img")).toBeNull();
    send({ type: "picture_data", relPath: "img/weather.png", src: "data:image/png;base64,AAAA" });
    expect(picture.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    (picture.querySelector(".change-path") as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "open_file", relPath: "img/weather.png" });

    send({ type: "picture", relPath: "img/gone.png" });
    send({ type: "picture_data", relPath: "img/gone.png", src: null });
    expect($('.picture[data-path="img/gone.png"]')?.textContent).toContain("не удалось показать");
  });

  it("the plan toggle shows its state; a ready plan offers to run it once", () => {
    const status = { type: "status", provider: "Polza AI", model: "m", approval: "ask", needsSetup: false, hasFolder: true, access: "проект", accessDetail: "" } as const;
    send({ ...status, planFirst: false });
    const toggle = $(".plan-toggle")!;
    expect(toggle.classList.contains("on")).toBe(false);
    expect(toggle.textContent).toBe("Сначала план");
    expect($(".composer-row .btn.primary")?.textContent).toBe("Отправить");
    toggle.click();
    expect(posted.at(-1)).toEqual({ type: "command", command: "dimosi.togglePlanFirst" });
    send({ ...status, planFirst: true });
    expect(toggle.classList.contains("on")).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    // Seen at a glance: another label, a check mark, and the main button says what it will do.
    expect(toggle.textContent).toBe("План включён");
    expect(toggle.querySelector("svg")).not.toBeNull();
    expect($(".composer-row .btn.primary")?.textContent).toBe("Составить план");
    // The filled look must win over ".btn.subtle" (it did not: the button looked the same on and off).
    const css = readFileSync(path.join(__dirname, "../media/chat.css"), "utf8");
    expect(css).toMatch(/\.btn\.plan-toggle\.on \{[^}]*background: var\(--brand\);/);

    send({ type: "user", text: "сделай страницу", chips: [] });
    send({ type: "plan_ready" });
    const card = $$(".plan-ready").at(-1)!;
    expect(card.textContent).toContain("План готов. Агент пока ничего не менял.");
    (card.querySelector(".btn.primary") as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "run_plan" });
    expect(card.querySelector(".btn")).toBeNull();

    // An older plan can't be run after the conversation moved on.
    send({ type: "plan_ready" });
    send({ type: "user", text: "поправь план", chips: [] });
    expect($$(".plan-ready .btn")).toEqual([]);
    send({ type: "busy", busy: false });
  });

  it("the access line shows what the agent can reach, and Change opens the list", () => {
    send({ type: "status", provider: "Polza AI", model: "m", approval: "ask", needsSetup: false, hasFolder: true, access: "проект + 2 папки", accessDetail: "/p — проект\n/notes — только чтение" });
    expect($(".access-text")?.textContent).toBe("Доступ: проект + 2 папки");
    expect($(".access-text")?.title).toContain("/notes — только чтение");
    ($(".access .link") as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "command", command: "dimosi.editAccess" });
  });

  it("the rules chip counts untrusted files separately", () => {
    send({
      type: "rules",
      rules: [
        { label: ".dimosi/rules.md", path: "/p/.dimosi/rules.md", scope: "project", truncated: false },
        { label: "AGENTS.md", path: "/p/AGENTS.md", scope: "project", truncated: false, skipped: true },
      ],
    });
    expect($(".rules-chip")?.textContent).toBe("Правила: 1 · не доверено: 1");
    expect($(".rules-chip")?.title).toContain("Не подключены (вы им не доверяете):\n• AGENTS.md");
  });

  it("command approvals can be denied", () => {
    send({ type: "approval_request", id: "a2", kind: "command", command: "npm test" });
    const card = $$(".approval").at(-1)!;
    expect(card.querySelector(".command")?.textContent).toBe("$ npm test");
    ($$(".approval-actions .btn").find((b) => b.textContent === "Отклонить") as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "approval_response", id: "a2", decision: "deny" });
  });

  it("shows changed files with revert, then usage and finishes", () => {
    send({ type: "changes", turn: 1, files: [{ relPath: "hello.txt", added: 1, removed: 0, created: true, reverted: false, unavailable: false }] });
    ($(".changes .btn.link") as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "revert", turn: 1, relPath: "hello.txt" });
    send({ type: "changes", turn: 1, files: [{ relPath: "hello.txt", added: 1, removed: 0, created: true, reverted: true, unavailable: false }] });
    expect($$(".changes")).toHaveLength(1);
    expect($(".change-row.reverted")).not.toBeNull();

    send({ type: "usage", tokens: "12 тыс. → 300", cost: "1.20 ₽", chatCost: "1.20 ₽", context: "12 тыс.", contextWarning: false });
    expect($(".usage-text")?.textContent).toBe("токены 12 тыс. → 300 · ≈ 1.20 ₽ · контекст 12 тыс.");
    send({ type: "busy", busy: false });
    expect($(".btn.danger")?.hidden).toBe(true);
  });

  it("shows attachment chips that can be removed, and the active file suggestion", () => {
    send({ type: "attachments", chips: [{ id: "x1", label: "shot.png", kind: "image" }] });
    send({ type: "active_file", label: "src/index.ts" });
    const chip = $(".chips .chip-image")!;
    (chip.querySelector(".chip-x") as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "remove_attachment", id: "x1" });
    ($(".chip.suggestion") as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "attach_active_file" });
  });

  it("offers @-mentions and attaches the picked file", () => {
    const input = document.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "посмотри @app";
    input.selectionStart = input.selectionEnd = input.value.length;
    input.dispatchEvent(new Event("input"));
    expect(posted.at(-1)).toEqual({ type: "mention_query", query: "app" });
    send({ type: "mentions", query: "app", items: ["src/app.ts", "test/app.test.ts"] });
    expect($$(".mention")).toHaveLength(2);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(posted.at(-1)).toEqual({ type: "attach_path", relPath: "test/app.test.ts" });
    expect(input.value).toBe("посмотри ");
    expect($(".mentions")?.hidden).toBe(true);
  });

  it("shows errors with an action button, and clears on new chat", () => {
    send({ type: "error", message: "Нет API-ключа для Polza AI.", action: { label: "Ввести ключ", command: "dimosi.setApiKey" } });
    ($(".error-card .btn") as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "command", command: "dimosi.setApiKey" });
    send({ type: "clear" });
    expect($(".turn")).toBeNull();
    expect($(".welcome")).not.toBeNull();
  });

  it("redraws a saved chat: messages, plan, decided approvals and revert buttons", async () => {
    send({
      type: "restore",
      items: [
        { type: "user", text: "первая задача", chips: [] },
        { type: "plan", items: [{ title: "Шаг 1", status: "done" }] },
        { type: "text", text: "Сделано **всё**." },
        { type: "approval_request", id: "a1", kind: "command", command: "npm test" },
        { type: "approval_resolved", id: "a1", decision: "deny" },
        {
          type: "changes",
          turn: 1,
          files: [
            { relPath: "a.txt", added: 1, removed: 0, created: false, reverted: false, unavailable: false },
            { relPath: "big.txt", added: 1, removed: 1, created: false, reverted: false, unavailable: true },
          ],
        },
        { type: "user", text: "вторая", chips: [] },
        { type: "text", text: "Ответ два" },
      ],
    });
    await nextFrame();
    expect($(".welcome")).toBeNull();
    expect($$(".turn")).toHaveLength(2);
    expect($$(".assistant").map((e) => e.textContent?.trim())).toEqual(["Сделано всё.", "Ответ два"]);
    expect($(".plan-progress")?.textContent).toBe("1/1");
    expect($(".approval")?.classList.contains("denied")).toBe(true);
    const rows = $$(".change-row");
    expect(rows[0].querySelector("button.btn.link")?.textContent).toBe("Откатить");
    expect(rows[1].textContent).toContain("откат недоступен");
    expect(rows[1].querySelector("button.btn.link")).toBeNull();
    ($(".change-row .btn.link") as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "revert", turn: 1, relPath: "a.txt" });

    // The restored chat continues like a normal one.
    send({ type: "user", text: "третья", chips: [] });
    expect($$(".turn")).toHaveLength(3);
  });
});

describe("chat.css", () => {
  it("wraps long lines of a change instead of pushing them off the edge", () => {
    const css = readFileSync(path.join(__dirname, "../media/chat.css"), "utf8");
    const row = css.match(/\.diff-row \{[^}]*\}/)![0];
    expect(row).toMatch(/white-space: pre-wrap/);
    expect(row).toMatch(/overflow-wrap: anywhere/);
    expect(row).not.toMatch(/max-content/);
  });
});


describe("plan progress bar", () => {
  it("is filled through the style property: the panel's security policy blocks style attributes", () => {
    const setAttribute = Element.prototype.setAttribute;
    const styleAttrs: string[] = [];
    Element.prototype.setAttribute = function (name: string, value: string) {
      if (name.toLowerCase() === "style") styleAttrs.push(value);
      return setAttribute.call(this, name, value);
    };
    try {
      send({ type: "plan", items: [{ title: "Шаг 1", status: "done" }, { title: "Шаг 2", status: "in_progress" }] });
    } finally {
      Element.prototype.setAttribute = setAttribute;
    }
    expect(styleAttrs).toEqual([]);
    expect($$(".plan-bar-fill").at(-1)?.style.width).toBe("50%");
  });
});
