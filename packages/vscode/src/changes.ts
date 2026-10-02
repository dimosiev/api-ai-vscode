import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { diskFiles, type FileAccess, type FileChange } from "@dimosi/core";
import { countChanges } from "./diff";
import type { ChangedFileView } from "./protocol";

interface TrackedFile {
  path: string;
  /** Content before the agent touched it in this turn; null if the agent created it. */
  original: string | null;
  /** Hash of what the agent last wrote: tells whether someone changed the file since. */
  currentHash: string;
  added: number;
  removed: number;
  reverted: boolean;
  /** The original was not kept (the saved chat was too big), so it can't be restored. */
  unavailable?: boolean;
}

/** One task's changes as stored in the saved chat. */
export interface SavedTracker {
  files: Array<TrackedFile & { relPath: string }>;
}

export type RevertResult = { ok: true } | { ok: false; reason: "modified_since" | "error"; message: string };

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Remembers what the agent changed during one task so it can be undone. */
export class ChangeTracker {
  private files = new Map<string, TrackedFile>();

  /** `io` reads and writes like the agent did (in VS Code: through open editors). */
  constructor(private io: FileAccess = diskFiles) {}

  record(change: FileChange): void {
    const existing = this.files.get(change.relPath);
    const original = existing ? existing.original : change.oldContent;
    this.files.set(change.relPath, {
      path: change.path,
      original,
      currentHash: hash(change.newContent),
      ...countChanges(original, change.newContent),
      reverted: false,
      unavailable: existing?.unavailable,
    });
  }

  get isEmpty(): boolean {
    return this.files.size === 0;
  }

  summary(): ChangedFileView[] {
    return [...this.files.entries()]
      .map(([relPath, f]) => ({
        relPath,
        added: f.added,
        removed: f.removed,
        created: f.original === null && !f.unavailable,
        reverted: f.reverted,
        unavailable: Boolean(f.unavailable) && !f.reverted,
      }))
      .filter((f) => f.added || f.removed || f.created || f.reverted || f.unavailable);
  }

  has(relPath: string): boolean {
    return this.files.has(relPath);
  }

  relPaths(): string[] {
    return [...this.files.keys()];
  }

  /** Files that can still be reverted. */
  revertible(): string[] {
    return [...this.files.entries()].filter(([, f]) => !f.reverted && !f.unavailable).map(([relPath]) => relPath);
  }

  /**
   * Restores the original content (or deletes a file the agent created).
   * Refuses when the file changed after the agent wrote it, unless forced.
   */
  async revert(relPath: string, force = false): Promise<RevertResult> {
    const f = this.files.get(relPath);
    if (!f || f.reverted) return { ok: true };
    if (f.unavailable) {
      return { ok: false, reason: "error", message: "откат недоступен: исходная версия файла не сохранилась (чат был слишком большим)." };
    }
    try {
      let current: string | null;
      try {
        current = await this.io.readText(f.path);
      } catch {
        current = null;
      }
      if (!force && (current === null || hash(current) !== f.currentHash)) {
        return { ok: false, reason: "modified_since", message: `${relPath} изменён после агента.` };
      }
      if (f.original === null) {
        await fs.rm(f.path, { force: true });
      } else {
        await this.io.writeText(f.path, f.original);
      }
      f.reverted = true;
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: "error", message: (e as Error).message };
    }
  }

  toJSON(): SavedTracker {
    return { files: [...this.files.entries()].map(([relPath, f]) => ({ relPath, ...f })) };
  }

  static fromJSON(data: SavedTracker, io?: FileAccess): ChangeTracker {
    const t = new ChangeTracker(io);
    for (const { relPath, ...f } of data.files) t.files.set(relPath, { ...f });
    return t;
  }

  /** Checks data loaded from disk; undefined when it is not a saved tracker. */
  static parse(data: unknown): SavedTracker | undefined {
    const files = (data as SavedTracker | undefined)?.files;
    if (!Array.isArray(files)) return undefined;
    const ok = files.every(
      (f) =>
        f &&
        typeof f.relPath === "string" &&
        typeof f.path === "string" &&
        (f.original === null || typeof f.original === "string") &&
        typeof f.currentHash === "string" &&
        typeof f.added === "number" &&
        typeof f.removed === "number" &&
        typeof f.reverted === "boolean",
    );
    return ok ? { files } : undefined;
  }
}

/**
 * Drops the kept originals of a saved tracker to save space. Files the agent
 * created stay revertible: undoing them only means deleting.
 */
export function dropOriginals(saved: SavedTracker): void {
  for (const f of saved.files) {
    if (f.original !== null && !f.reverted) {
      f.original = null;
      f.unavailable = true;
    }
  }
}
