import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Log } from "@dimosi/core";
import { fileSink } from "../src/log";

describe("CLI journal file", () => {
  it("appends lines and rotates past the size limit, keeping one old file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-log-"));
    const file = path.join(dir, "sub", "dimosi.log");
    const log = new Log(fileSink(file, 200));
    for (let i = 0; i < 20; i++) log.info(`line ${i} ${"x".repeat(20)}`);
    const current = readFileSync(file, "utf8");
    const old = readFileSync(`${file}.1`, "utf8");
    expect(current).toMatch(/\[info\] line 19 x+\n$/);
    expect(old).toMatch(/\[info\] line \d+/);
    expect(statSync(file).size).toBeLessThan(400);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0); // private to the user
  });

  it("never writes a key, and a broken file never breaks the CLI", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dimosi-cli-log-"));
    const file = path.join(dir, "dimosi.log");
    const log = new Log(fileSink(file));
    log.addSecret("pz-0123456789abcdef");
    log.error("401 for key pz-0123456789abcdef");
    expect(readFileSync(file, "utf8")).not.toContain("pz-0123456789abcdef");

    writeFileSync(path.join(dir, "blocker"), "");
    const broken = new Log(fileSink(path.join(dir, "blocker", "dimosi.log")));
    expect(() => broken.info("still fine")).not.toThrow();
  });
});
