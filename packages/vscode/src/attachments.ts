import { realpathSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { isSecretFile, type ImagePart, type TextPart } from "@dimosi/core";
import type { ChipView } from "./protocol";

export const MAX_TEXT_CHARS = 100_000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface Attachment extends ChipView {
  /** Identifies duplicates (path or selection range). */
  key: string;
  parts: Array<TextPart | ImagePart>;
}

let counter = 0;
const nextId = () => `att${++counter}`;

export function imageMediaType(name: string): string | undefined {
  return IMAGE_TYPES[path.extname(name).toLowerCase()];
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function fileBlock(label: string, text: string, extra = ""): TextPart {
  const truncated = text.length > MAX_TEXT_CHARS;
  // The file must not end its own block early: text after a fake </file> would look like the user's words.
  const body = (truncated ? text.slice(0, MAX_TEXT_CHARS) + "\n[... файл обрезан, он слишком большой]" : text).replace(/<\/file\s*>/gi, "<\\/file>");
  return { type: "text", text: `<file path="${escapeAttr(label)}"${extra}>\n${body}\n</file>` };
}

/** Whatever is attached goes to the AI service, so files with keys and passwords are refused (links too). */
export function isSecretPath(fsPath: string): boolean {
  let real = fsPath;
  try {
    real = realpathSync(fsPath);
  } catch {
    // not on disk: only the name counts
  }
  return isSecretFile(fsPath) || isSecretFile(real);
}

function assertNotSecret(fsPath: string, label: string): void {
  if (isSecretPath(fsPath)) {
    throw new Error(
      `${label} не прикреплён: в таких файлах обычно хранятся пароли и ключи, а прикреплённый текст уходит сервису ИИ. ` +
        "Если нужно, напишите в сообщении только то, что можно показать (например, названия настроек без значений).",
    );
  }
}

export function imageAttachment(name: string, mediaType: string, base64: string): Attachment {
  const bytes = Math.floor((base64.length * 3) / 4);
  if (!Object.values(IMAGE_TYPES).includes(mediaType)) throw new Error("Поддерживаются картинки PNG, JPG, GIF и WebP.");
  if (bytes > MAX_IMAGE_BYTES) throw new Error(`Картинка ${name} больше 5 МБ.`);
  return {
    id: nextId(),
    key: `image:${name}:${base64.length}`,
    label: name,
    kind: "image",
    parts: [{ type: "image", mediaType, data: base64 }],
  };
}

/** Reads a file from disk (inside or outside the project) as an attachment. */
export async function fileAttachment(uri: vscode.Uri, root: string | undefined): Promise<Attachment> {
  const label = root && uri.fsPath.startsWith(root + path.sep) ? path.relative(root, uri.fsPath).split(path.sep).join("/") : path.basename(uri.fsPath);
  assertNotSecret(uri.fsPath, label);
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type & vscode.FileType.Directory) throw new Error(`${label} — это папка. Прикрепляйте файлы.`);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const mediaType = imageMediaType(uri.fsPath);
  if (mediaType) {
    const att = imageAttachment(label, mediaType, Buffer.from(bytes).toString("base64"));
    return { ...att, key: `file:${uri.fsPath}` };
  }
  if (bytes.includes(0)) throw new Error(`${label} — двоичный файл, его нельзя прикрепить как текст.`);
  const text = Buffer.from(bytes).toString("utf8");
  return { id: nextId(), key: `file:${uri.fsPath}`, label, kind: "file", parts: [fileBlock(label, text)] };
}

export function selectionAttachment(editor: vscode.TextEditor, root: string | undefined): Attachment | undefined {
  const sel = editor.selection;
  if (sel.isEmpty) return undefined;
  const doc = editor.document;
  const fsPath = doc.uri.fsPath;
  const name = root && fsPath.startsWith(root + path.sep) ? path.relative(root, fsPath).split(path.sep).join("/") : path.basename(fsPath);
  assertNotSecret(fsPath, name);
  const from = sel.start.line + 1;
  const to = sel.end.line + 1;
  const label = from === to ? `${name}:${from}` : `${name}:${from}-${to}`;
  return {
    id: nextId(),
    key: `sel:${fsPath}:${from}-${to}`,
    label,
    kind: "selection",
    parts: [fileBlock(name, doc.getText(sel), ` lines="${from}-${to}"`)],
  };
}
