import * as vscode from "vscode";
import { diskFiles, NotUtf8Error, type FileAccess } from "@dimosi/core";
import { minimalEdit } from "./textEdit";

const UTF8 = new Set(["utf8", "utf8bom"]);

function openDocument(abs: string): vscode.TextDocument | undefined {
  const target = vscode.Uri.file(abs).toString();
  return vscode.workspace.textDocuments.find((d) => !d.isClosed && d.uri.toString() === target);
}

/**
 * Files as the user sees them in VS Code. An open file is read from its
 * editor, unsaved edits included, and changed with a WorkspaceEdit followed
 * by a save: the change lands in the editor's undo history (Ctrl+Z) and the
 * user's own unsaved typing is kept. Files that are not open use the disk.
 */
export const editorFiles: FileAccess = {
  async readText(abs) {
    // The disk check refuses files that are not UTF-8 even when they are open.
    const onDisk = await diskFiles.readText(abs);
    const doc = openDocument(abs);
    if (!doc) return onDisk;
    if (!UTF8.has(doc.encoding)) throw new NotUtf8Error();
    return doc.getText();
  },

  async writeText(abs, text) {
    const doc = openDocument(abs);
    if (!doc) return diskFiles.writeText(abs, text);
    const change = minimalEdit(doc.getText(), text);
    if (change) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(change.start), doc.positionAt(change.end)), change.text);
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error("VS Code did not apply the change to the open file.");
    }
    if (doc.isDirty && !(await doc.save())) throw new Error("VS Code could not save the file.");
    // Formatting on save or line-ending rules may adjust the text: report what is really there.
    return doc.getText();
  },
};
