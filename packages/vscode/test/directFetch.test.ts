import { describe, expect, it } from "vitest";
import { fetchWithDirectFallback } from "../src/directFetch";

const refused = () => new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1082"), { code: "ECONNREFUSED" }) });
const ok = () => new Response("ok");

function setup(primary: typeof fetch, direct: typeof fetch | undefined) {
  const notes: string[] = [];
  const calls: string[] = [];
  const wrap = (name: string, f: typeof fetch): typeof fetch => (input, init) => {
    calls.push(name);
    return f(input, init);
  };
  const fetchFn = fetchWithDirectFallback({
    primary: wrap("primary", primary),
    direct: () => direct && wrap("direct", direct),
    onFallback: (reason) => notes.push(reason),
  });
  return { fetchFn, notes, calls };
}

describe("fetchWithDirectFallback", () => {
  it("uses VS Code's fetch while it works", async () => {
    const { fetchFn, calls, notes } = setup(async () => ok(), async () => ok());
    expect(await (await fetchFn("https://polza.ai/api/v1/models")).text()).toBe("ok");
    expect(calls).toEqual(["primary"]);
    expect(notes).toEqual([]);
  });

  it("goes directly when the proxy VS Code remembers is gone (a VPN switched off)", async () => {
    const seen: unknown[] = [];
    const { fetchFn, calls, notes } = setup(
      async () => {
        throw refused();
      },
      async (input, init) => {
        seen.push(input, init?.body);
        return ok();
      },
    );
    const res = await fetchFn("https://polza.ai/api/v1/chat/completions", { method: "POST", body: '{"a":1}' });
    expect(await res.text()).toBe("ok");
    expect(calls).toEqual(["primary", "direct"]);
    expect(seen).toEqual(["https://polza.ai/api/v1/chat/completions", '{"a":1}']);
    expect(notes).toEqual(["fetch failed (connect ECONNREFUSED 127.0.0.1:1082)"]);
  });

  it("reports the first failure when the direct way fails too (no internet)", async () => {
    const first = refused();
    const { fetchFn, calls } = setup(
      async () => {
        throw first;
      },
      async () => {
        throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND polza.ai") });
      },
    );
    await expect(fetchFn("https://polza.ai/api/v1/models")).rejects.toBe(first);
    expect(calls).toEqual(["primary", "direct"]);
  });

  it("does not try again after the user pressed Stop", async () => {
    const stop = new AbortController();
    const { fetchFn, calls } = setup(
      async () => {
        stop.abort();
        throw new DOMException("This operation was aborted", "AbortError");
      },
      async () => ok(),
    );
    await expect(fetchFn("https://polza.ai/api/v1/models", { signal: stop.signal })).rejects.toThrow(/aborted/);
    expect(calls).toEqual(["primary"]);
  });

  it("does not resend a body that can be read only once", async () => {
    const { fetchFn, calls } = setup(
      async () => {
        throw refused();
      },
      async () => ok(),
    );
    const body = new ReadableStream();
    await expect(fetchFn("https://polza.ai/x", { method: "POST", body, duplex: "half" } as RequestInit)).rejects.toThrow("fetch failed");
    expect(calls).toEqual(["primary"]);
  });

  it("is plain fetch where there is no other way (outside VS Code)", async () => {
    const first = refused();
    const { fetchFn, calls } = setup(async () => {
      throw first;
    }, undefined);
    await expect(fetchFn("https://polza.ai/api/v1/models")).rejects.toBe(first);
    expect(calls).toEqual(["primary"]);
  });
});
