// Findings of the audit after 0.5.4 (docs/AUDIT.md, «Аудит после 0.5.4»).
// Each test describes the right behaviour and is marked bug(...): green while
// the bug is there. Real failures: AUDIT_STRICT=1 npx vitest run audit054.
// After a fix replace bug( with it(.
import { mkdtempSync, promises as fs, readdirSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Agent, executeTool, PermissionGate, polzaImages, type AgentEvent, type ChatRequest, type ImageMaker, type Provider, type StreamEvent } from "../src";
import { modelKind } from "../src/providers/openai";

const bug = process.env.AUDIT_STRICT ? it : it.fails;

const tmp = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "dimosi-audit054-")));
const NO_GLOBAL = path.join(os.tmpdir(), "dimosi-no-global-rules.md");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function imageTool(opts: { bytes: Uint8Array; price?: () => Promise<string | undefined> }) {
  const root = tmp();
  const gate = new PermissionGate({ approve: async () => "allow" }, "ask");
  const counts = { paid: 0, priced: 0 };
  const images: ImageMaker = {
    model: "qwen/image-2",
    price: () => (counts.priced++, opts.price ? opts.price() : Promise.resolve("4 ₽")),
    generate: async () => (counts.paid++, { bytes: opts.bytes, cost: "4 ₽" }),
  };
  const run = (input: Record<string, unknown>, signal?: AbortSignal) =>
    executeTool({ type: "tool_call", id: "c", name: "generate_image", input }, { root, gate, images, signal });
  return { root, gate, counts, run };
}

describe("О-1: a paid picture must not be thrown away", () => {
  // The owner's own first picture came back as JPEG. The model asks for banner.png again
  // (there is no such file: the first one was saved as banner.jpg), the request is paid,
  // and only then the tool finds banner.jpg taken and drops the picture.
  it("the service sends another format and the file with that ending already exists", async () => {
    const { root, counts, run } = imageTool({ bytes: JPEG });
    const first = await run({ prompt: "баннер", path: "banner.png" });
    expect(first.isError).toBe(false);
    expect(readdirSync(root)).toEqual(["banner.jpg"]);

    const second = await run({ prompt: "баннер, вторая попытка", path: "banner.png" });
    const pictures = readdirSync(root).length;
    // Either the second picture is kept under a free name, or the call is refused before it is paid.
    expect({ paid: counts.paid, pictures, error: second.isError }).toSatisfy((r: { paid: number; pictures: number }) => r.paid === r.pictures);
  });

  it("a name that got taken while the picture was being made: the paid picture is kept under a free name", async () => {
    const root = tmp();
    const gate = new PermissionGate({ approve: async () => "allow" }, "ask");
    const shown: string[] = [];
    const images: ImageMaker = {
      model: "m",
      generate: async () => {
        await fs.writeFile(path.join(root, "banner.jpg"), "someone else's file");
        return { bytes: JPEG };
      },
    };
    const result = await executeTool(
      { type: "tool_call", id: "c", name: "generate_image", input: { prompt: "баннер", path: "banner.png" } },
      { root, gate, images, onImage: (i) => shown.push(i.relPath) },
    );
    expect(result).toMatchObject({ isError: false, content: expect.stringContaining("Saved the picture to banner-2.jpg") });
    expect(shown).toEqual(["banner-2.jpg"]);
    expect(await fs.readFile(path.join(root, "banner.jpg"), "utf8")).toBe("someone else's file");
    expect([...(await fs.readFile(path.join(root, "banner-2.jpg")))]).toEqual([...JPEG]);
  });

  it("the same name with the same format is refused before paying", async () => {
    const { counts, run } = imageTool({ bytes: PNG });
    await run({ prompt: "баннер", path: "banner.png" });
    const second = await run({ prompt: "баннер", path: "banner.png" });
    expect(second).toMatchObject({ isError: true, content: expect.stringContaining("already exists") });
    expect(counts.paid).toBe(1);
  });
});

describe("О-3: «Модель ничего не ответила» after a turn that did its work", () => {
  class Scripted implements Provider {
    readonly id = "fake";
    constructor(private turns: StreamEvent[][]) {}
    async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
      for (const ev of this.turns.shift() ?? []) yield ev;
    }
    async listModels() {
      return [];
    }
  }

  // Claude sometimes ends a turn with an empty reply after the tool results: it has already said everything.
  it("the model spoke, used a tool and ended with an empty reply: no error is shown", async () => {
    const provider = new Scripted([
      [
        { type: "text_delta", text: "Готово, отмечаю план." },
        {
          type: "done",
          stopReason: "tool_use",
          message: {
            role: "assistant",
            parts: [
              { type: "text", text: "Готово, отмечаю план." },
              { type: "tool_call", id: "t1", name: "update_plan", input: { items: [{ title: "Шаг", status: "done" }] } },
            ],
          },
        },
      ],
      [{ type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [] } }],
    ]);
    const agent = new Agent({ provider, model: "m", root: tmp(), approval: { approve: async () => "allow" }, globalRulesPath: NO_GLOBAL });
    const events: AgentEvent[] = [];
    for await (const ev of agent.run("сделай")) events.push(ev);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    expect(events.filter((e) => e.type === "error")).toEqual([]);
  });
});

describe("О-4: the model list filter and services that are not Polza AI or OpenRouter", () => {
  // `type` means "what the model makes" only at Polza AI. Elsewhere it is something else.
  it("Mistral: every model has type «base» and is still a chat model", () => {
    expect(modelKind({ id: "mistral-large-latest", object: "model", type: "base", capabilities: { completion_chat: true, function_calling: true } })).toBeUndefined();
  });

  it("Together AI: «language» and «code» models answer chat requests", () => {
    expect(modelKind({ id: "meta-llama/Llama-4-70b", object: "model", type: "language" })).toBeUndefined();
  });

  it("known kinds that do not chat are hidden at any service; at Polza AI any type but «chat»", () => {
    expect(modelKind({ id: "x/image", type: "image" })).toBe("image");
    expect(modelKind({ id: "x/embed", type: "embedding" })).toBe("embedding");
    expect(modelKind({ id: "x/rerank", type: "rerank" })).toBeUndefined();
    expect(modelKind({ id: "x/rerank", type: "rerank" }, true)).toBe("rerank");
    expect(modelKind({ id: "x/chat", type: "chat" }, true)).toBeUndefined();
  });

  it("(for comparison) services that say nothing keep all their models", () => {
    expect(modelKind({ id: "gpt-5", object: "model", owned_by: "openai" })).toBeUndefined();
    expect(modelKind({ id: "deepseek-chat", object: "model", owned_by: "deepseek" })).toBeUndefined();
    expect(modelKind({ id: "llama3", object: "model", owned_by: "library" })).toBeUndefined();
  });
});

describe("О-5: the price of a picture is asked for before the question", () => {
  it("Stop works while the price list is loading", async () => {
    const stop = new AbortController();
    const { run } = imageTool({ bytes: PNG, price: () => new Promise(() => undefined) });
    const call = run({ prompt: "кот", path: "cat.png" }, stop.signal);
    stop.abort(new Error("stopped"));
    const hung = Symbol("hung");
    const outcome = await Promise.race([call, new Promise((resolve) => setTimeout(() => resolve(hung), 300))]);
    expect(outcome).not.toBe(hung);
  });

  it("the real price request has a time limit of its own and listens to Stop", async () => {
    let init: RequestInit | undefined;
    const maker = polzaImages({ apiKey: "k", fetch: (async (_url: string, i?: RequestInit) => ((init = i), new Response("{}"))) as unknown as typeof fetch });
    await maker.price!();
    expect(init?.signal).toBeDefined();
  });

  it("plan mode: refused without any request to the service", async () => {
    const { gate, counts, run } = imageTool({ bytes: PNG });
    gate.planOnly = true;
    const result = await run({ prompt: "кот", path: "cat.png" });
    expect(result.isError).toBe(true);
    expect(counts).toEqual({ paid: 0, priced: 0 });
  });
});

describe("Р-2: the picture is downloaded from an address the service names", () => {
  it("a download larger than the limit is stopped, not read to the end", async () => {
    const MB = 1024 * 1024;
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 60 * MB) return controller.close();
        sent += MB;
        controller.enqueue(new Uint8Array(MB));
      },
    });
    const answers = [
      () => new Response(JSON.stringify({ id: "a", status: "completed", data: { url: "https://s3.polza.ai/x.png" } })),
      () => new Response(endless),
    ];
    const maker = polzaImages({ apiKey: "k", fetch: (async () => answers.shift()!()) as unknown as typeof fetch });
    await expect(maker.generate({ prompt: "кот" })).rejects.toThrow(/too large/);
    expect(sent).toBeLessThanOrEqual(32 * MB);
  });
});

describe("Р-2: the limit is 30 MB", () => {
  const completed = () => new Response(JSON.stringify({ id: "a", status: "completed", data: { url: "https://s3.polza.ai/x.png" } }));
  const maker = (picture: () => Response) => {
    const answers = [completed, picture];
    return polzaImages({ apiKey: "k", fetch: (async () => answers.shift()!()) as unknown as typeof fetch });
  };

  it("a picture just under the limit is kept whole", async () => {
    const big = new Uint8Array(29 * 1024 * 1024);
    big.set(PNG);
    const image = await maker(() => new Response(big)).generate({ prompt: "кот" });
    expect(image.bytes.length).toBe(big.length);
    expect([...image.bytes.subarray(0, PNG.length)]).toEqual([...PNG]);
  });

  it("a size announced over the limit is refused without reading", async () => {
    let read = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        read++;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const refused = maker(() => new Response(body, { headers: { "content-length": String(31 * 1024 * 1024) } })).generate({ prompt: "кот" });
    await expect(refused).rejects.toThrow("too large (over 30 MB)");
    expect(read).toBeLessThanOrEqual(2);
  });
});

describe("checked and fine", () => {
  it("the tool set does not depend on the service or on the Polza AI key", async () => {
    const seen: string[][] = [];
    const provider: Provider = {
      id: "fake",
      async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
        seen.push(req.tools.map((t) => t.name));
        yield { type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [{ type: "text", text: "ок" }] } };
      },
      listModels: async () => [],
    };
    const agent = new Agent({ provider, model: "m", root: tmp(), approval: { approve: async () => "allow" }, globalRulesPath: NO_GLOBAL });
    for await (const _ of agent.run("раз")) void _;
    agent.images = { model: "x", generate: async () => ({ bytes: PNG }) };
    for await (const _ of agent.run("два")) void _;
    agent.images = undefined;
    for await (const _ of agent.run("три")) void _;
    expect(seen).toHaveLength(3);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
    expect(seen[0]).toContain("generate_image");
  });

  it("a picture is not written over a file, through a link, into .git or outside the project", async () => {
    const { root, counts, run } = imageTool({ bytes: PNG });
    const outside = tmp();
    await fs.mkdir(path.join(root, ".git"));
    await fs.symlink(outside, path.join(root, "out"));
    await fs.symlink(path.join(outside, "target.png"), path.join(root, "dangling.png"));
    for (const p of [".git/x.png", "out/x.png", "../x.png", path.join(outside, "x.png"), "dangling.png", ".env.png/../.env"]) {
      expect(await run({ prompt: "кот", path: p }), p).toMatchObject({ isError: true });
    }
    expect(counts.paid).toBe(0);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("hidden characters in the description or in the path give a warning on the question", async () => {
    const root = tmp();
    const warnings: Array<string | undefined> = [];
    const gate = new PermissionGate({ approve: async (req) => (warnings.push(req.warning), "deny") }, "auto");
    const images: ImageMaker = { model: "m", generate: async () => ({ bytes: PNG }) };
    const run = (input: Record<string, unknown>) => executeTool({ type: "tool_call", id: "c", name: "generate_image", input }, { root, gate, images });
    await run({ prompt: "кот‮текст", path: "a.png" });
    await run({ prompt: "кот", path: "a​.png" });
    expect(warnings).toHaveLength(2);
    for (const w of warnings) expect(w).toMatch(/скрытые символы/);
  });
});
