import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { errorText } from "../src/errorText";
import { codeCliCandidates, codeCliInvocation, installVsix } from "../src/vsixInstall";
import { stub, Uri } from "./e2e/vscode";

beforeEach(() => stub.reset());

describe("installing an update", () => {
  it("uses VS Code's own install command when it works", async () => {
    const cli: string[] = [];
    stub.commands.set("workbench.extensions.installExtension", async () => undefined);
    expect(await installVsix(Uri.file("/u/dimosi-0.4.2.vsix") as never, async (f) => void cli.push(f))).toBe("command");
    expect(cli).toEqual([]);
  });

  it("falls back to the code command line when VS Code rejects without a message (seen in 1.140)", async () => {
    const cli: string[] = [];
    stub.commands.set("workbench.extensions.installExtension", async () => {
      throw { name: "Canceled" }; // not an Error: its .message is undefined
    });
    expect(await installVsix(Uri.file("/u/dimosi-0.4.2.vsix") as never, async (f) => void cli.push(f))).toBe("cli");
    expect(cli).toEqual([path.resolve("/u/dimosi-0.4.2.vsix")]);
  });

  it("when both ways fail, the error says why (never 'undefined')", async () => {
    stub.commands.set("workbench.extensions.installExtension", async () => {
      throw "install blocked";
    });
    await expect(
      installVsix(Uri.file("/u/x.vsix") as never, async () => {
        throw new Error("code CLI exited with 1: Extension is not compatible");
      }),
    ).rejects.toThrow(/install blocked.*not compatible/);
  });

  it("describes any thrown value", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("text")).toBe("text");
    expect(errorText({ name: "Canceled" })).toBe('{"name":"Canceled"}');
    expect(errorText(undefined)).toBe("неизвестная ошибка");
    expect(errorText(Object.assign(new Error(""), { name: "TimeoutError" }))).toBe("TimeoutError");
  });

  it("finds the code command line inside the VS Code installation", () => {
    expect(codeCliCandidates("/Applications/Visual Studio Code.app/Contents/Resources/app", "darwin")[0]).toBe(
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    );
    expect(codeCliCandidates("/usr/share/code/resources/app", "linux")).toContain(path.join("/usr/share/code", "bin", "code"));
    expect(codeCliCandidates("C:\\VSCode\\resources\\app", "win32").some((p) => p.endsWith("code.cmd"))).toBe(true);
  });

  it("on Windows quotes the paths, because the .cmd runs through the shell", () => {
    const cli = "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd";
    const vsix = "C:\\Users\\Ivan Petrov\\AppData\\Local\\Temp\\dimosi-update-x\\dimosi-0.4.7.vsix";
    expect(codeCliInvocation(cli, vsix, "win32")).toEqual({
      file: `"${cli}"`,
      args: ["--install-extension", `"${vsix}"`, "--force"],
      shell: true,
    });
    expect(codeCliInvocation("/Applications/VS Code.app/bin/code", "/tmp/a b.vsix", "darwin")).toEqual({
      file: "/Applications/VS Code.app/bin/code",
      args: ["--install-extension", "/tmp/a b.vsix", "--force"],
      shell: false,
    });
  });
});

