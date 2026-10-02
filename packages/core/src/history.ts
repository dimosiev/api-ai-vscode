import type { Message, Part } from "./types";

/**
 * Checks a conversation loaded from disk. Anything unexpected (a damaged
 * file, a format from another version) returns undefined, so the host starts
 * a new chat instead of sending a broken history to the model.
 */
export function parseMessages(json: unknown): Message[] | undefined {
  if (!Array.isArray(json)) return undefined;
  for (const m of json) {
    if (!m || typeof m !== "object") return undefined;
    if (m.role !== "user" && m.role !== "assistant") return undefined;
    if (!Array.isArray(m.parts) || !m.parts.every(isPart)) return undefined;
    if (m.providerData !== undefined) {
      const d = m.providerData;
      if (!d || typeof d !== "object" || typeof d.provider !== "string" || typeof d.model !== "string") return undefined;
    }
  }
  return json as Message[];
}

function isPart(p: unknown): p is Part {
  if (!p || typeof p !== "object") return false;
  const x = p as Record<string, unknown>;
  switch (x.type) {
    case "text":
      return typeof x.text === "string";
    case "image":
      return typeof x.mediaType === "string" && typeof x.data === "string";
    case "tool_call":
      return typeof x.id === "string" && typeof x.name === "string" && !!x.input && typeof x.input === "object";
    case "tool_result":
      return typeof x.toolCallId === "string" && typeof x.content === "string";
    default:
      return false;
  }
}

export const IMAGE_REMOVED = "[A picture was attached here; it was removed when the chat was saved.]";

/**
 * Replaces attached pictures with a short note. Pictures are only ever in the
 * user's messages, so the model's own messages stay untouched. Returns true
 * if anything was removed.
 */
export function stripImages(messages: Message[]): boolean {
  let removed = false;
  for (const m of messages) {
    if (m.role !== "user") continue;
    m.parts = m.parts.map((p) => {
      if (p.type !== "image") return p;
      removed = true;
      return { type: "text", text: IMAGE_REMOVED };
    });
  }
  return removed;
}
