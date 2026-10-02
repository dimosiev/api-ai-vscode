import { diffLines, structuredPatch } from "diff";
import type { DiffRow, DiffView } from "./protocol";

const MAX_ROWS = 400;

/** Unified diff rows for the chat card. */
export function buildDiffView(oldText: string | null, newText: string): DiffView {
  const patch = structuredPatch("a", "b", oldText ?? "", newText, "", "", { context: 3 });
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let truncated = false;
  for (const hunk of patch.hunks) {
    if (rows.length >= MAX_ROWS) truncated = true;
    if (!truncated) rows.push({ t: "hunk", text: `@@ −${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` });
    let o = hunk.oldStart;
    let n = hunk.newStart;
    for (const line of hunk.lines) {
      const mark = line[0];
      const text = line.slice(1);
      if (mark === "\\") continue; // "\ No newline at end of file"
      if (mark === "+") added++;
      else if (mark === "-") removed++;
      if (rows.length >= MAX_ROWS) {
        truncated = true;
      } else if (mark === "+") {
        rows.push({ t: "add", text, new: n });
      } else if (mark === "-") {
        rows.push({ t: "del", text, old: o });
      } else {
        rows.push({ t: "ctx", text, old: o, new: n });
      }
      if (mark !== "+") o++;
      if (mark !== "-") n++;
    }
  }
  return { rows, added, removed, truncated };
}

/** Added / removed line counts between two versions. */
export function countChanges(oldText: string | null, newText: string | null): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(oldText ?? "", newText ?? "")) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}
