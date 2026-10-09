// OpenAI's sign-in service and the user's browser for the tests of "Sign in with ChatGPT".
// Nothing leaves this computer: `fetch` answers for auth.openai.com itself, and the "browser"
// calls only the listener on 127.0.0.1 that the sign-in opened.
import { createSign, generateKeyPairSync } from "node:crypto";
import type { KeyStore } from "../src";

export class MemoryKeys implements KeyStore {
  data = new Map<string, string>();
  async get(name: string) {
    return this.data.get(name);
  }
  async set(name: string, value: string) {
    this.data.set(name, value);
  }
  async delete(name: string) {
    this.data.delete(name);
  }
  async list() {
    return [...this.data.keys()];
  }
}

const b64 = (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64url");
const realFetch = fetch;

export interface FakeOpenAI {
  fetch: typeof fetch;
  /** Opens the sign-in page: the "user" agrees and the browser returns to the listener. */
  browser(url: string): Promise<void>;
  /** The address the browser was sent to, by attempt. */
  opened: URL[];
  /** The forms posted to the token and revocation endpoints. */
  tokenForms: Array<Record<string, string>>;
  revoked: Array<Record<string, string>>;
  /** What the callback of the browser carries; change it to play a refusal. */
  callback: (authorize: URL) => Record<string, string>;
  /** The answer to a token request; the default grants everything asked. */
  token: (form: Record<string, string>) => { status?: number; body: Record<string, unknown> };
  /** An ID token as OpenAI would sign it. */
  idToken(claims?: Record<string, unknown>, signedBy?: "openai" | "stranger"): string;
  revocationStatus: number;
}

export function fakeOpenAI(): FakeOpenAI {
  const openai = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let nonce = "";
  let granted = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const form = (init?: RequestInit) => Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));

  const fake: FakeOpenAI = {
    opened: [],
    tokenForms: [],
    revoked: [],
    revocationStatus: 200,
    callback: (authorize) => ({ code: "code-1", state: authorize.searchParams.get("state")!, client_id: "oaiapp_issued" }),
    idToken(claims = {}, signedBy = "openai") {
      const head = b64({ alg: "RS256", kid: "key-1", typ: "JWT" });
      const body = b64({ iss: "https://auth.openai.com", aud: "oaiapp_issued", sub: "user-1", email: "owner@example.com", exp: Math.floor(Date.now() / 1000) + 3600, nonce, ...claims });
      const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign((signedBy === "openai" ? openai : stranger).privateKey);
      return `${head}.${body}.${signature.toString("base64url")}`;
    },
    token: () => {
      granted++;
      return {
        body: {
          access_token: `access-${granted}`,
          refresh_token: `refresh-${granted}`,
          id_token: fake.idToken(),
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        },
      };
    },
    async browser(url) {
      const authorize = new URL(url);
      fake.opened.push(authorize);
      nonce = authorize.searchParams.get("nonce") ?? "";
      const back = new URL(authorize.searchParams.get("redirect_uri")!);
      for (const [k, v] of Object.entries(fake.callback(authorize))) back.searchParams.set(k, v);
      await (await realFetch(back)).text();
    },
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
      if (url === "https://auth.openai.com/.well-known/openid-configuration") {
        return json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/jwks", revocation_endpoint: "https://auth.openai.com/revoke" });
      }
      if (url === "https://auth.openai.com/jwks") return json({ keys: [{ ...openai.publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" }] });
      if (url === "https://auth.openai.com/api/accounts/oauth/token") {
        fake.tokenForms.push(form(init));
        const answer = fake.token(form(init));
        return json(answer.body, answer.status ?? 200);
      }
      if (url === "https://auth.openai.com/revoke") {
        fake.revoked.push(form(init));
        return new Response("", { status: fake.revocationStatus });
      }
      throw new Error(`the test reached for the network: ${url}`);
    }) as typeof fetch,
  };
  return fake;
}
