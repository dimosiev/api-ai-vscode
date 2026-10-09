import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHATGPT_HOST_KEY, CHATGPT_KEY, getPreset, readChatGPTAccount } from "@dimosi/core";
import { fakeOpenAI, type FakeOpenAI } from "../../core/test/chatgptFake";
import { signInWithChatGPT, signOutOfChatGPT } from "../src/chatgptLogin";
import { SecretKeyStore } from "../src/keyStore";
import { log } from "../src/log";
import { chooseModel, keyNote, pickProvider } from "../src/modelPicker";
import { buildProvider, MissingKeyError, readSettings, rememberedProvider } from "../src/settings";
import { stub } from "./e2e/vscode";

function keyStore(): SecretKeyStore {
  const state = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  return new SecretKeyStore({
    globalState: { get: <T>(k: string, fallback?: T) => (state.has(k) ? (state.get(k) as T) : fallback), update: async (k: string, v: unknown) => void state.set(k, v) },
    secrets: { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => void secrets.set(k, v), delete: async (k: string) => void secrets.delete(k) },
  } as never);
}

let openai: FakeOpenAI;
let keys: SecretKeyStore;

beforeEach(() => {
  stub.reset();
  stub.config = { "dimosi.provider": "chatgpt" };
  openai = fakeOpenAI();
  keys = keyStore();
  vi.stubGlobal("fetch", openai.fetch);
});

afterEach(() => vi.unstubAllGlobals());

describe("ChatGPT sign-in in the extension", () => {
  it("the command opens the browser, keeps the sign-in in the key store and says whose plan pays", async () => {
    const opened: string[] = [];
    stub.openExternal = async (url) => {
      opened.push(url);
      await openai.browser(url);
      return true;
    };
    await signInWithChatGPT(keys);

    // The address goes to the browser as text and without "+": VS Code re-encodes a parsed one.
    expect(opened[0]).toMatch(/^https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?/);
    expect(opened[0]).toContain("scope=openid%20profile%20email%20offline_access%20resource.invoke%20chatgpt.tokens.use.direct");
    expect(opened[0]).not.toContain("+");
    expect(await readChatGPTAccount(keys)).toMatchObject({ clientId: "oaiapp_issued", accessToken: "access-1" });
    expect(stub.messages.at(-1)).toMatch(/^Вход в ChatGPT выполнен \(owner@example\.com\)\. Запросы dimosi через сервис «ChatGPT \(подписка\)» идут за счёт вашей подписки\. Расход и лимит для dimosi: ChatGPT → Settings/);
    // The tokens are masked in the journal from the first moment.
    expect(log.redact("Bearer access-1 and refresh-1")).not.toMatch(/access-1|refresh-1/);
  });

  it("the user cancels the wait: nothing is saved", async () => {
    stub.openExternal = async () => (stub.cancelProgress(), true);
    await expect(signInWithChatGPT(keys)).rejects.toThrow("Вход отменён.");
    expect(await keys.get(CHATGPT_KEY)).toBeUndefined();
  });

  it("the browser did not open: said at once, without the five-minute wait", async () => {
    stub.openExternal = async () => false;
    await expect(signInWithChatGPT(keys)).rejects.toThrow("Не удалось открыть браузер для входа.");
  });

  it("without a sign-in a task does not start, and the panel offers to sign in", async () => {
    const failure = await buildProvider(readSettings(), keys).catch((e) => e);
    expect(failure).toBeInstanceOf(MissingKeyError);
    expect(failure.message).toBe("Вход в ChatGPT не выполнен.");
  });

  it("the service is not built anew when the tokens are renewed: it remembers what the server refused", async () => {
    stub.openExternal = async (url) => (await openai.browser(url), true);
    await signInWithChatGPT(keys);
    const provider = rememberedProvider();
    const first = await provider(readSettings(), keys);
    // After a restart the saved tokens are masked in the journal as soon as the service is built.
    await keys.set(CHATGPT_KEY, JSON.stringify({ ...(await readChatGPTAccount(keys))!, accessToken: "access-from-disk" }));
    await buildProvider(readSettings(), keys);
    expect(log.redact("access-from-disk")).not.toContain("access-from-disk");
    const account = (await readChatGPTAccount(keys))!;
    await keys.set(CHATGPT_KEY, JSON.stringify({ ...account, accessToken: "access-renewed", refreshToken: "refresh-renewed" }));
    expect(await provider(readSettings(), keys)).toBe(first);
    // And the renewed token is the one that is sent.
    let sent = "";
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      sent = new Headers(init.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ models: [{ slug: "gpt-6.1-sol", visibility: "list" }] }), { headers: { "content-type": "application/json" } });
    });
    expect(await first.listModels()).toEqual(["gpt-6.1-sol"]);
    expect(sent).toBe("Bearer access-renewed");
    // Signed out and in again: a new service.
    await keys.delete(CHATGPT_KEY);
    await expect(provider(readSettings(), keys)).rejects.toBeInstanceOf(MissingKeyError);
  });

  it("choosing the service signs in first instead of asking for a key", async () => {
    stub.openExternal = async (url) => (await openai.browser(url), true);
    const realFetch = openai.fetch;
    vi.stubGlobal("fetch", async (url: unknown, init: RequestInit) =>
      String(url) === "https://api.openai.com/v1/models" ? new Response(JSON.stringify({ models: [{ slug: "gpt-6.1-mini", visibility: "list" }] }), { headers: { "content-type": "application/json" } }) : realFetch(url as string, init),
    );
    let offered: string[] = [];
    stub.pick = (items) => ((offered = items.map((i) => i.label)), items.find((i) => i.label === "gpt-6.1-mini"));
    expect(await chooseModel(keys, "chatgpt", "")).toBe("gpt-6.1-mini");
    expect(offered).toEqual(["$(edit) Ввести имя модели вручную", "gpt-6.1-sol", "gpt-6.1-mini"]);
    expect(await keys.get(CHATGPT_KEY)).toBeDefined();
  });

  it("the list of services tells a sign-in from a key", async () => {
    const preset = getPreset("chatgpt");
    expect(keyNote(preset, false)).toMatch(/^без ключа: вход через браузер/);
    expect(keyNote(preset, true)).toMatch(/^вход выполнен ✓/);
    expect(keyNote(getPreset("polza"), false)).toBe("нужен API-ключ");
    let labels: string[] = [];
    stub.pick = (items) => ((labels = items.map((i) => i.label)), undefined);
    await pickProvider(keys, "?", (p) => p.kind !== "chatgpt" && (p.requiresKey || p.id === "custom"));
    expect(labels).not.toContain("ChatGPT (подписка)");
    await pickProvider(keys, "?");
    expect(labels).toContain("ChatGPT (подписка)");
  });

  it("sign-out removes the sign-in and tells whether OpenAI confirmed it", async () => {
    stub.openExternal = async (url) => (await openai.browser(url), true);
    await signOutOfChatGPT(keys);
    expect(stub.messages.at(-1)).toMatch(/выходить не из чего/);

    await signInWithChatGPT(keys);
    await signOutOfChatGPT(keys);
    expect(openai.revoked).toEqual([{ token: "refresh-1", token_type_hint: "refresh_token", client_id: "oaiapp_issued" }]);
    expect(await keys.get(CHATGPT_KEY)).toBeUndefined();
    expect(await keys.get(CHATGPT_HOST_KEY)).toMatch(/^urn:uuid:/);
    expect(stub.messages.at(-1)).toBe("Вы вышли из ChatGPT: dimosi больше не может тратить подписку.");

    await signInWithChatGPT(keys);
    openai.revocationStatus = 500;
    await signOutOfChatGPT(keys);
    expect(await keys.get(CHATGPT_KEY)).toBeUndefined();
    expect(stub.messages.at(-1)).toMatch(/OpenAI не подтвердил отключение/);
  });
});
