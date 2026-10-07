import type { ChangedFileView, ChipView, DiffView, PlanItemView, RuleView } from "../src/protocol";
import { h, svg } from "./dom";
import { ICONS, LOGO, toolIcon } from "./icons";

export type Post = (msg: import("../src/protocol").FromWebview) => void;

const DIFF_COLLAPSED_ROWS = 40;

export function chipEl(chip: ChipView, onRemove?: () => void): HTMLElement {
  const icon = chip.kind === "image" ? ICONS.image : chip.kind === "selection" ? ICONS.code : ICONS.file;
  return h(
    "span",
    { class: `chip chip-${chip.kind}`, title: chip.label },
    svg(icon, "chip-icon"),
    h("span", { class: "chip-label" }, chip.label),
    onRemove && h("button", { class: "chip-x", title: "Убрать", onclick: onRemove }, "×"),
  );
}

export function welcomeCard(needsSetup: boolean, hasFolder: boolean, post: Post, fill: (text: string) => void): HTMLElement {
  const examples = [
    "Расскажи, что делает этот проект и как его запустить",
    "Создай страницу index.html с формой обратной связи",
    "Найди и исправь ошибки в проекте",
  ];
  return h(
    "div",
    { class: "welcome", id: "welcome" },
    svg(LOGO, "welcome-logo"),
    h("div", { class: "welcome-title" }, "dimosi"),
    h("div", { class: "welcome-sub" }, "Агент для работы с кодом. Читает проект, пишет и правит файлы, запускает команды — с вашего разрешения."),
    needsSetup
      ? h(
          "div",
          { class: "welcome-steps" },
          h("div", { class: "welcome-step-title" }, "Чтобы начать, подключите нейросеть:"),
          h("button", { class: "btn primary wide", onclick: () => post({ type: "command", command: "dimosi.selectModel" }) }, "Выбрать сервис и ввести ключ"),
          h("button", { class: "btn wide", onclick: () => post({ type: "command", command: "dimosi.importKeys" }) }, "Импортировать ключи из файла"),
        )
      : !hasFolder
        ? h(
            "div",
            { class: "welcome-steps" },
            h("div", { class: "welcome-step-title" }, "Откройте папку проекта, с которой будет работать агент."),
            h("button", { class: "btn primary wide", onclick: () => post({ type: "command", command: "workbench.action.files.openFolder" }) }, "Открыть папку"),
          )
        : h(
            "div",
            { class: "welcome-examples" },
            h("div", { class: "welcome-step-title" }, "Например:"),
            ...examples.map((e) => h("button", { class: "example", onclick: () => fill(e) }, e)),
            h(
              "div",
              { class: "welcome-hint" },
              "Правила для агента — кнопка ",
              svg(ICONS.book, "inline-icon"),
              " вверху панели. Код можно отправить из редактора: выделите его → правая кнопка → dimosi.",
            ),
          ),
  );
}

export function toolCard(title: string, name: string): HTMLElement {
  return h(
    "div",
    { class: "tool running" },
    h("div", { class: "tool-head" }, svg(toolIcon(name), "tool-icon"), h("span", { class: "tool-title" }, title), h("span", { class: "tool-state" })),
  );
}

export function finishToolCard(card: HTMLElement, result: string, isError: boolean): void {
  card.classList.remove("running");
  card.classList.add(isError ? "error" : "ok");
  const first = result.split("\n")[0].slice(0, 160);
  const details = h("details", { class: "tool-details" }, h("summary", {}, first), h("pre", {}, result));
  card.append(details);
}

export function planCard(): HTMLElement {
  return h("div", { class: "plan" });
}

export function renderPlan(card: HTMLElement, items: PlanItemView[]): void {
  const done = items.filter((i) => i.status === "done").length;
  const fill = h("div", { class: "plan-bar-fill" });
  // Through the style property: the panel's security policy ignores style="" attributes.
  fill.style.width = `${items.length ? (done / items.length) * 100 : 0}%`;
  card.replaceChildren(
    h(
      "div",
      { class: "plan-head" },
      svg(ICONS.plan, "plan-icon"),
      h("span", {}, "План"),
      h("span", { class: "plan-progress" }, `${done}/${items.length}`),
    ),
    h("div", { class: "plan-bar" }, fill),
    h(
      "ol",
      { class: "plan-list" },
      ...items.map((i) =>
        h(
          "li",
          { class: `plan-item ${i.status}` },
          h("span", { class: "plan-mark" }, i.status === "done" ? svg(ICONS.check) : i.status === "in_progress" ? h("span", { class: "plan-dot" }) : ""),
          h("span", {}, i.title),
        ),
      ),
    ),
  );
}

function diffTable(diff: DiffView): HTMLElement {
  const table = h("div", { class: "diff" });
  diff.rows.forEach((r, i) => {
    const row =
      r.t === "hunk"
        ? h("div", { class: "diff-row hunk" }, h("span", { class: "diff-text" }, r.text))
        : h(
            "div",
            { class: `diff-row ${r.t}` },
            h("span", { class: "ln" }, r.t === "add" ? "" : String(r.old ?? "")),
            h("span", { class: "ln" }, r.t === "del" ? "" : String(r.new ?? "")),
            h("span", { class: "sign" }, r.t === "add" ? "+" : r.t === "del" ? "−" : " "),
            h("span", { class: "diff-text" }, r.text || " "),
          );
    if (i >= DIFF_COLLAPSED_ROWS) row.classList.add("extra");
    table.append(row);
  });
  if (diff.rows.length > DIFF_COLLAPSED_ROWS) {
    table.classList.add("collapsed");
    const more = h(
      "button",
      {
        class: "diff-more",
        onclick: () => {
          table.classList.remove("collapsed");
          more.remove();
        },
      },
      `Показать всё (${diff.rows.length} строк)`,
    );
    table.append(more);
  }
  if (diff.truncated) table.append(h("div", { class: "diff-note" }, "Изменение большое — полностью видно в окне сравнения."));
  return table;
}

export function approvalWriteCard(id: string, relPath: string, created: boolean, diff: DiffView, post: Post, warning?: string): HTMLElement {
  return h(
    "div",
    { class: `approval${warning ? " protected" : ""}`, "data-id": id },
    h(
      "div",
      { class: "approval-head" },
      svg(ICONS.edit, "approval-icon"),
      h("span", { class: "approval-title" }, created ? "Создать файл " : "Изменить файл ", h("b", {}, relPath)),
      h("span", { class: "stat" }, h("span", { class: "plus" }, `+${diff.added}`), " ", h("span", { class: "minus" }, `−${diff.removed}`)),
    ),
    warning && h("div", { class: "approval-warning" }, svg(ICONS.warn, "inline-icon"), h("span", {}, `${warning} Такой файл dimosi всегда показывает отдельно, даже без подтверждений. Применяйте, только если понимаете изменение.`)),
    diffTable(diff),
    approvalButtons(
      id,
      post,
      "Применить",
      warning ? undefined : "Больше не спрашивать про запись файлов до конца чата",
      h("button", { class: "btn link", onclick: () => post({ type: "open_diff", id }) }, svg(ICONS.diff, "inline-icon"), "Открыть сравнение"),
    ),
  );
}

type Always = { kind: "prefix" | "exact"; text: string };

const short = (text: string) => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

export function approvalCommandCard(id: string, command: string, post: Post, warning?: string, always?: Always, untilNewChat?: boolean): HTMLElement {
  // Without `always` (a dangerous command) nothing is remembered and there is no "Always" button.
  const remembered = !always ? undefined : always.kind === "prefix" ? `команды, которые начинаются с «${always.text}»` : "эту же команду";
  // A command that reads secret files: remembered until the new chat only, never saved for the project.
  if (untilNewChat && warning && remembered) {
    return h(
      "div",
      { class: "approval protected", "data-id": id },
      h("div", { class: "approval-head" }, svg(ICONS.terminal, "approval-icon"), h("span", { class: "approval-title" }, "Выполнить команду")),
      h("div", { class: "approval-warning" }, svg(ICONS.warn, "inline-icon"), h("span", {}, warning)),
      h("pre", { class: "command" }, `$ ${command}`),
      approvalButtons(id, post, "Выполнить", `До конца этого чата не спрашивать про ${remembered} с этими же файлами. В новом чате dimosi спросит снова.`, undefined, "Запомнить до конца чата"),
    );
  }
  return h(
    "div",
    { class: `approval${warning ? " protected" : ""}`, "data-id": id, "data-remembered": remembered },
    h("div", { class: "approval-head" }, svg(ICONS.terminal, "approval-icon"), h("span", { class: "approval-title" }, "Выполнить команду")),
    warning && h("div", { class: "approval-warning" }, svg(ICONS.warn, "inline-icon"), h("span", {}, `${warning} Такую команду dimosi всегда показывает отдельно, даже без подтверждений. Выполняйте, только если понимаете, что она сделает.`)),
    h("pre", { class: "command" }, `$ ${command}`),
    approvalButtons(
      id,
      post,
      "Выполнить",
      warning || !remembered ? undefined : `Больше не спрашивать в этом проекте про ${remembered}. Запоминается и после перезапуска; посмотреть и убрать: меню «…» панели → «Запомненные команды».`,
      undefined,
      always?.kind === "prefix" ? `Всегда для «${short(always.text)} …»` : "Всегда для этой команды",
    ),
  );
}

export function approvalFetchCard(id: string, url: string, host: string, post: Post, warning?: string): HTMLElement {
  return h(
    "div",
    { class: `approval${warning ? " protected" : ""}`, "data-id": id, "data-remembered": warning ? undefined : `страницы сайта ${host}`, "data-remembered-scope": "во всех проектах" },
    h("div", { class: "approval-head" }, svg(ICONS.terminal, "approval-icon"), h("span", { class: "approval-title" }, "Прочитать страницу в интернете")),
    warning && h("div", { class: "approval-warning" }, svg(ICONS.warn, "inline-icon"), h("span", {}, warning)),
    h("pre", { class: "command" }, url),
    h("div", { class: "approval-note" }, "Агент получит текст страницы. Сайт увидит этот адрес целиком: проверьте, что в нём нет ничего лишнего."),
    approvalButtons(
      id,
      post,
      "Прочитать",
      warning ? undefined : `Больше не спрашивать про страницы сайта ${host}, во всех проектах. Посмотреть и убрать: меню «…» панели → «Запомненные команды».`,
      undefined,
      `Всегда для ${short(host)}`,
    ),
  );
}

export function approvalImageCard(id: string, prompt: string, relPath: string, model: string, post: Post, price?: string, warning?: string): HTMLElement {
  return h(
    "div",
    { class: `approval${warning ? " protected" : ""}`, "data-id": id },
    h("div", { class: "approval-head" }, svg(ICONS.image, "approval-icon"), h("span", { class: "approval-title" }, "Создать картинку ", h("b", {}, relPath))),
    warning && h("div", { class: "approval-warning" }, svg(ICONS.warn, "inline-icon"), h("span", {}, warning)),
    h("pre", { class: "command" }, prompt),
    h(
      "div",
      { class: "approval-note" },
      `Платный запрос к модели ${model} через Polza AI${price ? `: одна картинка стоит ${price}` : ""}. Описание уйдёт сервису, файл сохранится в проект. Спрашивается каждый раз.`,
    ),
    approvalButtons(id, post, "Создать", undefined),
  );
}

/** A picture the agent made: drawn once the extension sends its content. */
export function pictureCard(relPath: string, post: Post): HTMLElement {
  return h(
    "div",
    { class: "picture", "data-path": relPath },
    h("div", { class: "picture-view" }, "Загружаю картинку…"),
    h("button", { class: "change-path", title: "Открыть файл", onclick: () => post({ type: "open_file", relPath }) }, relPath),
  );
}

export function showPicture(card: HTMLElement, src: string | null): void {
  const view = card.querySelector(".picture-view");
  if (!view) return;
  if (!src) {
    view.replaceChildren("Картинку не удалось показать (файл удалён или слишком большой). Нажмите на имя файла, чтобы открыть его.");
    return;
  }
  view.replaceChildren(h("img", { src, alt: card.dataset.path ?? "" }));
}

/** Without `alwaysTitle` there is no "Always" button. */
function approvalButtons(id: string, post: Post, allowLabel: string, alwaysTitle: string | undefined, extra?: HTMLElement, alwaysLabel = "Всегда"): HTMLElement {
  const send = (decision: "allow" | "deny" | "allow_always") => post({ type: "approval_response", id, decision });
  return h(
    "div",
    { class: "approval-actions" },
    h("button", { class: "btn primary", onclick: () => send("allow") }, allowLabel),
    h("button", { class: "btn", onclick: () => send("deny") }, "Отклонить"),
    alwaysTitle && h("button", { class: "btn subtle", title: alwaysTitle, onclick: () => send("allow_always") }, alwaysLabel),
    extra && h("span", { class: "spacer" }),
    extra,
  );
}

export function resolveApproval(card: HTMLElement, decision: "allow" | "deny" | "allow_always", post?: Post): void {
  card.classList.add("resolved", decision === "deny" ? "denied" : "allowed");
  const actions = card.querySelector(".approval-actions");
  const remembered = card.getAttribute("data-remembered");
  const text =
    decision === "deny"
      ? "Отклонено"
      : decision !== "allow_always"
        ? "Разрешено"
        : remembered
          ? `Разрешено. Больше не спрашиваю ${card.getAttribute("data-remembered-scope") ?? "в этом проекте"} про ${remembered}.`
          : "Разрешено (больше не спрашивать до конца чата)";
  actions?.replaceWith(
    h(
      "div",
      { class: "approval-result" },
      svg(decision === "deny" ? ICONS.cross : ICONS.check, "inline-icon"),
      h("span", {}, text),
      decision === "allow_always" && remembered && post
        ? h("button", { class: "btn link", onclick: () => post({ type: "command", command: "dimosi.showCommandRules" }) }, "Запомненные команды")
        : null,
    ),
  );
  card.querySelector(".diff")?.classList.add("collapsed");
  card.querySelector(".diff-more")?.remove();
}

/** After a planning turn: one click switches "plan first" off and starts the work. */
export function planReadyCard(post: Post): HTMLElement {
  const actions = h(
    "div",
    { class: "approval-actions" },
    h(
      "button",
      {
        class: "btn primary",
        onclick: () => {
          actions.remove();
          post({ type: "run_plan" });
        },
      },
      "Выполнить план",
    ),
    h("span", { class: "plan-ready-hint" }, "или напишите, что в плане поправить"),
  );
  return h("div", { class: "plan-ready" }, h("div", { class: "plan-ready-text" }, svg(ICONS.check, "inline-icon"), "План готов. Агент пока ничего не менял."), actions);
}

export function changesCard(turn: number, files: ChangedFileView[], post: Post): HTMLElement {
  const active = files.filter((f) => !f.reverted && !f.unavailable);
  return h(
    "div",
    { class: "changes", "data-turn": String(turn) },
    h(
      "div",
      { class: "changes-head" },
      h("span", {}, `Изменено файлов: ${files.length}`),
      active.length > 1 &&
        h("button", { class: "btn link", onclick: () => post({ type: "revert", turn, relPath: null }) }, svg(ICONS.undo, "inline-icon"), "Откатить все"),
    ),
    ...files.map((f) =>
      h(
        "div",
        { class: `change-row${f.reverted ? " reverted" : ""}` },
        svg(f.created ? ICONS.plus : ICONS.edit, "change-icon"),
        h("button", { class: "change-path", title: "Открыть файл", onclick: () => post({ type: "open_file", relPath: f.relPath }) }, f.relPath),
        h("span", { class: "stat" }, h("span", { class: "plus" }, `+${f.added}`), " ", h("span", { class: "minus" }, `−${f.removed}`)),
        f.reverted
          ? h("span", { class: "muted" }, "откачено")
          : f.unavailable
            ? h("span", { class: "muted", title: "Исходная версия файла не сохранилась: чат был слишком большим" }, "откат недоступен")
            : h("button", { class: "btn link", title: f.created ? "Удалить созданный файл" : "Вернуть версию до агента", onclick: () => post({ type: "revert", turn, relPath: f.relPath }) }, "Откатить"),
      ),
    ),
  );
}

export function rulesChip(all: RuleView[], post: Post): HTMLElement {
  const rules = all.filter((r) => !r.skipped);
  const skipped = all.filter((r) => r.skipped);
  const lines = [
    rules.length ? `Агент следует правилам:\n${rules.map((r) => "• " + r.label).join("\n")}` : "Правил нет — нажмите, чтобы создать",
    skipped.length ? `Не подключены (вы им не доверяете):\n${skipped.map((r) => "• " + r.label).join("\n")}` : "",
  ];
  return h(
    "button",
    {
      class: `chip rules-chip${rules.length ? "" : " empty"}`,
      title: lines.filter(Boolean).join("\n\n"),
      onclick: () => post({ type: "command", command: "dimosi.showRules" }),
    },
    svg(ICONS.book, "chip-icon"),
    h("span", { class: "chip-label" }, (rules.length ? `Правила: ${rules.length}` : "Без правил") + (skipped.length ? ` · не доверено: ${skipped.length}` : "")),
  );
}
