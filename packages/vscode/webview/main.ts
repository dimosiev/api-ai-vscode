import type { FromWebview, ToWebview } from "../src/protocol";
import {
  approvalCommandCard,
  approvalWriteCard,
  changesCard,
  chipEl,
  finishToolCard,
  planCard,
  renderPlan,
  resolveApproval,
  toolCard,
  welcomeCard,
} from "./cards";
import { Composer } from "./composer";
import { h, svg } from "./dom";
import { ICONS, LOGO, PULSE } from "./icons";
import { renderMarkdown } from "./markdown";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();
const post = (msg: FromWebview) => vscode.postMessage(msg);

// ---------- layout ----------

const modelBtn = h("button", { class: "model-btn", title: "Выбрать сервис и модель", onclick: () => post({ type: "command", command: "dimosi.selectModel" }) });
const approvalBtn = h("button", { class: "pill", title: "Подтверждения действий агента", onclick: () => post({ type: "command", command: "dimosi.toggleApproval" }) });
const header = h("header", { class: "top" }, svg(LOGO, "brand-logo"), modelBtn, approvalBtn);

const log = h("main", { class: "log" });

const activityText = h("span", { class: "activity-text" });
const timer = h("span", { class: "activity-timer" });
const usageText = h("span", { class: "usage-text" });
const statusBar = h("div", { class: "status" }, h("span", { class: "activity" }, svg(PULSE, "pulse-icon"), activityText, timer), usageText);

const composer = new Composer(post, (message) => showError(message));
const footer = h("footer", {}, statusBar, composer.el);

document.getElementById("app")!.append(header, log, footer);

// ---------- state ----------

let status: Extract<ToWebview, { type: "status" }> | undefined;
let turnEl: HTMLElement | null = null;
let textEl: { el: HTMLElement; raw: string } | null = null;
let plan: HTMLElement | null = null;
let renderQueued = false;
const tools = new Map<number, HTMLElement>();
const approvals = new Map<string, HTMLElement>();
let busy = false;
let startedAt = 0;
let timerHandle: number | undefined;

function atBottom(): boolean {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}

function add(el: HTMLElement, parent: HTMLElement = turnEl ?? log): HTMLElement {
  const stick = atBottom();
  document.getElementById("welcome")?.remove();
  parent.append(el);
  if (stick) log.scrollTop = log.scrollHeight;
  return el;
}

function currentTurn(): HTMLElement {
  if (!turnEl) turnEl = add(h("section", { class: "turn" }), log);
  return turnEl;
}

function showWelcome(): void {
  if (log.children.length && !document.getElementById("welcome")) return;
  document.getElementById("welcome")?.remove();
  log.append(welcomeCard(status?.needsSetup ?? false, status?.hasFolder ?? true, post, (t) => composer.fill(t)));
}

function showError(message: string, action?: { label: string; command: string }): void {
  textEl = null;
  add(
    h(
      "div",
      { class: "error-card" },
      svg(ICONS.warn, "inline-icon"),
      h("span", {}, message),
      action && h("button", { class: "btn primary small", onclick: () => post({ type: "command", command: action.command }) }, action.label),
    ),
    turnEl ?? log,
  );
}

function flushText(): void {
  renderQueued = false;
  if (!textEl) return;
  const stick = atBottom();
  textEl.el.innerHTML = renderMarkdown(textEl.raw);
  if (stick) log.scrollTop = log.scrollHeight;
}

function setBusy(value: boolean): void {
  busy = value;
  composer.setBusy(value);
  document.body.classList.toggle("busy", value);
  window.clearInterval(timerHandle);
  if (value) {
    startedAt = Date.now();
    usageText.textContent = "";
    timer.textContent = "";
    timerHandle = window.setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      timer.textContent = s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
    }, 1000);
  } else {
    activityText.textContent = "Готово";
    flushText();
    textEl = null;
    turnEl = null;
    plan = null;
  }
}

// Copy buttons inside rendered code blocks.
log.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".copy");
  if (!btn) return;
  const code = btn.parentElement?.querySelector("code")?.textContent ?? "";
  void navigator.clipboard.writeText(code).then(() => {
    btn.textContent = "Скопировано";
    setTimeout(() => (btn.textContent = "Копировать"), 1500);
  });
});

// ---------- messages ----------

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case "status": {
      status = msg;
      modelBtn.replaceChildren(h("span", { class: "model-provider" }, msg.provider), h("span", { class: "model-name" }, msg.model));
      approvalBtn.textContent = msg.approval === "auto" ? "Без подтверждений" : "С подтверждением";
      approvalBtn.classList.toggle("danger", msg.approval === "auto");
      if (!log.querySelector(".turn")) showWelcome();
      break;
    }
    case "user": {
      turnEl = null;
      textEl = null;
      plan = null;
      const turn = currentTurn();
      add(
        h(
          "div",
          { class: "user-msg" },
          msg.chips.length ? h("div", { class: "user-chips" }, ...msg.chips.map((c) => chipEl(c))) : null,
          msg.text ? h("div", { class: "user-text" }, msg.text) : null,
        ),
        turn,
      );
      log.scrollTop = log.scrollHeight;
      break;
    }
    case "rules":
      composer.setRules(msg.rules);
      break;
    case "text":
      if (!textEl) textEl = { el: add(h("div", { class: "assistant md" }), currentTurn()), raw: "" };
      textEl.raw += msg.text;
      if (!renderQueued) {
        renderQueued = true;
        requestAnimationFrame(flushText);
      }
      break;
    case "activity":
      activityText.textContent = msg.text;
      break;
    case "tool_start":
      flushText();
      textEl = null;
      if (msg.name === "update_plan") break; // shown as the plan card instead
      tools.set(msg.id, add(toolCard(msg.title, msg.name), currentTurn()));
      break;
    case "tool_end": {
      const card = tools.get(msg.id);
      if (card) finishToolCard(card, msg.result, msg.isError);
      break;
    }
    case "plan":
      if (!plan) {
        plan = planCard();
        // The plan sits right under the user's message.
        const turn = currentTurn();
        const anchor = turn.querySelector(".user-msg");
        if (anchor?.nextSibling) turn.insertBefore(plan, anchor.nextSibling);
        else add(plan, turn);
      }
      renderPlan(plan, msg.items);
      break;
    case "approval_request": {
      flushText();
      textEl = null;
      const card =
        msg.kind === "write"
          ? approvalWriteCard(msg.id, msg.relPath, msg.created, msg.diff, post)
          : approvalCommandCard(msg.id, msg.command, post);
      approvals.set(msg.id, add(card, currentTurn()));
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      activityText.textContent = "Ждёт вашего решения…";
      break;
    }
    case "approval_resolved": {
      const card = approvals.get(msg.id);
      if (card) resolveApproval(card, msg.decision);
      approvals.delete(msg.id);
      break;
    }
    case "changes": {
      const existing = log.querySelector(`.changes[data-turn="${msg.turn}"]`);
      const card = changesCard(msg.turn, msg.files, post);
      if (existing) existing.replaceWith(card);
      else if (msg.files.length) add(card, currentTurn());
      break;
    }
    case "usage": {
      const parts = [`токены ${msg.tokens}`];
      if (msg.cost) parts.push(`≈ ${msg.cost}`);
      if (msg.chatCost && msg.chatCost !== msg.cost) parts.push(`за чат ≈ ${msg.chatCost}`);
      parts.push(`контекст ${msg.context}`);
      usageText.textContent = parts.join(" · ");
      usageText.classList.toggle("warn", msg.contextWarning);
      usageText.title = msg.contextWarning ? "Разговор стал длинным: ответы дороже и медленнее. Для новой задачи начните новый чат (+)." : "";
      break;
    }
    case "busy":
      setBusy(msg.busy);
      break;
    case "error":
      showError(msg.message, msg.action);
      break;
    case "attachments":
      composer.setChips(msg.chips);
      break;
    case "active_file":
      composer.setActiveFile(msg.label);
      break;
    case "mentions":
      composer.showMentions(msg.query, msg.items);
      break;
    case "focus_input":
      composer.input.focus();
      break;
    case "clear":
      log.replaceChildren();
      tools.clear();
      approvals.clear();
      turnEl = null;
      textEl = null;
      plan = null;
      usageText.textContent = "";
      activityText.textContent = "";
      showWelcome();
      break;
  }
});

void busy;
post({ type: "ready" });
composer.input.focus();
