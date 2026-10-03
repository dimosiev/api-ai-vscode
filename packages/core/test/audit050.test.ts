// Findings of the audit after 0.5.0 (docs/AUDIT.md, «Аудит после 0.5.0»).
// A test written with `bug(...)` describes the right behaviour of something
// that is not fixed yet: it stays green until the fix lands.
// AUDIT_STRICT=1 shows the real failures.
import { linkSync, mkdirSync, mkdtempSync, promises as fs, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, type ChatRequest, type Provider, type StreamEvent } from "../src";
import { createAccess, resolvePath } from "../src/access";
import { commandRule, ruleMatches } from "../src/commandRules";
import { PermissionGate } from "../src/permissions";
import { today } from "../src/prompt";
import { diskFiles, executeTool } from "../src/tools";
import { fetchPage, htmlToText, isPublicAddress, parsePageUrl, type WebAccess } from "../src/tools/web";

const bug = process.env.AUDIT_STRICT ? it : it.fails;
const tmp = (prefix: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));

describe("О-3: a page must not freeze the editor", () => {
  // 2 MB is the most that is read from a site. Before the fix 80 thousand characters took over 2 s, and four times more for every doubling.
  const SIZE = 2 * 1024 * 1024;
  const pages: Record<string, string> = {
    "bare <": "<".repeat(SIZE),
    "unclosed comments": "<!--".repeat(SIZE / 4),
    "unclosed scripts": "<script ".repeat(SIZE / 8),
    "unclosed scripts with their tags closed": "<script>".repeat(SIZE / 8),
    "unclosed links": "<a href=https://example.com/>".repeat(SIZE / 29),
    "tags that never end": "<p ".repeat(SIZE / 3),
    "half an entity": "&amp".repeat(SIZE / 4),
    "spaces and line breaks": " \n".repeat(SIZE / 2),
  };
  for (const [name, html] of Object.entries(pages)) {
    it(`${name}: 2 MB are converted in well under 2 s`, () => {
      const started = Date.now();
      htmlToText(html);
      expect(Date.now() - started).toBeLessThan(2000);
    });
  }

  it("broken markup still gives the text around it", () => {
    expect(htmlToText("before <b>bold</b> 1 < 2 and after")).toBe("before bold 1 < 2 and after");
    expect(htmlToText("<p>one</p><script>var a = '<p>no</p>'</script><p>two</p>")).toBe("one\n\ntwo");
    expect(htmlToText("<p>seen</p><!-- never closed <p>hidden</p>")).toBe("seen");
    expect(htmlToText('<a href="https://a.example/">outer <a href="/local">inner</a> text</a>')).toBe("outer inner text (https://a.example/)");
    expect(htmlToText("<header>top</header><HEAD><title>t</title></HEAD><body>text</body>")).toBe("top\ntext");
  });
});

describe("О-4: pages that are not UTF-8", () => {
  const page = (bytes: number[], type: string): WebAccess => ({
    lookup: async () => ["93.184.216.34"],
    fetch: (async () => new Response(new Uint8Array(bytes), { headers: { "content-type": type } })) as typeof fetch,
  });
  const PRIVET_1251 = [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2];

  it("the encoding named by the site is used (windows-1251)", async () => {
    const r = await fetchPage(parsePageUrl("https://example.com/"), page(PRIVET_1251, "text/html; charset=windows-1251"));
    expect(r).toMatchObject({ kind: "page", text: "Привет" });
  });

  it("...or the one named in the page itself", async () => {
    const head = [...Buffer.from('<html><head><meta charset="windows-1251"></head><body>', "latin1")];
    const r = await fetchPage(parsePageUrl("https://example.com/"), page([...head, ...PRIVET_1251], "text/html"));
    expect(r).toMatchObject({ kind: "page", text: "Привет" });
  });

  it("a page in UTF-8, an unknown encoding name and no name at all are read as UTF-8", async () => {
    const utf8 = [...Buffer.from("Привет", "utf8")];
    for (const type of ["text/html; charset=utf-8", "text/html; charset=no-such-encoding", "text/html", ""]) {
      expect(await fetchPage(parsePageUrl("https://example.com/"), page(utf8, type))).toMatchObject({ kind: "page", text: "Привет" });
    }
  });
});

describe("О-2: \"Always\" by the beginning must not cover programs that run other programs", () => {
  const cases: Array<[approved: string, later: string]> = [
    ["npm exec tsc", "npm exec -- rimraf src"],
    ["npm x tsc", "npm x other"],
    ["npm run-script build", "npm run-script deploy"],
    ["pnpm dlx cowsay", "pnpm dlx anything-else"],
    ["pnpm exec tsc", "pnpm exec other"],
    ["yarn dlx cowsay", "yarn dlx other"],
    ["bun x cowsay", "bun x other"],
    ["docker run node", "docker run other sh"],
    ["docker exec app ls", "docker exec app other"],
    ["uv run pytest", "uv run python other.py"],
    ["poetry run pytest", "poetry run python other.py"],
    ["bundle exec rspec", "bundle exec ruby other.rb"],
    ["git submodule update", "git submodule foreach make install"],
    ["caffeinate npm test", "caffeinate npm install other"],
    ["curl https://example.com", "curl https://example.com https://other.example/?q=data"],
    ["wget https://example.com", "wget https://example.com https://other.example/"],
  ];
  for (const [approved, later] of cases) {
    it(`"${approved}" does not allow "${later}"`, () => {
      expect(ruleMatches(commandRule(approved), later)).toBe(false);
    });
  }

  it("a rule saved by an older version does not cover them either", () => {
    expect(ruleMatches({ kind: "prefix", text: "npm exec" }, "npm exec -- rimraf src")).toBe(false);
  });

  it("the approved command itself still runs without a question", () => {
    for (const [approved] of cases) expect(ruleMatches(commandRule(approved), approved)).toBe(true);
  });
});

describe("О-5: protected files in an extra folder", () => {
  async function write(folder: string, file: string) {
    const root = tmp("dimosi-a5-root-");
    mkdirSync(folder, { recursive: true });
    let asked = 0;
    const gate = new PermissionGate({ approve: async () => (asked++, "allow") }, "auto");
    const access = createAccess(root, [{ path: folder, mode: "write" }]);
    const r = await executeTool({ type: "tool_call", id: "1", name: "write_file", input: { path: path.join(folder, file), content: "x\n" } }, { root, access, gate });
    expect(r.isError).toBe(false);
    return asked;
  }

  it("the agent's rules there (.dimosi/) are asked about even with approvals off", async () => {
    expect(await write(path.join(tmp("dimosi-a5-"), "shared"), ".dimosi/rules.md")).toBe(1);
  });

  it("a folder that merely lies below something named .vscode is not all \"protected\"", async () => {
    expect(await write(path.join(tmp("dimosi-a5-"), ".vscode", "shared"), "notes.txt")).toBe(0);
  });

  it(".vscode inside the extra folder is asked about", async () => {
    expect(await write(path.join(tmp("dimosi-a5-"), "shared"), ".vscode/tasks.json")).toBe(1);
  });
});

describe("О-6: writing through a temporary file", () => {
  it("a file the user made read-only is not replaced", async () => {
    const file = path.join(tmp("dimosi-a6-"), "locked.txt");
    await fs.writeFile(file, "mine");
    await fs.chmod(file, 0o444);
    await expect(diskFiles.writeText(file, "agent's")).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe("mine");
  });

  it("a file with a second name (hard link) stays one file", async () => {
    const dir = tmp("dimosi-a6-");
    await fs.writeFile(path.join(dir, "a.txt"), "old");
    linkSync(path.join(dir, "a.txt"), path.join(dir, "b.txt"));
    await diskFiles.writeText(path.join(dir, "a.txt"), "new");
    expect(await fs.readFile(path.join(dir, "b.txt"), "utf8")).toBe("new");
  });
});

describe("О-7: public addresses", () => {
  it("192.0.x.x outside the two reserved blocks is the public internet (WordPress.com lives there)", () => {
    expect(isPublicAddress("192.0.78.9")).toBe(true);
    expect(isPublicAddress("192.0.0.1")).toBe(false);
    expect(isPublicAddress("192.0.2.1")).toBe(false);
  });
});

describe("О-8: the date the model is told", () => {
  const tz = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it("is the user's local date, not London's", () => {
    process.env.TZ = "Europe/Moscow";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T22:30:00Z")); // 01:30 on October 3 in Moscow
    expect(today()).toBe("2026-10-03");
  });
});

describe("item 9 of the audit: what changes at the start of a request within one chat", () => {
  it("plan mode changes nothing; a new folder list or edited rules change the system prompt only; the tools never change", async () => {
    const root = tmp("dimosi-cache-");
    const extra = tmp("dimosi-cache-extra-");
    const sent: Array<{ system: string; tools: string }> = [];
    const provider: Provider = {
      id: "fake",
      async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
        sent.push({ system: req.system, tools: JSON.stringify(req.tools) });
        yield { type: "done", stopReason: "end_turn", message: { role: "assistant", parts: [{ type: "text", text: "ok" }] } };
      },
      listModels: async () => [],
    };
    const agent = new Agent({ provider, model: "m", root, approval: { approve: async () => "allow" }, globalRulesPath: path.join(root, "no-global-rules.md") });
    const turn = async (text: string) => {
      for await (const _ of agent.run(text)) void _;
    };
    await turn("one");
    agent.planFirst = true;
    await turn("two");
    agent.planFirst = false;
    await turn("three");
    expect(new Set(sent.map((r) => r.system)).size).toBe(1);

    agent.extraFolders = [{ path: extra, mode: "read" }];
    await turn("four");
    expect(sent[3].system).not.toBe(sent[2].system);
    expect(sent[3].system).toContain(extra);
    await turn("five");
    expect(sent[4].system).toBe(sent[3].system);

    await fs.writeFile(path.join(root, "AGENTS.md"), "Always answer in verse.\n");
    await turn("six");
    expect(sent[5].system).not.toBe(sent[4].system);
    expect(sent[5].system).toContain("Always answer in verse.");

    expect(new Set(sent.map((r) => r.tools)).size).toBe(1);
  });
});

describe("Р-1 (waits for the owner's decision): plan mode and remembered commands", () => {
  bug("a remembered command that changes files does not run in plan mode", async () => {
    const gate = new PermissionGate({ approve: async () => "allow_always" });
    await gate.check({ kind: "command", command: "npm install", cwd: "/" });
    gate.planOnly = true;
    await expect(gate.check({ kind: "command", command: "npm install left-pad", cwd: "/" })).rejects.toThrow(/Plan mode/);
  });
});

describe("Р-2 (waits for the owner's decision): how wide an extra folder may be", () => {
  const home = tmp("dimosi-home-");
  for (const dir of ["proj", "Documents/work", "Library/Keychains", "Library/LaunchAgents"]) mkdirSync(path.join(home, dir), { recursive: true });
  const access = (folder: string) => createAccess(path.join(home, "proj"), [{ path: path.join(home, folder), mode: "write" }], { home, own: [] });

  bug("the whole of Documents can't be opened, only a folder inside it", () => {
    expect(access("Documents").folders).toEqual([]);
  });

  bug("the whole of ~/Library can't be opened (programs started at login live there)", () => {
    expect(access("Library").folders).toEqual([]);
  });

  it("whatever is opened, the folders with keys inside stay closed", () => {
    expect(() => resolvePath(access("Library"), path.join(home, "Library/Keychains/login.keychain"))).toThrow(/private folder/);
  });

  it("a folder inside Documents can be opened", () => {
    expect(access("Documents/work").folders).toHaveLength(1);
  });
});
