import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { KeyStore } from "./secrets";

// "Sign in with ChatGPT" with plan usage, the flow for open-source and local apps:
// https://developers.openai.com/siwc/token-sharing-open-source (read 9 October 2026).

/** Where the sign-in is kept in the key store: one JSON record, removed on sign-out. */
export const CHATGPT_KEY = "chatgpt";
/** The id of this installation: kept after sign-out, so the next sign-in is the same app for OpenAI. */
export const CHATGPT_HOST_KEY = "chatgpt-host";
/** Names in the key store that are not API keys: they are not listed, exported or typed in. */
export const CHATGPT_KEY_NAMES: readonly string[] = [CHATGPT_KEY, CHATGPT_HOST_KEY];

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const RESOURCE = "https://api.openai.com/v1";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
/** The first sign-in registers the app under this id; the callback brings the id to keep. */
const REGISTRATION_CLIENT = "dynamic_agent_client";
const APP_NAME = "dimosi";
const CALLBACK_PATH = "/auth/callback";
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** The access token lives an hour; a request must not start with one that is about to end. */
const REFRESH_BEFORE_MS = 5 * 60_000;
/** After these answers the refresh token is of no use: only a new sign-in helps. */
const SIGN_IN_AGAIN_CODES = ["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"];

export const CHATGPT_SIGN_IN_HINT = "Выполните команду «dimosi: Войти через ChatGPT».";

export interface ChatGPTAccount {
  /** The id OpenAI gave this app for this account. */
  clientId: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** When the access token ends, ms since 1970. */
  expiresAt: number;
  email?: string;
}

/** There is no usable sign-in: the user has to sign in (again). */
export class ChatGPTSignInError extends Error {}

export interface ChatGPTAuthOptions {
  keys: KeyStore;
  fetch?: typeof fetch;
  /** Every token received: for the journal to mask it. */
  onSecret?(value: string): void;
}

export interface ChatGPTLoginOptions extends ChatGPTAuthOptions {
  /** Opens the sign-in page in the user's browser. */
  openBrowser(url: string): unknown;
  /** The user gave up waiting. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function readChatGPTAccount(keys: KeyStore): Promise<ChatGPTAccount | undefined> {
  const text = await keys.get(CHATGPT_KEY);
  if (!text) return undefined;
  try {
    const a = JSON.parse(text) as Partial<ChatGPTAccount>;
    const ok = [a.clientId, a.accessToken, a.refreshToken, a.idToken].every((v) => typeof v === "string" && v) && typeof a.expiresAt === "number";
    return ok ? (a as ChatGPTAccount) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The whole sign-in: a listener on this computer, the browser, the code exchange, the checks.
 * Nothing is saved until every check has passed.
 */
export async function signInChatGPT(opts: ChatGPTLoginOptions): Promise<ChatGPTAccount> {
  const { keys } = opts;
  let hostId = await keys.get(CHATGPT_HOST_KEY);
  if (!hostId) {
    hostId = `urn:uuid:${randomUUID()}`;
    await keys.set(CHATGPT_HOST_KEY, hostId);
  }
  // A sign-in that ran out is renewed for the same account; after a sign-out the app registers anew.
  const before = await readChatGPTAccount(keys);
  const state = base64url(randomBytes(24));
  const nonce = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(48));

  // Ends the wait for the browser when the sign-in is over for any other reason.
  const over = new AbortController();
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    // 127.0.0.1 and this path exactly: the service accepts no other form of the address.
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}${CALLBACK_PATH}`;
    const query = new URLSearchParams({
      client_id: before?.clientId ?? REGISTRATION_CLIENT,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPE,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      ext_agent_host_id: hostId,
      ...(before ? { id_token_hint: before.idToken, ...(before.email ? { login_hint: before.email } : {}) } : { agent_name_hint: APP_NAME }),
    });
    const callback = waitForCallback(server, state, opts.signal ? AbortSignal.any([opts.signal, over.signal]) : over.signal, opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
    callback.catch(() => {}); // reported by the await below
    await opts.openBrowser(`${AUTHORIZE_URL}?${query}`);
    const answer = await callback;

    if (answer.get("error")) {
      throw new Error(answer.get("error") === "access_denied" ? "Вход отменён: доступ в браузере не был разрешён." : `Вход не выполнен: сервис ответил «${answer.get("error")}».`);
    }
    const code = answer.get("code");
    const clientId = answer.get("client_id") ?? before?.clientId;
    if (!code || !clientId) throw new Error("Вход не выполнен: сервис не прислал код входа.");
    if (before && clientId !== before.clientId) throw new Error("Вход не выполнен: сервис ответил для другого приложения. Выполните «dimosi: Выйти из ChatGPT» и войдите заново.");

    const tokens = await tokenRequest(opts, { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE });
    if (!tokens.ok) throw new Error(`Вход не выполнен: сервис не выдал пропуск (${tokens.error}).`);
    const t = tokens.body;
    if (typeof t.access_token !== "string" || typeof t.refresh_token !== "string" || typeof t.id_token !== "string") {
      throw new Error("Вход не выполнен: сервис прислал неполный ответ.");
    }
    if (!String(t.scope ?? "").split(" ").includes(PLAN_SCOPE)) {
      throw new Error("Вход выполнен, но OpenAI не разрешил использовать подписку в приложении. Проверьте тариф ChatGPT и разрешение на странице входа.");
    }
    const claims = await verifyIdToken(t.id_token, { clientId, nonce, fetch: opts.fetch });
    const account: ChatGPTAccount = {
      clientId,
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      idToken: t.id_token,
      expiresAt: Date.now() + lifetimeMs(t.expires_in),
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    };
    await save(opts, account);
    return account;
  } finally {
    over.abort();
    server.close();
    server.closeAllConnections();
  }
}

/**
 * Gives the access token for a request, renewing it shortly before it ends. The sign-in is read
 * from the key store every time: another window may have renewed it, and the refresh token
 * changes with every renewal.
 */
export function chatgptToken(opts: ChatGPTAuthOptions): () => Promise<string> {
  let pending: Promise<string> | undefined;
  const current = async (): Promise<string> => {
    const account = await readChatGPTAccount(opts.keys);
    if (!account) throw new ChatGPTSignInError(`Вход в ChatGPT не выполнен. ${CHATGPT_SIGN_IN_HINT}`);
    if (account.expiresAt - REFRESH_BEFORE_MS > Date.now()) return account.accessToken;
    return refresh(opts, account, true);
  };
  // One renewal at a time: two would race on the changing refresh token.
  return () => (pending ??= current().finally(() => (pending = undefined)));
}

async function refresh(opts: ChatGPTAuthOptions, account: ChatGPTAccount, mayRetry: boolean): Promise<string> {
  const answer = await tokenRequest(opts, { grant_type: "refresh_token", client_id: account.clientId, refresh_token: account.refreshToken, resource: RESOURCE });
  if (answer.ok && typeof answer.body.access_token === "string") {
    const t = answer.body;
    const renewed: ChatGPTAccount = {
      ...account,
      accessToken: t.access_token as string,
      refreshToken: typeof t.refresh_token === "string" ? t.refresh_token : account.refreshToken,
      idToken: typeof t.id_token === "string" ? t.id_token : account.idToken,
      expiresAt: Date.now() + lifetimeMs(t.expires_in),
    };
    await save(opts, renewed);
    return renewed.accessToken;
  }
  const error = answer.ok ? "неполный ответ" : answer.error;
  // Another window renewed the sign-in first: its tokens are the ones that work now.
  const stored = await readChatGPTAccount(opts.keys);
  if (stored && stored.refreshToken !== account.refreshToken) {
    if (stored.expiresAt - REFRESH_BEFORE_MS > Date.now()) return stored.accessToken;
    if (mayRetry) return refresh(opts, stored, false);
  }
  if (!answer.ok && SIGN_IN_AGAIN_CODES.includes(answer.code)) {
    await opts.keys.delete(CHATGPT_KEY);
    throw new ChatGPTSignInError(`Вход в ChatGPT устарел или отключён в настройках ChatGPT. ${CHATGPT_SIGN_IN_HINT}`);
  }
  // A passing failure: the sign-in is kept.
  throw new Error(`Не удалось продлить вход в ChatGPT (${error}). Попробуйте ещё раз через минуту.`);
}

/**
 * Forgets the sign-in on this computer and asks OpenAI to end it.
 * `revoked: false`: OpenAI did not confirm; the app can be disconnected in the ChatGPT settings.
 */
export async function signOutChatGPT(opts: ChatGPTAuthOptions): Promise<{ revoked: boolean }> {
  const account = await readChatGPTAccount(opts.keys);
  let revoked = false;
  if (account) {
    try {
      const { revocation_endpoint } = await discover(opts.fetch);
      const res = await request(opts.fetch, openaiUrl(revocation_endpoint), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: account.refreshToken, token_type_hint: "refresh_token", client_id: account.clientId }).toString(),
      });
      revoked = res.ok;
    } catch {
      // told to the user by the caller
    }
  }
  await opts.keys.delete(CHATGPT_KEY);
  return { revoked };
}

async function save(opts: ChatGPTAuthOptions, account: ChatGPTAccount): Promise<void> {
  for (const secret of [account.accessToken, account.refreshToken, account.idToken]) opts.onSecret?.(secret);
  await opts.keys.set(CHATGPT_KEY, JSON.stringify(account));
}

function lifetimeMs(expiresIn: unknown): number {
  const seconds = Number(expiresIn);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
}

/** The browser comes back to this computer with the answer; anything else that knocks is turned away. */
function waitForCallback(server: Server, state: string, signal: AbortSignal, timeoutMs: number): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const stop = (e: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(e);
    };
    const onAbort = () => stop(new Error("Вход отменён."));
    const timer = setTimeout(() => stop(new Error("Вход не выполнен: ответ из браузера не пришёл за 5 минут. Попробуйте ещё раз.")), timeoutMs);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const page = (status: number, text: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" });
        res.end(`<!doctype html><meta charset="utf-8"><title>dimosi</title><body style="font-family:system-ui;margin:3em"><h2>${text}</h2></body>`);
      };
      if (req.method !== "GET" || url.pathname !== CALLBACK_PATH) return page(404, "Здесь ничего нет.");
      // Not the answer to this sign-in: the wait goes on.
      if (url.searchParams.get("state") !== state) return page(400, "Это не ответ на текущий вход. Начните вход из dimosi заново.");
      if (url.searchParams.get("error")) page(200, "Вход не выполнен. Вернитесь в dimosi.");
      else page(200, "Готово. Эту вкладку можно закрыть и вернуться в dimosi.");
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(url.searchParams);
    });
  });
}

type TokenAnswer = { ok: true; body: Record<string, unknown> } | { ok: false; code: string; error: string };

async function tokenRequest(opts: ChatGPTAuthOptions, form: Record<string, string>): Promise<TokenAnswer> {
  const res = await request(opts.fetch, TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, body };
  // Either the OAuth form ({ error: "code" }) or the API form ({ error: { code, message } }).
  const err = body.error as string | { code?: unknown; message?: unknown } | undefined;
  const code = typeof err === "string" ? err : typeof err?.code === "string" ? err.code : "";
  return { ok: false, code, error: [res.status, code].filter(Boolean).join(" ") };
}

function request(fetchFn: typeof fetch | undefined, url: string, init: RequestInit = {}): Promise<Response> {
  return (fetchFn ?? fetch)(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/** An address named by OpenAI's own configuration: it must still be OpenAI's, tokens go there. */
function openaiUrl(value: unknown): string {
  const url = typeof value === "string" && URL.canParse(value) ? new URL(value) : undefined;
  if (!url || url.protocol !== "https:" || !(url.hostname === "openai.com" || url.hostname.endsWith(".openai.com"))) {
    throw new Error("Сервис входа OpenAI назвал неожиданный адрес.");
  }
  return url.href;
}

async function discover(fetchFn: typeof fetch | undefined): Promise<Record<string, unknown>> {
  const res = await request(fetchFn, DISCOVERY_URL);
  if (!res.ok) throw new Error(`Сервис входа OpenAI не ответил (${res.status}).`);
  return (await res.json()) as Record<string, unknown>;
}

const JWT_ALGORITHMS: Record<string, { hash: string; dsaEncoding?: "ieee-p1363" }> = {
  RS256: { hash: "sha256" },
  ES256: { hash: "sha256", dsaEncoding: "ieee-p1363" },
};

/** The ID token says who signed in: OpenAI's signature, this app, this sign-in attempt, not expired. */
export async function verifyIdToken(token: string, expected: { clientId: string; nonce: string; fetch?: typeof fetch }): Promise<Record<string, unknown>> {
  const bad = (why: string) => new Error(`Вход не выполнен: сведения об аккаунте не прошли проверку (${why}).`);
  const [h, p, s] = token.split(".");
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    throw bad("не разобрать");
  }
  const algorithm = JWT_ALGORITHMS[header.alg ?? ""];
  if (!algorithm || !s) throw bad("неизвестная подпись");
  const jwks = await request(expected.fetch, openaiUrl((await discover(expected.fetch)).jwks_uri));
  if (!jwks.ok) throw bad(`ключи OpenAI не получены, ${jwks.status}`);
  const list = ((await jwks.json()) as { keys?: Array<JsonWebKey & { kid?: string }> }).keys ?? [];
  const jwk = list.find((k) => k.kid === header.kid);
  if (!jwk) throw bad("ключ подписи не найден");
  let signed = false;
  try {
    signed = verify(algorithm.hash, Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: algorithm.dsaEncoding }, Buffer.from(s, "base64url"));
  } catch {
    // an unusable key is a failed check
  }
  if (!signed) throw bad("подпись неверна");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER) throw bad("выдан не OpenAI");
  if (!audience.includes(expected.clientId)) throw bad("выдан другому приложению");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - 60_000) throw bad("срок истёк");
  if (claims.nonce !== expected.nonce) throw bad("не от этой попытки входа");
  return claims;
}

function base64url(data: Buffer): string {
  return data.toString("base64url");
}
