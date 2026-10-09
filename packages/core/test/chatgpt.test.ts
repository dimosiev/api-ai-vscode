import { createHash } from "node:crypto";
import { get } from "node:http";
import { describe, expect, it } from "vitest";
import {
  CHATGPT_HOST_KEY,
  CHATGPT_KEY,
  ChatGPTPlanError,
  ChatGPTSignInError,
  chatgptToken,
  createProvider,
  exportKeys,
  decryptKeys,
  importKeys,
  encryptKeys,
  readChatGPTAccount,
  signInChatGPT,
  signOutChatGPT,
  toResponsesInput,
  type ChatGPTAccount,
  type Message,
  type StreamEvent,
} from "../src";
import { fakeOpenAI, MemoryKeys } from "./chatgptFake";

async function signedIn(expiresInMs = 3600_000): Promise<{ keys: MemoryKeys; account: ChatGPTAccount }> {
  const keys = new MemoryKeys();
  const account: ChatGPTAccount = { clientId: "oaiapp_issued", accessToken: "access-old", refreshToken: "refresh-old", idToken: "id-old", expiresAt: Date.now() + expiresInMs, email: "owner@example.com" };
  await keys.set(CHATGPT_KEY, JSON.stringify(account));
  await keys.set(CHATGPT_HOST_KEY, "urn:uuid:host-1");
  return { keys, account };
}

describe("Sign in with ChatGPT: the sign-in", () => {
  it("first sign-in: registers the app, proves the code with PKCE, saves the checked account", async () => {
    const openai = fakeOpenAI();
    const keys = new MemoryKeys();
    const secrets: string[] = [];
    const account = await signInChatGPT({ keys, fetch: openai.fetch, openBrowser: openai.browser, onSecret: (s) => secrets.push(s) });

    const asked = openai.opened[0];
    expect(asked.origin + asked.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    const q = Object.fromEntries(asked.searchParams);
    expect(q).toMatchObject({
      client_id: "dynamic_agent_client",
      agent_name_hint: "dimosi",
      response_type: "code",
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1",
      code_challenge_method: "S256",
    });
    expect(q.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(q.ext_agent_host_id).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(q.id_token_hint).toBeUndefined();

    // The code is exchanged under the id the callback brought, with the verifier behind the challenge.
    const exchange = openai.tokenForms[0];
    expect(exchange).toMatchObject({ grant_type: "authorization_code", client_id: "oaiapp_issued", code: "code-1", redirect_uri: q.redirect_uri, resource: "https://api.openai.com/v1" });
    expect(createHash("sha256").update(exchange.code_verifier).digest("base64url")).toBe(q.code_challenge);

    expect(account).toMatchObject({ clientId: "oaiapp_issued", accessToken: "access-1", refreshToken: "refresh-1", email: "owner@example.com" });
    expect(account.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
    expect(await readChatGPTAccount(keys)).toEqual(account);
    expect(await keys.get(CHATGPT_HOST_KEY)).toBe(q.ext_agent_host_id);
    expect(secrets).toEqual(expect.arrayContaining(["access-1", "refresh-1"]));
  });

  it("a sign-in that ran out is renewed for the same account and the same installation", async () => {
    const openai = fakeOpenAI();
    const { keys, account } = await signedIn(-1000);
    // A returning sign-in may leave the client id out of the callback.
    openai.callback = (authorize) => ({ code: "code-2", state: authorize.searchParams.get("state")! });
    await signInChatGPT({ keys, fetch: openai.fetch, openBrowser: openai.browser });

    const q = Object.fromEntries(openai.opened[0].searchParams);
    expect(q).toMatchObject({ client_id: "oaiapp_issued", login_hint: "owner@example.com", ext_agent_host_id: "urn:uuid:host-1" });
    expect(q.agent_name_hint).toBeUndefined();
    // The saved token is not put into an address the browser keeps.
    expect(openai.opened[0].href).not.toContain(account.idToken);
    expect(openai.tokenForms[0].client_id).toBe("oaiapp_issued");
    expect((await readChatGPTAccount(keys))?.accessToken).toBe("access-1");
  });

  it("an answer for another app is not accepted for a saved account", async () => {
    const openai = fakeOpenAI();
    const { keys, account } = await signedIn(-1000);
    openai.callback = (authorize) => ({ code: "c", state: authorize.searchParams.get("state")!, client_id: "oaiapp_other" });
    await expect(signInChatGPT({ keys, fetch: openai.fetch, openBrowser: openai.browser })).rejects.toThrow(/для другого приложения/);
    expect(openai.tokenForms).toEqual([]);
    expect(await readChatGPTAccount(keys)).toEqual(account);
  });

  it("a callback with a wrong state is turned away and the wait goes on", async () => {
    const openai = fakeOpenAI();
    const keys = new MemoryKeys();
    let strangerStatus = 0;
    const browser = async (url: string) => {
      const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
      strangerStatus = (await fetch(`${redirect}?code=stolen&state=guess&client_id=oaiapp_evil`)).status;
      expect((await fetch(`${redirect.origin}/other`)).status).toBe(404);
      await openai.browser(url);
    };
    const account = await signInChatGPT({ keys, fetch: openai.fetch, openBrowser: browser });
    expect(strangerStatus).toBe(400);
    expect(account.clientId).toBe("oaiapp_issued");
    expect(openai.tokenForms).toHaveLength(1);
    expect(openai.tokenForms[0].code).toBe("code-1");
  });

  it("consent refused in the browser: nothing is exchanged or saved", async () => {
    const openai = fakeOpenAI();
    const keys = new MemoryKeys();
    openai.callback = (authorize) => ({ error: "access_denied", state: authorize.searchParams.get("state")! });
    await expect(signInChatGPT({ keys, fetch: openai.fetch, openBrowser: openai.browser })).rejects.toThrow(/Вход отменён: доступ в браузере не был разрешён/);
    expect(openai.tokenForms).toEqual([]);
    expect(await keys.get(CHATGPT_KEY)).toBeUndefined();
  });

  it("a refusal carries the service's own words to the user and the journal, but never the code", async () => {
    const openai = fakeOpenAI();
    const notes: string[] = [];
    const attempt = () => signInChatGPT({ keys: new MemoryKeys(), fetch: openai.fetch, openBrowser: openai.browser, onNote: (t) => notes.push(t) });

    openai.callback = (authorize) => ({ error: "access_denied", error_description: "Workspace policy\nforbids apps", state: authorize.searchParams.get("state")! });
    await expect(attempt()).rejects.toThrow("Вход отменён: доступ в браузере не был разрешён. Так OpenAI отвечает и аккаунту без платного тарифа: по подписке работают только Plus и Pro. (Ответ OpenAI: Workspace policy forbids apps)");
    expect(notes).toEqual(["new registration, the browser came back with: error, error_description, state; error access_denied: Workspace policy forbids apps"]);

    notes.length = 0;
    openai.callback = (authorize) => ({ code: "code-secret", state: authorize.searchParams.get("state")!, client_id: "oaiapp_issued" });
    openai.token = () => ({ status: 400, body: { error: "invalid_grant", error_description: "code was issued to another client" } });
    await expect(attempt()).rejects.toThrow("Вход не выполнен: сервис не выдал пропуск (400 invalid_grant: code was issued to another client). Так OpenAI отвечает и аккаунту без платного тарифа: по подписке работают только Plus и Pro.");
    expect(notes).toEqual([
      "new registration, the browser came back with: client_id, code, state; client id of the kind oaiapp_…",
      "token request authorization_code refused: 400 invalid_grant: code was issued to another client",
      "the code was refused; asking once more for the app already registered",
      "sign-in of a registered app, the browser came back with: client_id, code, state; client id of the kind oaiapp_…",
      "token request authorization_code refused: 400 invalid_grant: code was issued to another client",
    ]);
    expect(notes.join()).not.toMatch(/code-secret|oaiapp_issued/);
  });

  it("the code refused right after registration: the browser is asked once more for the issued app, not for a new one", async () => {
    // Seen with a real account on 9 October 2026; OpenAI's sample (sign-in-with-chatgpt-devkit, index.ts) does the same.
    const openai = fakeOpenAI();
    const keys = new MemoryKeys();
    const grant = openai.token;
    let exchanges = 0;
    openai.token = (form) => (++exchanges === 1 ? { status: 400, body: { error: "invalid_grant" } } : grant(form));
    const account = await signInChatGPT({ keys, fetch: openai.fetch, openBrowser: openai.browser });

    expect(openai.opened).toHaveLength(2);
    const [first, second] = openai.opened.map((u) => Object.fromEntries(u.searchParams));
    expect(first).toMatchObject({ client_id: "dynamic_agent_client", agent_name_hint: "dimosi" });
    expect(second.client_id).toBe("oaiapp_issued");
    expect(second.agent_name_hint).toBeUndefined();
    expect(second.ext_agent_host_id).toBe(first.ext_agent_host_id);
    // Nothing of the first attempt is used again.
    for (const fresh of ["state", "nonce", "code_challenge"] as const) expect(second[fresh]).not.toBe(first[fresh]);
    expect(openai.tokenForms[1]).toMatchObject({ grant_type: "authorization_code", client_id: "oaiapp_issued", redirect_uri: second.redirect_uri });
    expect(openai.tokenForms[1].code_verifier).not.toBe(openai.tokenForms[0].code_verifier);
    expect(account.accessToken).toBe("access-1");
    expect(await readChatGPTAccount(keys)).toEqual(account);
  });

  it("the code refused twice: no third trip to the browser, nothing saved", async () => {
    const openai = fakeOpenAI();
    const keys = new MemoryKeys();
    openai.token = () => ({ status: 400, body: { error: "invalid_grant" } });
    await expect(signInChatGPT({ keys, fetch: openai.fetch, openBrowser: openai.browser })).rejects.toThrow("Вход не выполнен: сервис не выдал пропуск (400 invalid_grant). Так OpenAI отвечает и аккаунту без платного тарифа: по подписке работают только Plus и Pro.");
    expect(openai.opened).toHaveLength(2);
    expect(await keys.get(CHATGPT_KEY)).toBeUndefined();
  });

  it("a request that does not address the listener by its own number is turned away", async () => {
    const openai = fakeOpenAI();
    let status = 0;
    const browser = async (url: string) => {
      const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
      const state = new URL(url).searchParams.get("state");
      // The same listener reached under another name, as a page of a hostile site would reach it.
      status = await new Promise<number>((resolve, reject) =>
        get({ host: "127.0.0.1", port: redirect.port, path: `/auth/callback?code=x&state=${state}&client_id=oaiapp_evil`, headers: { host: "evil.example" } }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on("error", reject),
      );
      await openai.browser(url);
    };
    const account = await signInChatGPT({ keys: new MemoryKeys(), fetch: openai.fetch, openBrowser: browser });
    expect(status).toBe(404);
    expect(account.clientId).toBe("oaiapp_issued");
  });

  it("a sign-in without the right to use the plan is not saved", async () => {
    const openai = fakeOpenAI();
    const keys = new MemoryKeys();
    const grant = openai.token;
    openai.token = (form) => ({ body: { ...grant(form).body, scope: "openid profile email offline_access" } });
    await expect(signInChatGPT({ keys, fetch: openai.fetch, openBrowser: openai.browser })).rejects.toThrow(/не разрешил использовать подписку/);
    expect(await keys.get(CHATGPT_KEY)).toBeUndefined();
  });

  it.each([
    ["signed by someone else", (o: ReturnType<typeof fakeOpenAI>) => o.idToken({}, "stranger"), /подпись неверна/],
    ["from another sign-in attempt", (o: ReturnType<typeof fakeOpenAI>) => o.idToken({ nonce: "other" }), /не от этой попытки входа/],
    ["issued to another app", (o: ReturnType<typeof fakeOpenAI>) => o.idToken({ aud: "oaiapp_other" }), /другому приложению/],
    ["expired", (o: ReturnType<typeof fakeOpenAI>) => o.idToken({ exp: Math.floor(Date.now() / 1000) - 3600 }), /срок истёк/],
    ["not from OpenAI", (o: ReturnType<typeof fakeOpenAI>) => o.idToken({ iss: "https://evil.example" }), /выдан не OpenAI/],
  ])("an ID token %s is refused and nothing is saved", async (_name, forge, message) => {
    const openai = fakeOpenAI();
    const keys = new MemoryKeys();
    const grant = openai.token;
    openai.token = (form) => ({ body: { ...grant(form).body, id_token: forge(openai) } });
    await expect(signInChatGPT({ keys, fetch: openai.fetch, openBrowser: openai.browser })).rejects.toThrow(message);
    expect(await keys.get(CHATGPT_KEY)).toBeUndefined();
  });

  it("the user gives up: the wait ends and the listener is closed", async () => {
    const openai = fakeOpenAI();
    const stop = new AbortController();
    let redirect = "";
    const attempt = signInChatGPT({
      keys: new MemoryKeys(),
      fetch: openai.fetch,
      signal: stop.signal,
      openBrowser: (url) => {
        redirect = new URL(url).searchParams.get("redirect_uri")!;
        stop.abort();
      },
    });
    await expect(attempt).rejects.toThrow("Вход отменён.");
    await expect(fetch(redirect)).rejects.toThrow();
  });

  it("no answer from the browser in time: a clear error", async () => {
    const openai = fakeOpenAI();
    await expect(signInChatGPT({ keys: new MemoryKeys(), fetch: openai.fetch, openBrowser: () => {}, timeoutMs: 20 })).rejects.toThrow(/ответ из браузера не пришёл/);
  });
});

describe("Sign in with ChatGPT: the access token", () => {
  it("a token that is still good is used without asking the service", async () => {
    const openai = fakeOpenAI();
    const { keys } = await signedIn();
    expect(await chatgptToken({ keys, fetch: openai.fetch })()).toBe("access-old");
    expect(openai.tokenForms).toEqual([]);
  });

  it("a token about to end is renewed once, and the changed refresh token is saved", async () => {
    const openai = fakeOpenAI();
    const { keys } = await signedIn(60_000);
    const token = chatgptToken({ keys, fetch: openai.fetch });
    expect(await Promise.all([token(), token(), token()])).toEqual(["access-1", "access-1", "access-1"]);
    expect(openai.tokenForms).toEqual([{ grant_type: "refresh_token", client_id: "oaiapp_issued", refresh_token: "refresh-old", resource: "https://api.openai.com/v1" }]);
    expect(await readChatGPTAccount(keys)).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", clientId: "oaiapp_issued", email: "owner@example.com" });
    // The next request uses what was saved.
    expect(await token()).toBe("access-1");
    expect(openai.tokenForms).toHaveLength(1);
  });

  it("another window renewed first: its tokens are used and the sign-in is kept", async () => {
    const openai = fakeOpenAI();
    const { keys, account } = await signedIn(60_000);
    openai.token = () => {
      // The other window's renewal lands while this one is on its way.
      keys.data.set(CHATGPT_KEY, JSON.stringify({ ...account, accessToken: "access-theirs", refreshToken: "refresh-theirs", expiresAt: Date.now() + 3600_000 }));
      return { status: 400, body: { error: "refresh_token_reused" } };
    };
    expect(await chatgptToken({ keys, fetch: openai.fetch })()).toBe("access-theirs");
    expect((await readChatGPTAccount(keys))?.refreshToken).toBe("refresh-theirs");
  });

  it.each(["invalid_grant", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"])("the service ended the sign-in (%s): it is forgotten and the user is told to sign in", async (code) => {
    const openai = fakeOpenAI();
    const { keys } = await signedIn(-1000);
    openai.token = () => ({ status: 400, body: { error: { code, message: "no" } } });
    const failure = await chatgptToken({ keys, fetch: openai.fetch })().catch((e) => e);
    expect(failure).toBeInstanceOf(ChatGPTSignInError);
    expect(failure.message).toMatch(/Войти через ChatGPT/);
    expect(await keys.get(CHATGPT_KEY)).toBeUndefined();
    expect(await keys.get(CHATGPT_HOST_KEY)).toBe("urn:uuid:host-1");
  });

  it("a passing failure of the sign-in service does not cost the sign-in", async () => {
    const openai = fakeOpenAI();
    const { keys, account } = await signedIn(-1000);
    openai.token = () => ({ status: 503, body: { error: "temporarily_unavailable" } });
    const failure = await chatgptToken({ keys, fetch: openai.fetch })().catch((e) => e);
    expect(failure).not.toBeInstanceOf(ChatGPTSignInError);
    expect(failure.message).toMatch(/Не удалось продлить вход в ChatGPT \(503 temporarily_unavailable\)/);
    expect(await readChatGPTAccount(keys)).toEqual(account);
  });

  it("without a sign-in there is no token", async () => {
    await expect(chatgptToken({ keys: new MemoryKeys(), fetch: fakeOpenAI().fetch })()).rejects.toBeInstanceOf(ChatGPTSignInError);
  });

  it("sign-out: the service is asked to end the session, the sign-in is removed, the installation id stays", async () => {
    const openai = fakeOpenAI();
    const { keys } = await signedIn();
    expect(await signOutChatGPT({ keys, fetch: openai.fetch })).toEqual({ revoked: true });
    expect(openai.revoked).toEqual([{ token: "refresh-old", token_type_hint: "refresh_token", client_id: "oaiapp_issued" }]);
    expect(await keys.get(CHATGPT_KEY)).toBeUndefined();
    expect(await keys.get(CHATGPT_HOST_KEY)).toBe("urn:uuid:host-1");
  });

  it("sign-out the service did not confirm still removes the sign-in and says so", async () => {
    const openai = fakeOpenAI();
    const { keys } = await signedIn();
    openai.revocationStatus = 503;
    expect(await signOutChatGPT({ keys, fetch: openai.fetch })).toEqual({ revoked: false });
    expect(await keys.get(CHATGPT_KEY)).toBeUndefined();
  });

  it("the sign-in never goes into a key file and is never taken from one", async () => {
    const { keys } = await signedIn();
    await keys.set("polza", "pz-key-123456");
    expect(decryptKeys(await exportKeys(keys, "password"), "password")).toEqual({ polza: "pz-key-123456" });
    const other = new MemoryKeys();
    expect(await importKeys(other, encryptKeys({ polza: "pz", chatgpt: "{}", "chatgpt-host": "urn:uuid:x" }, "password"), "password")).toEqual(["polza"]);
    expect(await other.list()).toEqual(["polza"]);
  });
});

// ---------- the service ----------

const sse = (events: Array<Record<string, unknown>>) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

const refused = (status: number, code: string, message = "refused", param?: string) =>
  new Response(JSON.stringify({ error: { message, code, param, type: "invalid_request_error" } }), { status, headers: { "content-type": "application/json" } });

const REASONING = { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "ENCRYPTED" };
const TEXT = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Читаю.", annotations: [] }] };
const CALL = { id: "fc_1", type: "function_call", status: "completed", call_id: "call_abc", name: "read_file", arguments: '{"path":"a.txt"}' };

const reply = (items: Array<Record<string, unknown>>, usage?: Record<string, unknown>) =>
  sse([
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    { type: "response.output_text.delta", delta: "Чи" },
    { type: "response.output_text.delta", delta: "таю." },
    ...items.map((item) => ({ type: "response.output_item.done", item })),
    { type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage } },
  ]);

function service(answers: Array<Response | (() => Response)>, token: () => Promise<string> = async () => "access-1") {
  const requests: Array<{ url: string; auth: string | null; body: any }> = [];
  const fetchMock = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { provider: createProvider({ presetId: "chatgpt", token, fetch: fetchMock }), requests };
}

async function collect(it: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const TOOLS = [{ name: "read_file", description: "Reads a file", inputSchema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } }];
const ask = (messages: Message[], extra: object = {}) => ({ model: "gpt-6.1-sol", system: "SYSTEM", messages, tools: TOOLS, maxTokens: 64000, ...extra });
const USER: Message = { role: "user", parts: [{ type: "text", text: "прочитай a.txt" }] };

describe("ChatGPT plan: the service (Responses API)", () => {
  it("sends a stateless streaming request in the form the preview accepts, and reads the reply", async () => {
    const { provider, requests } = service([reply([REASONING, TEXT, CALL], { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 50 })]);
    const events = await collect(provider.stream(ask([USER])));

    expect(requests[0].url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0].auth).toBe("Bearer access-1");
    const body = requests[0].body;
    expect(body).toMatchObject({ model: "gpt-6.1-sol", instructions: "SYSTEM", store: false, stream: true, include: ["reasoning.encrypted_content"] });
    expect(body.input).toEqual([{ role: "user", content: "прочитай a.txt" }]);
    expect(body.tools).toEqual([{ type: "function", name: "read_file", description: "Reads a file", parameters: TOOLS[0].inputSchema, strict: false }]);
    // The preview refuses these fields, and the effort is sent only when the user set it.
    for (const field of ["max_output_tokens", "temperature", "top_p", "previous_response_id", "truncation", "metadata", "user", "reasoning"]) expect(body).not.toHaveProperty(field);
    expect(JSON.stringify(body.input)).not.toContain('"system"');

    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text)).toEqual(["Чи", "таю."]);
    const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>;
    expect(done.stopReason).toBe("tool_use");
    expect(done.message.parts).toEqual([
      { type: "text", text: "Читаю." },
      { type: "tool_call", id: "call_abc", name: "read_file", input: { path: "a.txt" } },
    ]);
    expect(done.message.providerData).toEqual({ provider: "chatgpt", model: "gpt-6.1-sol", raw: [REASONING, TEXT, CALL] });
    expect(done.usage).toEqual({ inputTokens: 200, outputTokens: 50, cacheReadTokens: 800 });
    expect(done.effortIgnored).toBeUndefined();
  });

  it("the model's own output goes back as it came, with its reasoning, only without the server ids", () => {
    const history: Message[] = [
      USER,
      { role: "assistant", parts: [{ type: "text", text: "Читаю." }, { type: "tool_call", id: "call_abc", name: "read_file", input: { path: "a.txt" } }], providerData: { provider: "chatgpt", model: "gpt-6.1-sol", raw: [REASONING, TEXT, CALL] } },
      { role: "user", parts: [{ type: "tool_result", toolCallId: "call_abc", content: "1\thello" }, { type: "text", text: "и объясни" }] },
    ];
    const raw = JSON.stringify(history[1].providerData);
    expect(toResponsesInput(history, "chatgpt", "gpt-6.1-sol")).toEqual([
      { role: "user", content: "прочитай a.txt" },
      { type: "reasoning", summary: [], encrypted_content: "ENCRYPTED" },
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Читаю.", annotations: [] }] },
      { type: "function_call", status: "completed", call_id: "call_abc", name: "read_file", arguments: '{"path":"a.txt"}' },
      { type: "function_call_output", call_id: "call_abc", output: "1\thello" },
      { role: "user", content: "и объясни" },
    ]);
    // The saved answer itself is never touched.
    expect(JSON.stringify(history[1].providerData)).toBe(raw);
    // Reasoning that arrived without its encrypted text is of no use to the service: it is left out.
    const bare: Message = { ...history[1], providerData: { provider: "chatgpt", model: "gpt-6.1-sol", raw: [{ id: "rs_2", type: "reasoning", summary: [] }, TEXT] } };
    expect((toResponsesInput([bare], "chatgpt", "gpt-6.1-sol") as Array<{ type?: string }>).map((i) => i.type)).toEqual(["message"]);
  });

  it("a history from another model or service is rebuilt from its parts: foreign reasoning is not sent", () => {
    const history: Message[] = [
      USER,
      {
        role: "assistant",
        parts: [{ type: "text", text: "Reading." }, { type: "tool_call", id: "functions.read_file:0", name: "read_file", input: { path: "a.txt" } }],
        providerData: { provider: "polza", model: "anthropic/claude-opus-5.5", raw: [{ type: "thinking", thinking: "…", signature: "s" }] },
      },
      { role: "user", parts: [{ type: "tool_result", toolCallId: "functions.read_file:0", content: "boom", isError: true }] },
      { role: "user", parts: [{ type: "text", text: "что на картинке?" }, { type: "image", mediaType: "image/png", data: "QUJD" }] },
    ];
    const input = toResponsesInput(history, "chatgpt", "gpt-6.1-sol") as any[];
    expect(input[1]).toEqual({ role: "assistant", content: "Reading." });
    expect(input[2]).toMatchObject({ type: "function_call", name: "read_file", arguments: '{"path":"a.txt"}' });
    expect(input[2].call_id).toMatch(/^[a-zA-Z0-9_-]{1,40}$/);
    expect(input[3]).toEqual({ type: "function_call_output", call_id: input[2].call_id, output: "ERROR: boom" });
    expect(input[4]).toEqual({ role: "user", content: [{ type: "input_text", text: "что на картинке?" }, { type: "input_image", image_url: "data:image/png;base64,QUJD", detail: "auto" }] });
    expect(JSON.stringify(input)).not.toContain("thinking");
    // The same model, but another service: its raw output is in another format.
    expect(JSON.stringify(toResponsesInput([{ ...history[1], providerData: { provider: "openai", model: "gpt-6.1-sol", raw: "x" } }], "chatgpt", "gpt-6.1-sol"))).not.toContain('"x"');
  });

  it("effort: sent only when set; a refusal drops it for the model and says so", async () => {
    const { provider, requests } = service([() => refused(400, "unsupported_parameter", "reasoning.effort is not supported"), reply([TEXT]), reply([TEXT])]);
    const first = (await collect(provider.stream(ask([USER], { effort: "max" })))).at(-1) as Extract<StreamEvent, { type: "done" }>;
    expect(requests[0].body.reasoning).toEqual({ effort: "max" });
    expect(requests[1].body).not.toHaveProperty("reasoning");
    expect(first.effortIgnored).toBe("rejected");
    expect(first.stopReason).toBe("end_turn");
    // Remembered: the next request does not try again.
    const second = (await collect(provider.stream(ask([USER], { effort: "max" })))).at(-1) as Extract<StreamEvent, { type: "done" }>;
    expect(requests).toHaveLength(3);
    expect(requests[2].body).not.toHaveProperty("reasoning");
    expect(second.effortIgnored).toBe("rejected");
  });

  it("a used-up plan is said in plain words and asked once: no status for the agent to retry by", async () => {
    const { provider, requests } = service([() => refused(429, "subscription_sharing_usage_limit_exceeded", "limit reached")]);
    const failure = await collect(provider.stream(ask([USER]))).catch((e) => e);
    expect(failure).toBeInstanceOf(ChatGPTPlanError);
    expect(failure.message).toMatch(/^Лимит подписки ChatGPT исчерпан.*Usage.*\(Ответ сервиса: .*limit reached\)$/);
    expect(failure.status).toBeUndefined();
    expect(failure.message).not.toMatch(/overloaded|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|terminated|network|Connection error/i);
    expect(requests).toHaveLength(1);
  });

  it("the limit reached in the middle of a reply is the same clear error", async () => {
    const { provider } = service([
      sse([
        { type: "response.output_text.delta", delta: "Нач" },
        { type: "response.failed", response: { status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } },
      ]),
    ]);
    await expect(collect(provider.stream(ask([USER])))).rejects.toThrow(/Лимит подписки ChatGPT исчерпан/);
  });

  it.each([
    [403, "subscription_sharing_user_not_eligible", /не может использовать подписку в приложениях/],
    [400, "subscription_sharing_unsupported_capability", /модель или возможность недоступна.*tools\[0\]/],
    [401, "subscription_sharing_invalid_user", /Вход в ChatGPT не принят сервисом.*Войти через ChatGPT/],
    [401, "anything", /Вход в ChatGPT не принят сервисом.*Войти через ChatGPT/],
  ])("refusal %s %s is explained", async (status, code, message) => {
    const { provider } = service([() => refused(status, code, "refused", "tools[0]")]);
    const failure = await collect(provider.stream(ask([USER]))).catch((e) => e);
    expect(failure).toBeInstanceOf(ChatGPTPlanError);
    expect(failure.message).toMatch(message);
  });

  it("a passing failure of the service keeps its status, so the agent tries again", async () => {
    const { provider } = service([() => refused(503, "subscription_sharing_usage_unavailable")]);
    const failure = await collect(provider.stream(ask([USER]))).catch((e) => e);
    expect(failure).not.toBeInstanceOf(ChatGPTPlanError);
    expect(failure.status).toBe(503);
  });

  it("an ended sign-in surfaces as itself, not as the library's wrapper", async () => {
    const { provider, requests } = service([], async () => {
      throw new ChatGPTSignInError("Вход в ChatGPT устарел.");
    });
    const failure = await collect(provider.stream(ask([USER]))).catch((e) => e);
    expect(failure).toBeInstanceOf(ChatGPTSignInError);
    expect(failure.message).toBe("Вход в ChatGPT устарел.");
    expect(requests).toEqual([]);
    await expect(provider.listModels()).rejects.toBeInstanceOf(ChatGPTSignInError);
  });

  it("a stream cut before its closing event is an incomplete reply", async () => {
    const { provider } = service([sse([{ type: "response.output_text.delta", delta: "Нач" }, { type: "response.output_item.done", item: TEXT }])]);
    await expect(collect(provider.stream(ask([USER])))).rejects.toThrow(/оборвался на середине/);
  });

  it("a reply stopped by the service's own limit or filter is not taken for a finished one", async () => {
    const stopped = (reason: string) => sse([{ type: "response.output_item.done", item: TEXT }, { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason }, output: [] } }]);
    const { provider } = service([stopped("max_output_tokens"), stopped("content_filter")]);
    expect(((await collect(provider.stream(ask([USER])))).at(-1) as { stopReason: string }).stopReason).toBe("max_tokens");
    expect(((await collect(provider.stream(ask([USER])))).at(-1) as { stopReason: string }).stopReason).toBe("refusal");
  });

  it("the reply is read from the closing event when the stream named no items", async () => {
    const { provider } = service([sse([{ type: "response.completed", response: { status: "completed", output: [TEXT] } }])]);
    const done = (await collect(provider.stream(ask([USER])))).at(-1) as Extract<StreamEvent, { type: "done" }>;
    expect(done.message.parts).toEqual([{ type: "text", text: "Читаю." }]);
    expect(done.stopReason).toBe("end_turn");
  });

  it("lists the models the account may use, in the service's order", async () => {
    const list = { models: [{ slug: "gpt-6.1-sol", display_name: "GPT", visibility: "list" }, { slug: "internal", visibility: "hide" }, { slug: "gpt-6.1-mini", visibility: "list" }] };
    const { provider, requests } = service([new Response(JSON.stringify(list), { headers: { "content-type": "application/json" } })]);
    expect(await provider.listModels()).toEqual(["gpt-6.1-sol", "gpt-6.1-mini"]);
    expect(requests[0]).toMatchObject({ url: "https://api.openai.com/v1/models", auth: "Bearer access-1" });
  });

  it("the service cannot be built with a key instead of a sign-in", () => {
    expect(() => createProvider({ presetId: "chatgpt", apiKey: "sk-123" })).toThrow(/Войти через ChatGPT/);
  });
});
