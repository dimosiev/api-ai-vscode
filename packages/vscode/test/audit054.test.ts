// Findings of the audit after 0.5.4 (docs/AUDIT.md, «Аудит после 0.5.4») in the extension.
// Every finding is fixed now; the tests stay to keep it that way.
import { mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { polzaImages } from "@dimosi/core";
import { fetchWithDirectFallback, neverConnected } from "../src/directFetch";
import { pictureDataUrl } from "../src/pictures";
import { buildImages, buildProvider, readSettings } from "../src/settings";
import type { SecretKeyStore } from "../src/keyStore";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
/** What Node reports when the connection broke after the request had gone out. */
const reset = () => new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });

describe("О-2: the direct way repeats a request the service may already have received", () => {
  /** Polza AI as the service sees it: every POST /media starts one paid picture. */
  function service() {
    const started: string[] = [];
    const answer = (url: string, init?: RequestInit): Response => {
      if (init?.method === "POST") {
        started.push(String(init.body));
        return json({ id: `aig_${started.length}`, status: "completed", data: { url: "https://s3.polza.ai/x.png" } });
      }
      return new Response(PNG);
    };
    return { started, answer };
  }

  it("one approved picture is one paid request, even when the answer was lost on the way back through the proxy", async () => {
    const { started, answer } = service();
    let lost = false;
    const send = fetchWithDirectFallback({
      // The proxy passed the request on, the service started the picture, then the connection dropped.
      primary: (async (url: string, init?: RequestInit) => {
        const res = answer(url, init);
        if (init?.method === "POST" && !lost) {
          lost = true;
          throw reset();
        }
        return res;
      }) as unknown as typeof fetch,
      direct: () => (async (url: string, init?: RequestInit) => answer(url, init)) as unknown as typeof fetch,
    });
    await polzaImages({ apiKey: "k", fetch: send }).generate({ prompt: "кот" }).catch(() => undefined);
    expect(started).toHaveLength(1);
  });

  it("(for comparison) a request that never left is repeated directly: that is what the fallback is for", async () => {
    const { started, answer } = service();
    const send = fetchWithDirectFallback({
      primary: async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1082"), { code: "ECONNREFUSED" }) });
      },
      direct: () => (async (url: string, init?: RequestInit) => answer(url, init)) as unknown as typeof fetch,
    });
    const image = await polzaImages({ apiKey: "k", fetch: send }).generate({ prompt: "кот" });
    expect(image.bytes).toHaveLength(PNG.length);
    expect(started).toHaveLength(1);
  });
});

describe("О-2: which failures mean that the request never left", () => {
  const failed = (cause: unknown) => new TypeError("fetch failed", { cause });
  const coded = (code: string, extra: object = {}) => Object.assign(new Error(code), { code, ...extra });

  it("a refused connection, an unknown host, an unreachable network, a connection that timed out", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]) {
      expect(neverConnected(failed(coded(code))), code).toBe(true);
    }
    expect(neverConnected(failed(coded("ETIMEDOUT", { syscall: "connect" })))).toBe(true);
    // Several addresses of one host, all refused.
    expect(neverConnected(failed(Object.assign(new AggregateError([coded("ECONNREFUSED"), coded("ECONNREFUSED")], ""), { code: "ECONNREFUSED" })))).toBe(true);
    expect(neverConnected(failed(new AggregateError([coded("ECONNREFUSED"), coded("ENETUNREACH")], "")))).toBe(true);
  });

  it("the same failures told only in words, without a code", () => {
    expect(neverConnected(failed(new Error("connect ECONNREFUSED 127.0.0.1:1082")))).toBe(true);
    expect(neverConnected(new Error("getaddrinfo ENOTFOUND polza.ai"))).toBe(true);
    expect(neverConnected(failed(new Error("read ECONNRESET")))).toBe(false);
    expect(neverConnected(failed(new Error("read ETIMEDOUT")))).toBe(false);
  });

  it("anything after the connection was made is not repeated", () => {
    for (const code of ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]) {
      expect(neverConnected(failed(coded(code))), code).toBe(false);
    }
    expect(neverConnected(failed(coded("ETIMEDOUT", { syscall: "read" })))).toBe(false);
    expect(neverConnected(new TypeError("terminated"))).toBe(false);
    expect(neverConnected(new Error("fetch failed"))).toBe(false);
    expect(neverConnected(undefined)).toBe(false);
  });
});

describe("Р-1: only Polza AI is asked directly when VS Code's proxy is gone", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { __vscodeOriginalFetch?: unknown }).__vscodeOriginalFetch;
  });

  /** VS Code's fetch goes to a dead proxy; the fetch it keeps aside works and records who was asked. */
  function deadProxy() {
    const direct: string[] = [];
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1082"), { code: "ECONNREFUSED" }) });
    });
    (globalThis as { __vscodeOriginalFetch?: unknown }).__vscodeOriginalFetch = async (url: unknown) => {
      direct.push(new URL(String(url)).host);
      return json({ data: [] });
    };
    return direct;
  }
  const keys = { get: async () => "key" } as unknown as SecretKeyStore;

  it("Polza AI: the chat service and the pictures go directly", async () => {
    const direct = deadProxy();
    await (await buildProvider(readSettings(), keys, "polza")).getPricing!("m");
    await (await buildImages(readSettings(), keys))!.price!();
    expect(direct).toEqual(["polza.ai", "polza.ai"]);
  });

  for (const id of ["anthropic", "openai", "openrouter", "teamo", "teamo-openai", "deepseek"]) {
    it(`${id}: the request never leaves around the VPN`, async () => {
      const direct = deadProxy();
      const provider = await buildProvider(readSettings(), keys, id);
      await Promise.resolve(provider.getPricing?.("m")).catch(() => undefined);
      await provider.listModels().catch(() => undefined);
      expect(direct).toEqual([]);
    }, 20_000); // the libraries repeat a failed request with pauses
  }
});

describe("checked and fine: the panel gets only real pictures", () => {
  it("a text file named like a picture, a link to a secret file and a missing file give nothing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dimosi-audit054-"));
    await fs.writeFile(path.join(dir, ".env"), "KEY=secret");
    await fs.writeFile(path.join(dir, "notes.png"), "KEY=secret");
    await fs.symlink(path.join(dir, ".env"), path.join(dir, "link.png"));
    await fs.writeFile(path.join(dir, "real.png"), PNG);
    expect(await pictureDataUrl(path.join(dir, "notes.png"))).toBeUndefined();
    expect(await pictureDataUrl(path.join(dir, "link.png"))).toBeUndefined();
    expect(await pictureDataUrl(path.join(dir, "gone.png"))).toBeUndefined();
    expect(await pictureDataUrl(path.join(dir, ".env"))).toBeUndefined();
    expect(await pictureDataUrl(path.join(dir, "real.png"))).toMatch(/^data:image\/png;base64,/);
  });
});
