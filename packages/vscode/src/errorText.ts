// Must not import "vscode": used everywhere, tested directly.

/** Text for anything thrown: VS Code commands may reject with values that are not Errors. */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name || "неизвестная ошибка";
  if (typeof e === "string") return e || "неизвестная ошибка";
  if (e === undefined || e === null) return "неизвестная ошибка";
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
