// Pictures made by generate_image, for the chat panel. No `vscode` import: tested directly.
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { IMAGE_EXTENSIONS, imageFormat } from "@dimosi/core";

/** Larger pictures are not drawn in the panel; the file can still be opened. */
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

export function isPicturePath(file: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(path.extname(file).slice(1).toLowerCase());
}

/**
 * The picture as a `data:` address for an <img>. The panel is not trusted and
 * names the file itself, so only a real picture is given out: by its name and
 * by its first bytes. Undefined for anything else.
 */
export async function pictureDataUrl(abs: string): Promise<string | undefined> {
  if (!isPicturePath(abs)) return undefined;
  try {
    const { size } = await fs.stat(abs);
    if (size > MAX_PREVIEW_BYTES) return undefined;
    const bytes = await fs.readFile(abs);
    const format = imageFormat(bytes);
    if (!format) return undefined;
    return `data:image/${format === "jpg" ? "jpeg" : format};base64,${bytes.toString("base64")}`;
  } catch {
    return undefined;
  }
}
