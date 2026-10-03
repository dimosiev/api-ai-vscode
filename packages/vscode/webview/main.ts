import type { FromWebview, ToWebview } from "../src/protocol";
import {
  approvalCommandCard,
  approvalFetchCard,
  approvalImageCard,
  approvalWriteCard,
  changesCard,
  chipEl,
  finishToolCard,
  planCard,
  pictureCard,
  planReadyCard,
  renderPlan,
  resolveApproval,
  showPicture,
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
const accessText = h("span", { class: "access-text" });
const accessRow = h(
  "div",
  { class: "access" },
  accessText,
  h("button", { class: "link", title: "Открыть агенту папки вне проекта или закрыть их", onclick: () => post({ type: "command", command: "dimosi.editAccess" }) }, "Изменить"),
);

const log = h("main", { class: "log" });

const activityText = h("span", { class: "activity-text" });
const timer = h("span", { class: "activity-timer" });
const usageText = h("span", { class: "usage-text" });
const statusBar = h("div", { class: "status" }, h("span", { class: "activity" }, svg(PULSE, "pulse-icon"), activityText, timer), usageText);

const composer = new Composer(post, (message) => showError(message));
const footer = h("footer", {}, statusBar, composer.el);

document.getElementById("app")!.append(header, accessRow, log, footer);

// ---------- state ----------

let status: Extract<ToWebview, { type: "status" }> | undefined;
let turnEl: HTMLElement | null = null;
let textEl: { el: HTMLElement; raw: string } | null = null;
let plan: HTMLElement | null = null;
let renderQueued = false;
let lastRender = 0;
/** A long reply is parsed again from the start on every redraw: ten times a second is enough for the eye. */
const RENDER_EVERY_MS = 100;
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
  lastRender = performance.now();
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

window.addEventListener("message", (event: MessageEvent<ToWebview>) => handle(event.data));

function handle(msg: ToWebview): void {
  switch (msg.type) {
    case "status": {
      status = msg;
      modelBtn.replaceChildren(h("span", { class: "model-provider" }, msg.provider), h("span", { class: "model-name" }, msg.model));
      approvalBtn.textContent = msg.approval === "auto" ? "Без подтверждений" : "С подтверждением";
      approvalBtn.classList.toggle("danger", msg.approval === "auto");
      composer.setPlanFirst(msg.planFirst);
      accessText.textContent = `Доступ: ${msg.access}`;
      accessText.title = msg.accessDetail;
      if (!log.querySelector(".turn")) showWelcome();
      break;
    }
    case "plan_ready":
      add(planReadyCard(post), turnEl ?? log);
      break;
    case "user": {
      // An older plan is no longer the one to run.
      for (const old of log.querySelectorAll(".plan-ready .approval-actions")) old.remove();
      flushText();
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
      if (performance.now() - lastRender >= RENDER_EVERY_MS) {
        flushText();
      } else if (!renderQueued) {
        renderQueued = true;
        setTimeout(flushText, RENDER_EVERY_MS - (performance.now() - lastRender));
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
          ? approvalWriteCard(msg.id, msg.relPath, msg.created, msg.diff, post, msg.warning)
          : msg.kind === "image"
            ? approvalImageCard(msg.id, msg.prompt, msg.relPath, msg.model, post, msg.price, msg.warning)
          : msg.kind === "fetch"
            ? approvalFetchCard(msg.id, msg.url, msg.host, post, msg.warning)
            : approvalCommandCard(msg.id, msg.command, post, msg.warning, msg.always);
      approvals.set(msg.id, add(card, currentTurn()));
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      activityText.textContent = "Ждёт вашего решения…";
      break;
    }
    case "picture":
      flushText();
      textEl = null;
      add(pictureCard(msg.relPath, post), currentTurn());
      post({ type: "load_picture", relPath: msg.relPath });
      break;
    case "picture_data":
      for (const card of log.querySelectorAll<HTMLElement>(".picture")) {
        if (card.dataset.path === msg.relPath) showPicture(card, msg.src);
      }
      break;
    case "approval_resolved": {
      const card = approvals.get(msg.id);
      if (card) resolveApproval(card, msg.decision, post);
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
    case "restore":
      handle({ type: "clear" });
      for (const item of msg.items) handle(item);
      flushText();
      textEl = null;
      turnEl = null;
      plan = null;
      log.scrollTop = log.scrollHeight;
      break;
  }
}

void busy;
post({ type: "ready" });
composer.input.focus();
