// @vitest-environment jsdom
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

  it("command approvals can be denied", () => {
    send({ type: "approval_request", id: "a2", kind: "command", command: "npm test" });
    const card = $$(".approval").at(-1)!;
    expect(card.querySelector(".command")?.textContent).toBe("$ npm test");
    ($$(".approval-actions .btn").find((b) => b.textContent === "Отклонить") as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "approval_response", id: "a2", decision: "deny" });
  });

  it("shows changed files with revert, then usage and finishes", () => {
    send({ type: "changes", turn: 1, files: [{ relPath: "hello.txt", added: 1, removed: 0, created: true, reverted: false }] });
    ($(".changes .btn.link") as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "revert", turn: 1, relPath: "hello.txt" });
    send({ type: "changes", turn: 1, files: [{ relPath: "hello.txt", added: 1, removed: 0, created: true, reverted: true }] });
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
});
