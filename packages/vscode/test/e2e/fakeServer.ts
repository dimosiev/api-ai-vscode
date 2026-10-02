// A fake OpenAI-compatible server on 127.0.0.1 for end-to-end tests: replies
// to /v1/chat/completions with scripted streams, like Polza AI or Ollama.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeReply {
  /** HTTP error instead of a stream. */
  status?: number;
  error?: string;
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

export interface ChatBody {
  model: string;
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }>;
  stream: boolean;
}

export interface FakeServer {
  /** Base URL including /v1. */
  url: string;
  requests: Array<{ body: ChatBody; auth?: string }>;
  close(): Promise<void>;
}

type Script = Array<FakeReply | ((body: ChatBody) => FakeReply)>;

export async function startFakeServer(script: Script): Promise<FakeServer> {
  const requests: FakeServer["requests"] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") return json(res, 200, { object: "list", data: [{ id: "fake-model", object: "model" }] });
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return json(res, 404, { error: { message: "not found" } });
    const body = JSON.parse(await readBody(req)) as ChatBody;
    requests.push({ body, auth: req.headers.authorization });
    const next = script.shift();
    if (!next) return json(res, 500, { error: { message: "fake server: no more scripted replies" } });
    const reply = typeof next === "function" ? next(body) : next;
    if (reply.status) {
      // Ask the SDK to retry right away instead of waiting seconds.
      res.setHeader("retry-after-ms", "10");
      return json(res, reply.status, { error: { message: reply.error ?? "error", type: "fake" } });
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (reply.text) {
      // Two pieces, like a real stream.
      const half = Math.ceil(reply.text.length / 2);
      chunk({ role: "assistant", content: reply.text.slice(0, half) });
      chunk({ content: reply.text.slice(half) });
    }
    (reply.toolCalls ?? []).forEach((c, i) =>
      chunk({ tool_calls: [{ index: i, id: `call_${requests.length}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] }),
    );
    chunk({}, reply.toolCalls?.length ? "tool_calls" : "stop");
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Everything the model was sent, as one string (for "is X in the history?" checks). */
export function sentText(body: ChatBody): string {
  return JSON.stringify(body.messages);
}
