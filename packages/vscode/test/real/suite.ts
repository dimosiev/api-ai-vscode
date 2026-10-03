// Runs inside a real VS Code (started by run.mjs): the built extension, the
// real chat panel and VS Code's own language services, against the fake
// model server on 127.0.0.1. Not a vitest file: VS Code loads it and calls run().
import * as assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { startFakeServer } from "../e2e/fakeServer";

/** Polls a condition: a busy machine (CI) is slower. */
async function eventually<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const step = (name: string) => console.log(`  ✓ ${name}`);

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, "the test workspace folder is open");

  const extension = vscode.extensions.getExtension("dimosi.dimosi");
  assert.ok(extension, "the extension is installed");
  await extension.activate();
  step(`dimosi ${extension.packageJSON.version} starts in VS Code ${vscode.version}`);

  const commands = await vscode.commands.getCommands(true);
  for (const { command } of extension.packageJSON.contributes.commands as Array<{ command: string }>) {
    assert.ok(commands.includes(command), `command ${command} is registered`);
  }
  step("every command of package.json is registered");

  const config = vscode.workspace.getConfiguration("dimosi");
  for (const [key, value] of Object.entries({ provider: "anthropic", approvalMode: "ask", sandbox: true, extraFolders: [] })) {
    assert.deepEqual(config.inspect(key)?.defaultValue, value, `default of dimosi.${key}`);
  }
  step("settings have their defaults");

  // The user looks at a file of their own. VS Code's checkers wake up, as in everyday work.
  const mine = vscode.Uri.file(path.join(root, "mine.ts"));
  // ...and has another one in a preview tab (a single click in the Explorer: the name in italics).
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, "README.md")), { preview: true });
  await vscode.window.showTextDocument(mine, { preview: false });
  await eventually("VS Code reports the error in mine.ts", () => vscode.languages.getDiagnostics(mine).length > 0, 60_000);
  step("VS Code's TypeScript checker is running");

  const server = await startFakeServer([
    {
      text: "Создаю файлы.",
      toolCalls: [
        { name: "write_file", args: { path: "hello.txt", content: "привет\n" } },
        { name: "write_file", args: { path: "broken.json", content: '{ "a": }\n' } },
        { name: "write_file", args: { path: "broken.ts", content: "const n: number = 'text';\n" } },
        { name: "write_file", args: { path: "fine.ts", content: "export const fine = 1;\n" } },
        { name: "edit_file", args: { path: "mine.ts", old_string: "'not a number'", new_string: "2" } },
      ],
    },
    { text: "Готово." },
  ]);
  try {
    const set = (key: string, value: unknown) => config.update(key, value, vscode.ConfigurationTarget.Global);
    await set("autoUpdate", false);
    await set("provider", "custom");
    await set("customBaseUrl", server.url);
    await set("model", "fake-model");
    await set("approvalMode", "auto");

    // Opens the real chat panel (its script must load and answer) and sends a task.
    await Promise.race([
      vscode.commands.executeCommand("dimosi.generateRules"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("the task did not finish in 90 s (did the chat panel load?)")), 90_000)),
    ]);
    step("the chat panel opens and the task runs to the end");

    assert.equal(await fs.readFile(path.join(root, "hello.txt"), "utf8"), "привет\n");
    assert.equal(await fs.readFile(path.join(root, "broken.json"), "utf8"), '{ "a": }\n');
    step("the agent's files are on disk");

    assert.equal(server.requests.length, 2, "two requests to the model");
    const system = String(server.requests[0].body.messages[0].content);
    assert.match(system, /Project root: /);
    const results = server.requests[1].body.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    assert.equal(results.length, 5);
    assert.equal(results[0], "Created hello.txt (1 lines).");
    assert.match(results[1], /^Created broken\.json[^]*The editor now reports \d+ errors? in this file/, `JSON errors reach the model; got: ${results[1]}`);
    assert.match(results[2], /^Created broken\.ts[^]*The editor now reports 1 error in this file[^]*line 1: .*not assignable.*\(ts 2322\)/, `TypeScript errors reach the model; got: ${results[2]}`);
    assert.equal(results[3], "Created fine.ts (1 lines).");
    assert.equal(results[4], "Edited mine.ts (1 replacement).", "the error the agent fixed is not reported any more");
    step("the editor's errors for the changed files reach the model");

    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => `${t.label}${t.isPreview ? " (preview)" : ""}`));
    assert.deepEqual(tabs, ["README.md (preview)", "mine.ts"], "tabs opened for the check are closed again, the user's preview tab is still there");
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, mine.fsPath, "the user's file stays in front");
    step("the user's tab stays in front and no tabs are left behind");
  } finally {
    await server.close();
  }
}
