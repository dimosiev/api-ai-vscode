import { promises as fs } from "node:fs";
import type { FileChange } from "@dimosi/core";
import { countChanges } from "./diff";
import type { ChangedFileView } from "./protocol";

interface TrackedFile {
  path: string;
  /** Content before the agent touched it in this turn; null if the agent created it. */
  original: string | null;
  /** What the agent last wrote. */
  current: string;
  reverted: boolean;
}

export type RevertResult = { ok: true } | { ok: false; reason: "modified_since" | "error"; message: string };

/** Remembers what the agent changed during one task so it can be undone. */
export class ChangeTracker {
  private files = new Map<string, TrackedFile>();

  record(change: FileChange): void {
    const existing = this.files.get(change.relPath);
    if (existing) {
      existing.current = change.newContent;
      existing.reverted = false;
    } else {
      this.files.set(change.relPath, {
        path: change.path,
        original: change.oldContent,
        current: change.newContent,
        reverted: false,
      });
    }
  }

  get isEmpty(): boolean {
    return this.files.size === 0;
  }

  summary(): ChangedFileView[] {
    return [...this.files.entries()]
      .map(([relPath, f]) => ({
        relPath,
        ...countChanges(f.original, f.current),
        created: f.original === null,
        reverted: f.reverted,
      }))
      .filter((f) => f.added || f.removed || f.created || f.reverted);
  }

  has(relPath: string): boolean {
    return this.files.has(relPath);
  }

  relPaths(): string[] {
    return [...this.files.keys()];
  }

  /**
   * Restores the original content (or deletes a file the agent created).
   * Refuses when the file changed after the agent wrote it, unless forced.
   */
  async revert(relPath: string, force = false): Promise<RevertResult> {
    const f = this.files.get(relPath);
    if (!f || f.reverted) return { ok: true };
    try {
      let onDisk: string | null;
      try {
        onDisk = await fs.readFile(f.path, "utf8");
      } catch {
        onDisk = null;
      }
      if (!force && onDisk !== f.current) {
        return { ok: false, reason: "modified_since", message: `${relPath} изменён после агента.` };
      }
      if (f.original === null) {
        if (onDisk !== null) await fs.unlink(f.path);
      } else {
        await fs.writeFile(f.path, f.original, "utf8");
      }
      f.reverted = true;
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: "error", message: (e as Error).message };
    }
  }
}
