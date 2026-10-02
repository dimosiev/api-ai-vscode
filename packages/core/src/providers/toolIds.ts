import { createHash } from "node:crypto";

/**
 * Tool call ids travel between providers when the user switches mid-chat.
 * Anthropic accepts only [a-zA-Z0-9_-] and unique ids; OpenAI allows at most
 * 40 characters. Some servers send ids like "functions.read_file:0" and reuse
 * them every turn. Maps each id to a safe one, keeping calls and their results
 * paired (a result always follows its call in the history).
 */
export class ToolIdMapper {
  private seen = new Map<string, number>();
  private current = new Map<string, string>();

  call(id: string): string {
    const n = (this.seen.get(id) ?? 0) + 1;
    this.seen.set(id, n);
    const mapped = safeId(n > 1 ? `${id}_${n}` : id);
    this.current.set(id, mapped);
    return mapped;
  }

  result(id: string): string {
    return this.current.get(id) ?? safeId(id);
  }
}

function safeId(id: string): string {
  if (/^[a-zA-Z0-9_-]{1,40}$/.test(id)) return id;
  // The hash of the original keeps different ids different after cleaning.
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return `${id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 31)}_${hash}`;
}
