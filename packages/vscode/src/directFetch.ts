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
      if (!direct || init?.signal?.aborted || (body != null && typeof body !== "string")) throw e;
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
