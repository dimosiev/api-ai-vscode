// VS Code sends every request of an extension through the system proxy and
// remembers the answer for each site: it looks again at most once in five
// minutes, and only if the network interfaces changed. When the proxy program
// (a VPN) is switched off, requests keep going to its dead address, although
// the service is reachable directly. No `vscode` import: tested directly.

export interface DirectFallbackOptions {
  /** The usual way: VS Code's fetch, with the proxy. */
  primary: typeof fetch;
  /** A fetch that skips the proxy, if the host has one. */
  direct: () => typeof fetch | undefined;
  onFallback?: (reason: string) => void;
}

/** The fetch VS Code keeps aside before it puts its own in place. */
export function vscodeOriginalFetch(): typeof fetch | undefined {
  const original = (globalThis as { __vscodeOriginalFetch?: unknown }).__vscodeOriginalFetch;
  return typeof original === "function" ? (original as typeof fetch) : undefined;
}

/** What Node reports when no connection was made: nothing reached the service. */
const NEVER_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "UND_ERR_CONNECT_TIMEOUT"]);

/**
 * True only when the request did not leave: the proxy (or the network) refused
 * the connection. A connection that broke later may have delivered the request,
 * and repeating it could pay for the same reply or picture twice.
 */
export function neverConnected(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== "object" || depth > 4) return false;
  const err = e as { code?: unknown; syscall?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  if (typeof err.code === "string" && (NEVER_CONNECTED.has(err.code) || (err.code === "ETIMEDOUT" && err.syscall === "connect"))) return true;
  // Some layers (a proxy agent) pass on only the text: "connect ECONNREFUSED 127.0.0.1:1082".
  const text = typeof err.message === "string" ? err.message : "";
  if (/\b(connect|getaddrinfo) (ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ETIMEDOUT)\b/.test(text)) return true;
  // Node tries several addresses of a host and reports them together.
  if (Array.isArray(err.errors) && err.errors.length) return err.errors.every((one) => neverConnected(one, depth + 1));
  return neverConnected(err.cause, depth + 1);
}

/**
 * A request that could not be sent at all is tried once more without the
 * proxy. If that fails too, the first error is reported: it names the proxy.
 */
export function fetchWithDirectFallback(opts: DirectFallbackOptions): typeof fetch {
  return async (input, init) => {
    try {
      return await opts.primary(input, init);
    } catch (e) {
      const direct = opts.direct();
      const body = init?.body;
      if (!direct || init?.signal?.aborted || !neverConnected(e) || (body != null && typeof body !== "string")) throw e;
      let res: Response;
      try {
        res = await direct(input, init);
      } catch {
        throw e;
      }
      opts.onFallback?.(reasonOf(e));
      return res;
    }
  };
}

function reasonOf(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message || String((e.cause as { code?: unknown }).code ?? "") : "";
  return cause ? `${text} (${cause})` : text;
}
