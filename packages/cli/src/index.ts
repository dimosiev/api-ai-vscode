import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  accessSummary,
  Agent,
  createAccess,
  createProvider,
  DEFAULT_CONTEXT_WINDOW,
  loadRules,
  decryptKeys,
  describeRule,
  describeToolCall,
  formatCost,
  formatTokens,
  GLOBAL_RULES_TEMPLATE,
  defaultGlobalRulesPath,
  UsageTotals,
  type PlanItem,
  type Pricing,
  getPreset,
  maskKey,
  modeLabel,
  parseExtraFolders,
  PRESETS,
  ProjectCommandRules,
  rememberingTrust,
  revealHidden,
  checkBaseUrl,
  CUSTOM_URL_PRESETS,
  type ApprovalHandler,
  type ExtraFolder,
  type Provider,
  type RuleFile,
} from "@dimosi/core";
import { commandRulesStorage, configDir, loadConfig, loadTrustDecisions, migrateLegacyConfig, saveConfig, secureConfigDir, writePrivateFile, type CliConfig } from "./config";
import { EncryptedFileKeyStore, keyFileExists, keyFilePath } from "./keystore";
import { fileSink, log, logFilePath } from "./log";
import { c, Prompter, renderDiff } from "./ui";
import { cmdUpdate, notifyIfOutdated, VERSION } from "./update";


const HELP = `${c.bold("dimosi")} — AI-агент для работы с кодом через ваши API-ключи

${c.bold("Запуск чата")} (в папке проекта):
  dimosi                         открыть чат в текущей папке
  dimosi "задача"                сразу выполнить задачу, затем продолжить чат
  dimosi --dir ПУТЬ              работать с другой папкой
  dimosi --provider polza --model anthropic/claude-opus-5.5
  dimosi --auto                  не спрашивать подтверждений (осторожно!)
  dimosi --no-sandbox            команды без песочницы macOS (осторожно!)
  dimosi --plan                  сначала план: агент ничего не меняет, пока вы не ответите /go
  dimosi --read-dir ПУТЬ         открыть агенту ещё одну папку только для чтения
  dimosi --write-dir ПУТЬ        открыть агенту ещё одну папку для чтения и записи
                                 (оба флага можно повторять; постоянный список —
                                 "extraFolders" в config.json, см. руководство)

${c.bold("Ключи")}:
  dimosi keys set ПРОВАЙДЕР      сохранить API-ключ (например: anthropic, openai, polza)
  dimosi keys list               показать сохранённые ключи
  dimosi keys delete ПРОВАЙДЕР   удалить ключ
  dimosi keys export ФАЙЛ        сохранить все ключи в зашифрованный файл для переноса
  dimosi keys import ФАЙЛ        загрузить ключи из такого файла

${c.bold("Правила")} (агент читает их перед каждым ответом):
  dimosi rules                     показать, какие правила действуют в текущей папке
  dimosi rules global              создать/показать путь к глобальным правилам
  Правила проекта: файлы AGENTS.md, .dimosi/rules.md, .dimosi/rules/*.md

${c.bold("Провайдеры и модели")}:
  dimosi providers               список поддерживаемых провайдеров
  dimosi use ПРОВАЙДЕР [МОДЕЛЬ]  выбрать провайдера (и модель) по умолчанию
  dimosi use custom МОДЕЛЬ --base-url URL   свой OpenAI-совместимый сервер
  dimosi models [ПРОВАЙДЕР]      список моделей провайдера

${c.bold("Обновление")}:
  dimosi update                    установить новую версию с сервера обновлений

${c.bold("Журнал")} (для разбора проблем, без ключей и текста переписки):
  dimosi log                       показать, где лежит журнал, и его последние строки

${c.bold("Команды внутри чата")}: /help /model /models /provider /key /rules /folders /allowed /plan /go /auto /ask /clear /exit
`;

const CHAT_HELP = `${c.bold("Команды:")}
  /model ИМЯ        сменить модель          /models [фильтр]   список моделей
  /provider ИМЯ     сменить провайдера      /key               ввести ключ текущего провайдера
  /auto             работать без подтверждений   /ask   снова спрашивать подтверждения
  /rules            какие правила действуют     /folders           какие папки открыты агенту
  /allowed          команды, запомненные ответом [a] («всегда»); /allowed remove N, /allowed clear
  /plan             сначала план: агент изучает задачу и ничего не меняет (вкл/выкл)
  /go               выполнить показанный план (выключает режим «сначала план»)
  /clear            начать новый диалог     /exit              выйти (или Ctrl+D)
  Ctrl+C во время работы агента — остановить его.`;

interface Flags {
  provider?: string;
  model?: string;
  baseUrl?: string;
  dir?: string;
  auto?: boolean;
  noSandbox?: boolean;
  plan?: boolean;
  /** --read-dir and --write-dir, in the order given. */
  folders: ExtraFolder[];
  positional: string[];
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { positional: [], folders: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`После ${a} нужно значение.`);
      return v;
    };
    if (a === "--provider" || a === "-p") flags.provider = next();
    else if (a === "--model" || a === "-m") flags.model = next();
    else if (a === "--base-url") flags.baseUrl = next();
    else if (a === "--dir" || a === "-d") flags.dir = next();
    else if (a === "--read-dir") flags.folders.push({ path: path.resolve(next()), mode: "read" });
    else if (a === "--write-dir") flags.folders.push({ path: path.resolve(next()), mode: "write" });
    else if (a === "--auto") flags.auto = true;
    else if (a === "--plan") flags.plan = true;
    else if (a === "--no-sandbox") flags.noSandbox = true;
    else if (a === "--help" || a === "-h") flags.positional.unshift("help");
    else if (a === "--version" || a === "-v") flags.positional.unshift("version");
    else flags.positional.push(a);
  }
  return flags;
}

function fail(message: string): never {
  log.error(`exit with error: ${message}`);
  console.error(c.red(`Ошибка: ${message}`));
  process.exit(1);
}

// ---------- key access ----------

class Keys {
  private store?: EncryptedFileKeyStore;
  constructor(private io: Prompter) {}

  /** Unlocks (or creates) the encrypted key file, asking for its password once. */
  async open(createIfMissing: boolean): Promise<EncryptedFileKeyStore | undefined> {
    if (this.store) return this.store;
    const exists = await keyFileExists();
    if (!exists && !createIfMissing) return undefined;
    let password = process.env.DIMOSI_PASSWORD ?? "";
    if (!password) {
      if (exists) {
        password = (await this.io.ask("Пароль от хранилища ключей: ", { hidden: true })) ?? "";
      } else {
        console.log(c.dim(`Создаю хранилище ключей: ${keyFilePath()}`));
        console.log(c.dim("Придумайте пароль — он будет нужен при каждом запуске и при переносе ключей."));
        password = (await this.io.ask("Новый пароль: ", { hidden: true })) ?? "";
        const again = (await this.io.ask("Повторите пароль: ", { hidden: true })) ?? "";
        if (password !== again) fail("Пароли не совпадают.");
      }
    }
    if (!password) fail("Пароль не может быть пустым.");
    try {
      this.store = await EncryptedFileKeyStore.open(password);
    } catch (e) {
      fail((e as Error).message === "Wrong password, or the file is damaged." ? "Неверный пароль." : (e as Error).message);
    }
    return this.store;
  }

  async get(presetId: string): Promise<string | undefined> {
    const preset = getPreset(presetId);
    const key = preset.envVar && process.env[preset.envVar] ? process.env[preset.envVar] : await (await this.open(false))?.get(presetId);
    log.addSecret(key); // masked if a server ever echoes it back
    return key;
  }

  async ask(presetId: string): Promise<string> {
    const preset = getPreset(presetId);
    const key = await this.io.ask(`API-ключ для ${preset.label}: `, { hidden: true });
    if (!key) fail("Ключ не введён.");
    log.addSecret(key);
    const store = await this.open(true);
    await store!.set(presetId, key);
    console.log(c.green(`Ключ для ${preset.label} сохранён (${maskKey(key)}).`));
    return key;
  }
}

async function makeProvider(presetId: string, config: CliConfig, keys: Keys, interactive: boolean): Promise<Provider> {
  const preset = getPreset(presetId);
  let key = await keys.get(presetId);
  if (!key && preset.requiresKey) {
    if (!interactive) fail(`Нет API-ключа для ${preset.label}. Выполните: dimosi keys set ${presetId}`);
    console.log(c.yellow(`Для ${preset.label} ещё нет ключа.`));
    key = await keys.ask(presetId);
  }
  return createProvider({ presetId, apiKey: key, baseURL: config.baseUrls[presetId] });
}

function modelFor(presetId: string, config: CliConfig): string {
  const model = config.models[presetId] || getPreset(presetId).defaultModel;
  if (!model) fail(`Не задана модель для ${presetId}. Выполните: dimosi use ${presetId} ИМЯ_МОДЕЛИ`);
  return model;
}

// ---------- commands ----------

async function cmdKeys(args: string[], io: Prompter): Promise<void> {
  const [sub, arg] = args;
  const keys = new Keys(io);
  switch (sub) {
    case "set": {
      if (!arg) fail("Укажите провайдера, например: dimosi keys set polza");
      getPreset(arg);
      await keys.ask(arg);
      return;
    }
    case "list": {
      const store = await keys.open(false);
      const names = store ? await store.list() : [];
      if (!names.length) console.log("Сохранённых ключей нет.");
      for (const name of names) console.log(`  ${name.padEnd(12)} ${maskKey((await store!.get(name)) ?? "")}`);
      for (const p of PRESETS) {
        if (p.envVar && process.env[p.envVar]) console.log(`  ${p.id.padEnd(12)} из переменной окружения ${p.envVar}`);
      }
      return;
    }
    case "delete": {
      if (!arg) fail("Укажите провайдера.");
      const store = await keys.open(false);
      if (!store || !(await store.get(arg))) fail(`Ключа для ${arg} нет.`);
      await store.delete(arg);
      console.log(`Ключ ${arg} удалён.`);
      return;
    }
    case "export": {
      if (!arg) fail("Укажите имя файла, например: dimosi keys export ~/Desktop/keys.aienc");
      if (!(await keyFileExists())) fail("Сохранённых ключей нет.");
      await keys.open(false); // verifies the password before copying
      await fs.copyFile(keyFilePath(), path.resolve(arg));
      console.log(c.green(`Ключи сохранены в ${path.resolve(arg)}.`));
      console.log("Файл зашифрован тем же паролем, что и хранилище. Его можно загрузить и в расширение VS Code: команда «dimosi: Импортировать ключи из файла…».");
      return;
    }
    case "import": {
      if (!arg) fail("Укажите файл с ключами.");
      const text = await fs.readFile(path.resolve(arg), "utf8").catch(() => fail(`Не удалось прочитать ${arg}.`));
      const password = process.env.DIMOSI_IMPORT_PASSWORD ?? (await io.ask("Пароль этого файла: ", { hidden: true })) ?? "";
      let imported: Record<string, string>;
      try {
        imported = decryptKeys(text, password);
      } catch {
        fail("Неверный пароль или повреждённый файл.");
      }
      if (!(await keyFileExists())) {
        // First key file on this machine: adopt it as is, with the same password.
        await writePrivateFile(keyFilePath(), text);
      } else {
        const store = await keys.open(false);
        for (const [name, value] of Object.entries(imported)) await store!.set(name, value);
      }
      console.log(c.green(`Импортировано ключей: ${Object.keys(imported).length} (${Object.keys(imported).join(", ")}).`));
      return;
    }
    default:
      fail("Неизвестная команда. Варианты: keys set | list | delete | export | import");
  }
}

/** Known services keep their own address: a different one would receive the key. */
function checkedBaseUrl(presetId: string, url: string): string {
  if (!CUSTOM_URL_PRESETS.includes(presetId)) fail(`--base-url можно задать только для ${CUSTOM_URL_PRESETS.join(" и ")}. У ${getPreset(presetId).label} свой адрес.`);
  try {
    checkBaseUrl(url);
  } catch (e) {
    fail((e as Error).message);
  }
  return url;
}

async function cmdUse(args: string[], flags: Flags): Promise<void> {
  const [presetId, model] = args;
  if (!presetId) fail("Укажите провайдера: " + PRESETS.map((p) => p.id).join(", "));
  const preset = getPreset(presetId);
  const config = await loadConfig();
  config.provider = presetId;
  if (model) config.models[presetId] = model;
  if (flags.baseUrl) config.baseUrls[presetId] = checkedBaseUrl(presetId, flags.baseUrl);
  if (presetId === "custom" && !config.baseUrls.custom) fail("Для custom нужен адрес: --base-url https://...");
  await saveConfig(config);
  console.log(c.green(`По умолчанию: ${preset.label}, модель ${config.models[presetId] || preset.defaultModel || "(не задана)"}.`));
}

async function cmdProviders(): Promise<void> {
  const config = await loadConfig();
  for (const p of PRESETS) {
    const current = p.id === config.provider ? c.green(" ← выбран") : "";
    const model = config.models[p.id] || p.defaultModel || "—";
    console.log(`  ${c.bold(p.id.padEnd(11))} ${p.label.padEnd(26)} модель: ${model}${current}`);
  }
}

async function cmdModels(args: string[], io: Prompter): Promise<void> {
  const config = await loadConfig();
  const presetId = args[0] ?? config.provider;
  const provider = await makeProvider(presetId, config, new Keys(io), true);
  const models = await provider.listModels();
  console.log(models.join("\n") || "Провайдер не вернул список моделей.");
}

function printPlan(items: PlanItem[]): void {
  console.log(c.bold("План:"));
  for (const item of items) {
    const mark = item.status === "done" ? c.green("✓") : item.status === "in_progress" ? c.yellow("▸") : c.dim("○");
    const title = item.status === "done" ? c.dim(item.title) : item.status === "in_progress" ? c.bold(item.title) : item.title;
    console.log(`  ${mark} ${title}`);
  }
}

async function printRules(root: string): Promise<void> {
  const decisions = await loadTrustDecisions();
  const rules = await loadRules(root, undefined, { isTrusted: async (f) => decisions.get(f.hash) ?? false });
  if (!rules.sources.length) {
    console.log("Правил пока нет.");
  } else {
    console.log(c.bold("Файлы правил:"));
    for (const r of rules.sources) {
      const note = r.skipped
        ? c.yellow(decisions.get(r.hash!) === false ? " (не подключён: вы не доверяете)" : " (не подключён: dimosi спросит при следующей задаче)")
        : r.truncated ? c.yellow(" (обрезано)") : "";
      console.log(`  ${r.scope === "global" ? "🌐" : "📁"} ${r.label}  ${c.dim(r.path)}${note}`);
    }
  }
  console.log(c.dim(`Глобальные: ${defaultGlobalRulesPath()}. Проектные: AGENTS.md, .dimosi/rules.md, .dimosi/rules/*.md`));
}

async function cmdRules(args: string[], flags: Flags): Promise<void> {
  if (args[0] === "global") {
    const p = defaultGlobalRulesPath();
    try {
      await fs.access(p);
    } catch {
      await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
      await fs.writeFile(p, GLOBAL_RULES_TEMPLATE, { encoding: "utf8", mode: 0o600 });
      console.log(c.green("Создан файл глобальных правил из шаблона."));
    }
    console.log(`Глобальные правила: ${p}`);
    console.log(c.dim("Откройте его в любом текстовом редакторе и впишите свои правила."));
    return;
  }
  await printRules(path.resolve(flags.dir ?? process.cwd()));
}

async function cmdLog(): Promise<void> {
  const file = logFilePath();
  const text = await fs.readFile(file, "utf8").catch(() => "");
  console.log(c.dim(`Журнал: ${file}`));
  console.log(text.trimEnd().split("\n").slice(-40).join("\n") || "Журнал пока пуст.");
}

/** Shows a project's AGENTS.md / CLAUDE.md and asks whether to follow it. Enter alone means "not now". */
async function askAboutRules(io: Prompter, file: RuleFile): Promise<boolean | undefined> {
  const lines = file.text.split("\n");
  console.log();
  console.log(c.yellow(c.bold(`В проекте найден ${file.label} (впервые или изменился): ${file.path}`)));
  console.log(c.dim("Его текст станет указаниями для агента. В чужом проекте там могут быть вредные указания."));
  console.log(lines.slice(0, 40).map((l) => `  │ ${l}`).join("\n"));
  if (lines.length > 40) console.log(c.dim(`  │ ... ещё ${lines.length - 40} строк, полностью: ${file.path}`));
  const answer = ((await io.ask(c.yellow(`Доверять правилам из ${file.label}? [y] да / [n] нет: `))) ?? "").toLowerCase();
  if (["y", "yes", "д", "да"].includes(answer)) return true;
  if (["n", "no", "н", "нет"].includes(answer)) return false;
  return undefined;
}

// ---------- chat ----------

async function chat(flags: Flags, io: Prompter): Promise<void> {
  const config = await loadConfig();
  let presetId = flags.provider ?? config.provider;
  getPreset(presetId);
  if (flags.baseUrl) config.baseUrls[presetId] = checkedBaseUrl(presetId, flags.baseUrl);
  const root = path.resolve(flags.dir ?? process.cwd());
  const keys = new Keys(io);
  let controller: AbortController | undefined;
  const commandRules = new ProjectCommandRules(root, commandRulesStorage);
  // This run's flags first: the same folder in config.json does not override them.
  const extraFolders = [...flags.folders, ...parseExtraFolders(config.extraFolders)];
  const printAccess = () => {
    const access = createAccess(root, extraFolders);
    console.log(c.dim(`Доступ: ${accessSummary(access)}`));
    for (const f of access.folders) console.log(c.dim(`  ${f.path} — ${modeLabel(f.mode)}`));
    for (const f of access.rejected) {
      if (f.reason !== "уже есть в списке") console.log(c.yellow(`  ${f.path} — не подключена: ${f.reason}`));
    }
  };

  const approval: ApprovalHandler = {
    async approve(req) {
      console.log();
      const warning = req.warning;
      if (req.kind === "write") {
        const relPath = revealHidden(req.relPath);
        console.log(c.yellow(c.bold(req.oldContent === null ? `Создать файл ${relPath}` : `Изменить файл ${relPath}`)));
        if (warning) console.log(c.red(c.bold(`⚠ ${warning} Такой файл dimosi всегда показывает отдельно, даже без подтверждений.`)));
        console.log(renderDiff(relPath, req.oldContent === null ? null : revealHidden(req.oldContent), revealHidden(req.newContent)));
      } else {
        console.log(c.yellow(c.bold("Выполнить команду:")));
        if (warning) console.log(c.red(c.bold(`⚠ ${warning} Такую команду dimosi всегда показывает отдельно, даже без подтверждений.`)));
        console.log(`  $ ${revealHidden(req.command)}`);
      }
      const question = warning
        ? "Разрешить? [y] да / [n] нет: "
        : req.kind === "write"
          ? "Разрешить? [y] да / [n] нет / [a] да, и не спрашивать про файлы до конца сессии: "
          : `Разрешить? [y] да / [n] нет / [a] да, и больше не спрашивать в этом проекте про ${req.always?.kind === "prefix" ? `команды «${req.always.text} …»` : "эту же команду"}: `;
      const answer = ((await io.ask(c.yellow(question), { signal: controller?.signal })) ?? "").toLowerCase();
      if (["a", "а", "always", "всегда", "в"].includes(answer)) return warning ? "allow" : "allow_always";
      if (["y", "yes", "д", "да"].includes(answer)) return "allow";
      return "deny";
    },
  };

  const agent = new Agent({
    provider: await makeProvider(presetId, config, keys, true),
    model: flags.model ?? modelFor(presetId, config),
    root,
    approval,
    mode: flags.auto ? "auto" : config.mode,
    sandbox: !flags.noSandbox,
    commandRules,
    extraFolders,
    contextWindow: getPreset(presetId).contextWindow,
    log,
    ruleTrust: rememberingTrust(await loadTrustDecisions(), (file) => askAboutRules(io, file)),
  });
  agent.planFirst = Boolean(flags.plan);
  log.info(`chat: provider ${presetId}, model ${agent.model}, approvals ${agent.gate.mode}, sandbox ${agent.sandbox ? "on" : "off"}, extra folders ${extraFolders.length}`);

  console.log(`${c.bold(c.blue("dimosi"))} ${c.dim(VERSION)}  ${getPreset(presetId).label} · ${c.cyan(agent.model)}`);
  console.log(c.dim(`Проект: ${root}`));
  if (extraFolders.length) printAccess();
  if (agent.planFirst) console.log(c.cyan("Режим «сначала план»: агент покажет план и ничего не изменит. /go — выполнить план."));
  if (agent.gate.mode === "auto") console.log(c.red("Режим без подтверждений: агент сам меняет файлы и запускает команды."));
  if (!agent.sandbox && process.platform === "darwin") console.log(c.red("Песочница выключена: команды агента работают со всеми вашими правами."));
  console.log(c.dim("Напишите задачу. /help — команды, Ctrl+C — остановить агента, /exit — выход.\n"));

  io.rl.on("SIGINT", () => {
    if (controller) controller.abort();
    else io.rl.close();
  });

  let lastRulesKey = "";
  const chatUsage = new UsageTotals();

  const runTurn = async (text: string) => {
    controller = new AbortController();
    let atLineStart = true;
    const usage = new UsageTotals();
    const newline = () => {
      if (!atLineStart) process.stdout.write("\n");
      atLineStart = true;
    };
    try {
      for await (const ev of agent.run(text, controller.signal)) {
        switch (ev.type) {
          case "rules": {
            // Mention rules when they first appear or change, not on every message.
            const key = ev.sources.map((r) => `${r.path}:${r.chars}`).join("|");
            if (key !== lastRulesKey) {
              lastRulesKey = key;
              if (ev.sources.length) console.log(c.dim(`Правила: ${ev.sources.map((r) => r.label).join(", ")}`));
            }
            break;
          }
          case "text":
            process.stdout.write(ev.text);
            atLineStart = ev.text.endsWith("\n");
            break;
          case "tool_start":
            if (ev.call.name === "update_plan") break;
            newline();
            console.log(c.blue(`● ${describeToolCall(ev.call)}`));
            break;
          case "plan":
            newline();
            printPlan(ev.items);
            break;
          case "tool_end": {
            if (ev.call.name === "update_plan" && !ev.isError) break;
            const first = ev.result.split("\n")[0].slice(0, 160);
            console.log(ev.isError ? c.red(`  ✗ ${first}`) : c.dim(`  ✓ ${first}`));
            break;
          }
          case "usage":
            usage.add(ev.usage);
            chatUsage.add(ev.usage);
            break;
          case "error":
            newline();
            console.log(c.red(ev.message));
            break;
          case "file_changed":
          case "done":
            break;
        }
      }
    } finally {
      controller = undefined;
    }
    newline();
    if (agent.planFirst) console.log(c.cyan("План готов, ничего не изменено. /go — выполнить, или напишите, что поправить. /plan — выключить режим."));
    if (usage.totalInput || usage.output) {
      const pricing: Pricing | undefined = await agent.provider.getPricing?.(agent.model).catch(() => undefined);
      const cost = formatCost(usage.cost(pricing));
      const total = formatCost(chatUsage.cost(pricing));
      console.log(
        c.dim(
          `токены: вход ${formatTokens(usage.totalInput)}, выход ${formatTokens(usage.output)}` +
            (cost ? ` · ≈ ${cost} (за чат ≈ ${total})` : "") +
            ` · контекст ${formatTokens(usage.lastContext)}`,
        ),
      );
    }
    console.log();
  };

  const handleSlash = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "exit":
      case "quit":
        return false;
      case "help":
        console.log(CHAT_HELP);
        break;
      case "rules":
        await printRules(root);
        break;
      case "folders":
        printAccess();
        break;
      case "plan":
        agent.planFirst = !agent.planFirst;
        console.log(agent.planFirst ? c.cyan("Режим «сначала план» включён: агент покажет план и ничего не изменит. /go — выполнить план.") : c.dim("Режим «сначала план» выключен."));
        break;
      case "go":
        agent.planFirst = false;
        await runTurn("Выполняй план.");
        break;
      case "allowed": {
        const rules = commandRules.list();
        const [action, n] = rest;
        if (action === "clear") {
          await commandRules.clear();
          console.log(c.dim("Запомненных команд больше нет: агент снова спросит про каждую."));
        } else if (action === "remove") {
          const rule = rules[Number(n) - 1];
          if (!rule) {
            console.log(c.red("Укажите номер из списка: /allowed remove 1"));
            break;
          }
          await commandRules.remove(rule);
          console.log(c.dim(`Убрано: ${describeRule(rule)}.`));
        } else if (!rules.length) {
          console.log("Запомненных команд в этом проекте нет. Они появляются после ответа [a] на вопрос о команде.");
        } else {
          console.log(c.bold("Без вопроса в этом проекте выполняются:"));
          rules.forEach((rule, i) => console.log(`  ${i + 1}. ${describeRule(rule)}`));
          console.log(c.dim("Убрать одну: /allowed remove НОМЕР. Убрать все: /allowed clear"));
        }
        break;
      }
      case "clear":
        agent.reset();
        lastRulesKey = "";
        console.log(c.dim("Новый диалог."));
        break;
      case "auto":
        agent.gate.mode = "auto";
        log.info("approvals off");
        console.log(c.red("Подтверждения отключены до конца сессии."));
        break;
      case "ask":
        agent.gate.mode = "ask";
        agent.gate.resetSessionApprovals();
        console.log(c.dim("Агент снова будет спрашивать подтверждения."));
        break;
      case "model":
        if (!arg) {
          console.log(`Текущая модель: ${agent.model}. Сменить: /model ИМЯ (список: /models)`);
          break;
        }
        agent.model = arg;
        log.info(`model changed: ${presetId}/${arg}`);
        config.models[presetId] = arg;
        await saveConfig(config);
        console.log(c.green(`Модель: ${arg}`));
        break;
      case "models": {
        const models = await agent.provider.listModels().catch((e) => {
          console.log(c.red(`Не удалось получить список: ${(e as Error).message}`));
          return [] as string[];
        });
        const filtered = arg ? models.filter((m) => m.toLowerCase().includes(arg.toLowerCase())) : models;
        console.log(filtered.slice(0, 150).join("\n"));
        if (filtered.length > 150) console.log(c.dim(`... и ещё ${filtered.length - 150}. Уточните: /models фильтр`));
        break;
      }
      case "provider":
        if (!arg) {
          console.log(`Текущий: ${presetId}. Доступные: ${PRESETS.map((p) => p.id).join(", ")}`);
          break;
        }
        try {
          getPreset(arg);
          agent.provider = await makeProvider(arg, config, keys, true);
          presetId = arg;
          agent.contextWindow = getPreset(arg).contextWindow ?? DEFAULT_CONTEXT_WINDOW;
          agent.model = modelFor(arg, config);
          config.provider = arg;
          await saveConfig(config);
          log.info(`provider changed: ${arg}/${agent.model}`);
          console.log(c.green(`${getPreset(arg).label} · ${agent.model}`));
        } catch (e) {
          console.log(c.red((e as Error).message));
        }
        break;
      case "key":
        await keys.ask(presetId);
        agent.provider = await makeProvider(presetId, config, keys, true);
        break;
      default:
        console.log(c.red(`Неизвестная команда /${cmd}. /help — список команд.`));
    }
    return true;
  };

  const initial = flags.positional.join(" ").trim();
  if (initial) await runTurn(initial);

  for (;;) {
    const line = await io.ask(c.bold(agent.planFirst ? "план › " : "› "));
    if (line === null) break; // Ctrl+D / input closed
    if (!line) continue;
    if (line.startsWith("/")) {
      if (!(await handleSlash(line))) break;
      continue;
    }
    await runTurn(line);
  }
}

// ---------- entry ----------

async function main(): Promise<void> {
  log.setSink(fileSink());
  const flags = parseArgs(process.argv.slice(2));
  // A known command name only: anything else is the user's task text.
  const known = ["help", "version", "keys", "use", "providers", "rules", "models", "update", "log"];
  const what = known.includes(flags.positional[0]) ? `command "${flags.positional[0]}"` : "chat";
  log.info(`dimosi ${VERSION} started: ${what}, Node ${process.versions.node}, ${process.platform} ${process.arch}`);
  if (await migrateLegacyConfig()) console.log(c.dim(`Настройки и ключи перенесены в ${configDir()}.`));
  await secureConfigDir();
  const [command, ...rest] = flags.positional;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const io = new Prompter(rl);
  try {
    switch (command) {
      case "help":
        console.log(HELP);
        break;
      case "version":
        console.log(VERSION);
        break;
      case "keys":
        await cmdKeys(rest, io);
        break;
      case "use":
        await cmdUse(rest, flags);
        break;
      case "providers":
        await cmdProviders();
        break;
      case "rules":
        await cmdRules(rest, flags);
        break;
      case "models":
        await cmdModels(rest, io);
        break;
      case "update":
        await cmdUpdate();
        break;
      case "log":
        await cmdLog();
        break;
      default:
        await notifyIfOutdated();
        await chat(flags, io);
    }
  } finally {
    rl.close();
  }
}

main().then(
  () => process.exit(0),
  (e) => fail(e instanceof Error ? e.message : String(e)),
);
