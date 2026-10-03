// Pictures made by an image model (generate_image). The chat model only
// writes the description; the picture is made by a separate, paid request.
import { getPreset } from "../providers/presets";

export interface GeneratedImage {
  bytes: Uint8Array;
  /** What the service charged, e.g. "4 ₽". */
  cost?: string;
}

/** Implemented per service; the host gives it to the agent together with the key. */
export interface ImageMaker {
  /** The image model, as shown to the user. */
  readonly model: string;
  /** The price of one picture for the question to the user, e.g. "4 ₽"; undefined when unknown. */
  price?(signal?: AbortSignal): Promise<string | undefined>;
  generate(req: { prompt: string; aspectRatio?: string; signal?: AbortSignal }): Promise<GeneratedImage>;
}

export const DEFAULT_POLZA_IMAGE_MODEL = "qwen/image-2";
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
/** The price is only a hint on the question: the user is not kept waiting for it. */
const PRICE_TIMEOUT_MS = 10_000;

/** The real format of a picture by its first bytes; undefined for anything else. */
export function imageFormat(bytes: Uint8Array): "png" | "jpg" | "webp" | undefined {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (starts(0xff, 0xd8, 0xff)) return "jpg";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  return undefined;
}

export interface PolzaImagesOptions {
  apiKey: string;
  /** Empty: DEFAULT_POLZA_IMAGE_MODEL. */
  model?: string;
  fetch?: typeof fetch;
  /** Overrides for tests. */
  pollMs?: number;
  timeoutMs?: number;
}

/**
 * Polza AI Media API: POST /media starts a generation, GET /media/{id} tells
 * when it is ready, the picture is then downloaded from Polza's storage.
 * The address is the preset's: the key never goes anywhere else.
 */
export function polzaImages(opts: PolzaImagesOptions): ImageMaker {
  const base = getPreset("polza").baseURL!;
  const model = opts.model?.trim() || DEFAULT_POLZA_IMAGE_MODEL;
  const send = opts.fetch ?? ((input, init) => fetch(input, init));
  const pollMs = opts.pollMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const headers = { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" };

  const call = async (url: string, init: RequestInit): Promise<Record<string, unknown>> => {
    const res = await send(url, init);
    const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!res.ok) throw new Error(`The image service answered ${res.status}: ${errorMessage(body?.error) || res.statusText || "no details"}`);
    if (!body) throw new Error("The image service sent an answer that is not JSON.");
    return body;
  };

  let price: Promise<string | undefined> | undefined;

  return {
    model,
    price(signal) {
      const limit = AbortSignal.timeout(PRICE_TIMEOUT_MS);
      price ??= call(`${base}/models`, { headers, signal: signal ? AbortSignal.any([signal, limit]) : limit })
        .then((list) => priceOf((list.data as Array<Record<string, unknown>> | undefined)?.find((m) => m.id === model)))
        .catch(() => {
          price = undefined; // ask again next time
          return undefined;
        });
      return price;
    },
    async generate({ prompt, aspectRatio, signal }) {
      const input = { prompt, ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}) };
      let status = await call(`${base}/media`, { method: "POST", headers, body: JSON.stringify({ model, input }), signal });
      const until = Date.now() + timeoutMs;
      while (status.status === "pending" || status.status === "processing") {
        if (typeof status.id !== "string" || !/^[\w-]+$/.test(status.id)) throw new Error("The image service did not say how to ask for the result.");
        if (Date.now() > until) throw new Error(`The picture was not ready in ${Math.round(timeoutMs / 1000)} s. It may still be charged.`);
        await pause(pollMs, signal);
        status = await call(`${base}/media/${status.id}`, { headers, signal });
      }
      if (status.status !== "completed") {
        throw new Error(`The image service could not make the picture: ${errorMessage(status.error) || String(status.status)}`);
      }
      const url = firstUrl(status.data);
      if (!url) throw new Error("The image service reported success but gave no picture address.");
      // Polza's storage, not the API: the key is not sent there.
      const res = await send(url, { signal });
      if (!res.ok) throw new Error(`The picture could not be downloaded (${res.status}).`);
      const bytes = await readLimited(res, MAX_IMAGE_BYTES);
      const usage = status.usage as { cost_rub?: unknown } | undefined;
      const rub = Number(usage?.cost_rub);
      return { bytes, cost: Number.isFinite(rub) && usage?.cost_rub != null ? rubles(rub) : undefined };
    },
  };
}

/** The body, read only up to the limit: a larger download is cut off, not kept in memory. */
async function readLimited(res: Response, limit: number): Promise<Uint8Array> {
  const tooLarge = () => new Error(`The picture is too large (over ${Math.round(limit / 1024 / 1024)} MB). Nothing was saved.`);
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  if (Number(res.headers.get("content-length")) > limit) {
    await reader.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

const rubles = (n: number) => `${String(Math.round(n * 100) / 100).replace(".", ",")} ₽`;

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  const e = error as { message?: unknown; metadata?: { raw?: unknown } } | undefined;
  const raw = typeof e?.metadata?.raw === "string" ? ` (${e.metadata.raw})` : "";
  return typeof e?.message === "string" ? `${e.message}${raw}`.slice(0, 500) : "";
}

/** `data` is `{ url }`, a list of those, or a list of addresses. Only https. */
function firstUrl(data: unknown): string | undefined {
  const one = Array.isArray(data) ? data[0] : data;
  const url = typeof one === "string" ? one : (one as { url?: unknown } | undefined)?.url;
  return typeof url === "string" && url.startsWith("https://") ? url : undefined;
}

/** Polza AI lists a price per picture, or several by size and quality. */
function priceOf(model: Record<string, unknown> | undefined): string | undefined {
  const pricing = (model?.top_provider as { pricing?: { per_request?: unknown; tiers?: Array<{ cost_rub?: unknown }> } } | undefined)?.pricing;
  const flat = Number(pricing?.per_request);
  if (pricing?.per_request != null && Number.isFinite(flat)) return rubles(flat);
  const tiers = (pricing?.tiers ?? []).map((t) => Number(t.cost_rub)).filter(Number.isFinite);
  if (!tiers.length) return undefined;
  const [min, max] = [Math.min(...tiers), Math.max(...tiers)];
  return min === max ? rubles(min) : `${rubles(min).replace(" ₽", "")}–${rubles(max)}`;
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
