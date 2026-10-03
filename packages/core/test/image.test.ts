import { existsSync, mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { executeTool, imageFormat, PermissionGate, polzaImages, type ApprovalRequest, type ImageMaker } from "../src";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "dimosi-image-"));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A stand-in for Polza AI: answers by the list, records what it was asked. */
function polza(answers: Array<() => Response>) {
  const calls: Array<{ url: string; method: string; auth: string | null; body?: any }> = [];
  const fetchMock = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({ url: String(url), method: init.method ?? "GET", auth: headers.get("authorization"), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next();
  }) as unknown as typeof fetch;
  return { calls, fetchMock };
}

describe("imageFormat", () => {
  it("tells a picture by its first bytes", () => {
    expect(imageFormat(PNG)).toBe("png");
    expect(imageFormat(JPEG)).toBe("jpg");
    expect(imageFormat(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(imageFormat(new TextEncoder().encode("<html>not a picture</html>"))).toBeUndefined();
    expect(imageFormat(new Uint8Array())).toBeUndefined();
  });
});

describe("polzaImages (Polza AI Media API)", () => {
  it("starts a generation, waits until it is ready and downloads the picture without sending the key to the storage", async () => {
    const { calls, fetchMock } = polza([
      () => json({ id: "aig_1", object: "media.generation", status: "pending", model: "qwen/image-2" }),
      () => json({ id: "aig_1", status: "processing" }),
      () => json({ id: "aig_1", status: "completed", data: { url: "https://s3.polza.ai/f/1/aig_1.png" }, usage: { output_units: 1, cost_rub: 4 } }),
      () => new Response(PNG),
    ]);
    const maker = polzaImages({ apiKey: "pz-key", fetch: fetchMock, pollMs: 1 });
    expect(maker.model).toBe("qwen/image-2");
    const image = await maker.generate({ prompt: "уютный книжный магазин", aspectRatio: "16:9" });

    expect([...image.bytes]).toEqual([...PNG]);
    expect(image.cost).toBe("4 ₽");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://polza.ai/api/v1/media",
      "GET https://polza.ai/api/v1/media/aig_1",
      "GET https://polza.ai/api/v1/media/aig_1",
      "GET https://s3.polza.ai/f/1/aig_1.png",
    ]);
    expect(calls[0].body).toEqual({ model: "qwen/image-2", input: { prompt: "уютный книжный магазин", aspect_ratio: "16:9" } });
    expect(calls.map((c) => c.auth)).toEqual(["Bearer pz-key", "Bearer pz-key", "Bearer pz-key", null]);
  });

  it("takes a picture that is ready at once, and the model from the settings", async () => {
    const { calls, fetchMock } = polza([() => json({ id: "aig_2", status: "completed", data: [{ url: "https://cdn.polza.ai/x.jpg" }] }), () => new Response(JPEG)]);
    const image = await polzaImages({ apiKey: "k", model: " bytedance/seedream-4 ", fetch: fetchMock }).generate({ prompt: "кот" });
    expect(imageFormat(image.bytes)).toBe("jpg");
    expect(image.cost).toBeUndefined();
    expect(calls[0].body).toEqual({ model: "bytedance/seedream-4", input: { prompt: "кот" } });
  });

  it("passes on why the service refused", async () => {
    const paid = polza([() => json({ error: { code: "INSUFFICIENT_BALANCE", message: "Недостаточно средств" } }, 402)]);
    await expect(polzaImages({ apiKey: "k", fetch: paid.fetchMock }).generate({ prompt: "кот" })).rejects.toThrow("The image service answered 402: Недостаточно средств");

    const failed = polza([
      () => json({ id: "aig_3", status: "pending" }),
      () => json({ id: "aig_3", status: "failed", error: { code: "BAD_GATEWAY", message: "Ошибка генерации", metadata: { raw: "content policy violation" } } }),
    ]);
    await expect(polzaImages({ apiKey: "k", fetch: failed.fetchMock, pollMs: 1 }).generate({ prompt: "кот" })).rejects.toThrow(
      "The image service could not make the picture: Ошибка генерации (content policy violation)",
    );
  });

  it("does not follow an address that is not https, and gives up waiting", async () => {
    const plain = polza([() => json({ id: "a", status: "completed", data: { url: "http://example.com/x.png" } })]);
    await expect(polzaImages({ apiKey: "k", fetch: plain.fetchMock }).generate({ prompt: "кот" })).rejects.toThrow("gave no picture address");
    expect(plain.calls).toHaveLength(1);

    const slow = polza(Array.from({ length: 50 }, () => () => json({ id: "a", status: "processing" })));
    await expect(polzaImages({ apiKey: "k", fetch: slow.fetchMock, pollMs: 5, timeoutMs: 20 }).generate({ prompt: "кот" })).rejects.toThrow(/was not ready in/);
  });

  it("stops waiting when the user presses Stop", async () => {
    const stop = new AbortController();
    const { fetchMock } = polza([
      () => {
        queueMicrotask(() => stop.abort(new Error("stopped")));
        return json({ id: "a", status: "pending" });
      },
    ]);
    await expect(polzaImages({ apiKey: "k", fetch: fetchMock, pollMs: 60_000 }).generate({ prompt: "кот", signal: stop.signal })).rejects.toThrow("stopped");
  });

  it("reads the price of one picture from the model list", async () => {
    const list = {
      data: [
        { id: "qwen/image-2", top_provider: { pricing: { per_request: "4.00", currency: "RUB" } } },
        { id: "qwen/image-2.1", top_provider: { pricing: { tiers: [{ cost_rub: "6.00000000" }, { cost_rub: "3.00000000" }], currency: "RUB" } } },
        { id: "free/model" },
      ],
    };
    const price = (model: string) => polzaImages({ apiKey: "k", model, fetch: polza([() => json(list)]).fetchMock }).price!();
    expect(await price("qwen/image-2")).toBe("4 ₽");
    expect(await price("qwen/image-2.1")).toBe("3–6 ₽");
    expect(await price("free/model")).toBeUndefined();
    expect(await polzaImages({ apiKey: "k", fetch: polza([() => json({}, 500)]).fetchMock }).price!()).toBeUndefined();
  });
});

describe("generate_image", () => {
  function setup(opts: { bytes?: Uint8Array; decision?: "allow" | "deny" | "allow_always"; mode?: "ask" | "auto"; maker?: boolean } = {}) {
    const root = tmp();
    const asked: ApprovalRequest[] = [];
    const prompts: Array<{ prompt: string; aspectRatio?: string }> = [];
    const shown: Array<{ path: string; relPath: string }> = [];
    const gate = new PermissionGate({ approve: async (req) => (asked.push(req), opts.decision ?? "allow") }, opts.mode ?? "auto");
    const images: ImageMaker = {
      model: "qwen/image-2",
      price: async () => "4 ₽",
      generate: async ({ prompt, aspectRatio }) => (prompts.push({ prompt, aspectRatio }), { bytes: opts.bytes ?? PNG, cost: "4 ₽" }),
    };
    const run = (input: Record<string, unknown>) =>
      executeTool({ type: "tool_call", id: "c", name: "generate_image", input }, { root, gate, images: opts.maker === false ? undefined : images, onImage: (i) => shown.push(i) });
    return { root, asked, prompts, shown, gate, run };
  }

  it("asks the user even without approvals, then saves the picture and shows it", async () => {
    const { root, asked, prompts, shown, run } = setup();
    const result = await run({ prompt: "баннер о погоде", path: "images/banner.png", aspect_ratio: "16:9" });

    expect(result).toEqual({ isError: false, content: "Saved the picture to images/banner.png (1 KB, model qwen/image-2, cost 4 ₽). The user sees it in the chat." });
    expect(asked).toEqual([{ kind: "image", prompt: "баннер о погоде", path: path.join(root, "images/banner.png"), relPath: "images/banner.png", model: "qwen/image-2", price: "4 ₽", warning: undefined }]);
    expect(prompts).toEqual([{ prompt: "баннер о погоде", aspectRatio: "16:9" }]);
    expect([...(await fs.readFile(path.join(root, "images/banner.png")))]).toEqual([...PNG]);
    expect(shown).toEqual([{ path: path.join(root, "images/banner.png"), relPath: "images/banner.png" }]);
  });

  it("asks every time: «Always» is not remembered", async () => {
    const { asked, run } = setup({ decision: "allow_always" });
    await run({ prompt: "раз", path: "a.png" });
    await run({ prompt: "два", path: "b.png" });
    expect(asked).toHaveLength(2);
  });

  it("makes nothing and spends nothing when the user says no", async () => {
    const { root, prompts, run } = setup({ decision: "deny" });
    expect(await run({ prompt: "кот", path: "cat.png" })).toEqual({ isError: true, content: "The user did not allow making this picture." });
    expect(prompts).toEqual([]);
    expect(existsSync(path.join(root, "cat.png"))).toBe(false);
  });

  it("is refused in plan mode without a question", async () => {
    const { asked, prompts, gate, run } = setup();
    gate.planOnly = true;
    expect((await run({ prompt: "кот", path: "cat.png" })).content).toMatch(/^Plan mode is on/);
    expect(asked).toEqual([]);
    expect(prompts).toEqual([]);
  });

  it("gives the file the ending of the real format", async () => {
    const { root, shown, run } = setup({ bytes: JPEG });
    expect((await run({ prompt: "кот", path: "cat.png" })).content).toMatch(/^Saved the picture to cat\.jpg /);
    expect(existsSync(path.join(root, "cat.jpg"))).toBe(true);
    expect(existsSync(path.join(root, "cat.png"))).toBe(false);
    expect(shown[0].relPath).toBe("cat.jpg");
    const jpeg = setup({ bytes: JPEG });
    expect((await jpeg.run({ prompt: "кот", path: "cat.jpeg" })).content).toMatch(/^Saved the picture to cat\.jpeg /);
  });

  it("never replaces a file: the check comes before the question and the payment", async () => {
    const { root, asked, prompts, run } = setup();
    await fs.writeFile(path.join(root, "logo.png"), "mine");
    expect(await run({ prompt: "кот", path: "logo.png" })).toEqual({ isError: true, content: "logo.png already exists. Choose another file name." });
    expect(asked).toEqual([]);
    expect(prompts).toEqual([]);
    expect(await fs.readFile(path.join(root, "logo.png"), "utf8")).toBe("mine");
  });

  it("saves nothing when the service sent something that is not a picture", async () => {
    const { root, shown, run } = setup({ bytes: new TextEncoder().encode("<html>error</html>") });
    expect((await run({ prompt: "кот", path: "cat.png" })).content).toMatch(/not a PNG, JPEG or WebP picture/);
    expect(await fs.readdir(root)).toEqual([]);
    expect(shown).toEqual([]);
  });

  it.each([
    [{ prompt: "кот", path: "cat.svg" }, /must end in \.png, \.jpg or \.webp/],
    [{ prompt: "кот", path: "run.sh" }, /must end in/],
    [{ prompt: "  ", path: "cat.png" }, /"prompt" is empty/],
    [{ prompt: "кот", path: "cat.png", aspect_ratio: "wide" }, /"aspect_ratio" must look like/],
    [{ prompt: "кот", path: "../outside.png" }, /outside/i],
    [{ prompt: "кот", path: ".git/hooks/x.png" }, /\.git is not allowed/],
  ])("refuses %j before asking", async (input, message) => {
    const { asked, prompts, run } = setup();
    const result = await run(input);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(message);
    expect(asked).toEqual([]);
    expect(prompts).toEqual([]);
  });

  it("explains what is missing when there is no Polza AI key", async () => {
    const { asked, run } = setup({ maker: false });
    expect((await run({ prompt: "кот", path: "cat.png" })).content).toMatch(/need its API key/);
    expect(asked).toEqual([]);
  });

  it("warns about hidden characters in the description", async () => {
    const { asked, run } = setup();
    await run({ prompt: "кот‮тайно", path: "cat.png" });
    expect(asked[0]).toMatchObject({ kind: "image", warning: expect.stringMatching(/скрытые символы/) });
  });
});
