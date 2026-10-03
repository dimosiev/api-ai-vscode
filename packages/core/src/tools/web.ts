import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** How the tool reaches the network; replaced in tests. */
export interface WebAccess {
  fetch: typeof fetch;
  /** Addresses a host name leads to. */
  lookup(host: string): Promise<string[]>;
}

export const defaultWeb: WebAccess = {
  fetch: (...args) => fetch(...args),
  lookup: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
};

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 40_000;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const TEXT_TYPES = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json)|[\w.+-]+\/[\w.+-]*\+(json|xml))/i;

/** The address of a page the agent may ask for: https only, a host name, no login in it. */
export function parsePageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`"${raw}" is not a web address. Give a full address that starts with https://`);
  }
  if (url.protocol !== "https:") throw new Error("Only https:// addresses can be read.");
  if (url.username || url.password) throw new Error("Addresses with a user name or password in them are not read.");
  if (url.port && url.port !== "443") throw new Error("Only the standard https port can be read.");
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) || !url.hostname.includes(".")) {
    throw new Error("Only public sites with a host name can be read, not IP addresses or names of the local network.");
  }
  return url;
}

/**
 * An address on the public internet: not this computer, not the home or
 * office network, not cloud metadata. 198.18.0.0/15 counts as public: VPN
 * and proxy programs hand out such stand-in addresses for every site, and
 * refusing them would refuse the whole internet on those computers. There
 * the check can't see where a name really leads; what still protects local
 * services is https with certificate checks on the standard port, and the
 * user's approval of every site.
 */
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0)
    );
  }
  if (isIP(ip) !== 6) return false;
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)?.[1];
  if (mapped) return isPublicAddress(mapped);
  // Loopback and unspecified, unique local (fc00::/7), link-local (fe80::/10), multicast, IPv4-mapped in hex.
  return !(v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff") || v6.startsWith("::ffff:"));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»", copy: "©" };

/** Elements whose content is not the page's text. */
const SKIPPED = ["script", "style", "noscript", "svg", "template", "head"];
const SKIPPED_END = new Map(SKIPPED.map((name) => [name, new RegExp(String.raw`</${name}\s*>`, "gi")]));
/** Elements that start on a new line. */
const BLOCKS = new Set("br hr p div section article header footer main nav aside h1 h2 h3 h4 h5 h6 li ul ol tr table pre blockquote dd dt dl figure form".split(" "));
const TAG_NAME = /^<(\/?)([a-z][a-z0-9]*)/i;
const LINK_ADDRESS = /\bhref\s*=\s*["']?(https?:[^"'\s>]+)/i;

/**
 * The text between the tags, in one pass over the page. Every search goes
 * forward only, so the time grows with the size of the page and not faster:
 * a page of unclosed tags must not freeze the editor (regular expressions
 * over the whole page did).
 */
function stripMarkup(html: string): string {
  const out: string[] = [];
  /** Addresses of the links that are open now, the innermost last ("" for a link without one). */
  const links: string[] = [];
  let at = 0;
  while (at < html.length) {
    const lt = html.indexOf("<", at);
    if (lt < 0) {
      out.push(html.slice(at));
      break;
    }
    out.push(html.slice(at, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      // An unclosed comment hides the rest of the page, as in a browser.
      if (end < 0) break;
      at = end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) {
      // No tag can end after this point: the rest is text.
      out.push(html.slice(lt));
      break;
    }
    const tag = html.slice(lt, gt + 1);
    at = gt + 1;
    const parsed = TAG_NAME.exec(tag);
    if (!parsed) continue;
    const closing = parsed[1] === "/";
    const name = parsed[2].toLowerCase();
    const skippedEnd = closing ? undefined : SKIPPED_END.get(name);
    if (skippedEnd) {
      skippedEnd.lastIndex = at;
      if (!skippedEnd.exec(html)) break;
      at = skippedEnd.lastIndex;
    } else if (name === "a") {
      if (!closing) links.push(LINK_ADDRESS.exec(tag)?.[1] ?? "");
      else {
        const address = links.pop();
        if (address) out.push(` (${address})`);
      }
    } else if (BLOCKS.has(name)) {
      out.push("\n");
    } else if (closing && (name === "td" || name === "th")) {
      out.push(" | ");
    }
  }
  return out.join("");
}

/** A page as plain text: no scripts, styles or markup; links keep their address. */
export function htmlToText(html: string): string {
  return stripMarkup(html)
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, name: string) => {
      if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? m;
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function assertPublic(url: URL, web: WebAccess): Promise<void> {
  let addresses: string[];
  try {
    addresses = await web.lookup(url.hostname);
  } catch {
    throw new Error(`The site ${url.hostname} was not found.`);
  }
  if (!addresses.length || !addresses.every(isPublicAddress)) {
    throw new Error(`${url.hostname} leads to this computer or a local network, so it is not read.`);
  }
}

/**
 * The encoding of a page: the one the site names, else the one the page
 * names in its first lines (`<meta charset=…>`), else UTF-8. Older Russian
 * sites are often in windows-1251.
 */
function decoderFor(type: string, bytes: Uint8Array): InstanceType<typeof TextDecoder> {
  const named =
    /charset\s*=\s*["']?([\w.:-]+)/i.exec(type)?.[1] ??
    /<meta[^>]{0,200}?charset\s*=\s*["']?([\w.:-]+)/i.exec(Buffer.from(bytes.subarray(0, 2048)).toString("latin1"))?.[1];
  try {
    return new TextDecoder(named ?? "utf-8");
  } catch {
    // a name this computer does not know
    return new TextDecoder("utf-8");
  }
}

async function readBody(res: Response, type: string): Promise<{ text: string; cut: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", cut: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= MAX_BYTES) {
      cut = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const bytes = Buffer.concat(chunks).subarray(0, MAX_BYTES);
  return { text: decoderFor(type, bytes).decode(bytes), cut };
}

export type PageResult =
  | { kind: "page"; url: string; text: string }
  /** The site sends the reader to another site: that one needs its own approval. */
  | { kind: "moved"; to: string };

/**
 * Reads one page without cookies or logins. Redirects are followed only
 * inside the same site; every hop is checked again to lead to the public
 * internet.
 */
export async function fetchPage(start: URL, web: WebAccess, signal?: AbortSignal): Promise<PageResult> {
  let url = start;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url, web);
    let res: Response;
    try {
      res = await web.fetch(url, {
        redirect: "manual",
        credentials: "omit",
        headers: { accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5", "user-agent": "dimosi (coding agent; reads pages for its user)" },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      if (signal?.aborted) throw new Error("Cancelled by the user.");
      throw new Error(timeout.aborted ? `${url.hostname} did not answer in ${TIMEOUT_MS / 1000}s.` : `Could not reach ${url.hostname}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel().catch(() => undefined);
      let next: URL;
      try {
        next = parsePageUrl(new URL(res.headers.get("location")!, url).toString());
      } catch {
        throw new Error("The page redirects to an address that can't be read.");
      }
      if (next.hostname !== start.hostname) return { kind: "moved", to: next.toString() };
      url = next;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`The site answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (type && !TEXT_TYPES.test(type)) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`This address is not a text page (${type.split(";")[0]}), so it is not read.`);
    }
    const body = await readBody(res, type);
    const text = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body.text) ? htmlToText(body.text) : body.text.trim();
    const cut = body.cut || text.length > MAX_CHARS;
    return { kind: "page", url: url.toString(), text: (text.slice(0, MAX_CHARS) || "(the page has no text)") + (cut ? "\n... (the rest of the page is cut)" : "") };
  }
  throw new Error("Too many redirects.");
}
