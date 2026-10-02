// Must not import "vscode": tested directly.

/**
 * The smallest single replacement that turns `before` into `after`: offsets
 * into `before` plus the new text. Replacing only the changed middle keeps
 * the cursor, folds and scroll position of an open editor. Undefined when
 * nothing changes. Never splits a Windows line break.
 */
export function minimalEdit(before: string, after: string): { start: number; end: number; text: string } | undefined {
  if (before === after) return undefined;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < max - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  if (start > 0 && before[start - 1] === "\r") start--;
  if (tail > 0 && before[before.length - tail] === "\n" && before[before.length - tail - 1] === "\r") tail--;
  return { start, end: before.length - tail, text: after.slice(start, after.length - tail) };
}
