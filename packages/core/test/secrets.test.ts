import { describe, expect, it } from "vitest";
import { decryptKeys, encryptKeys, exportKeys, importKeys, maskKey, type KeyStore } from "../src";

class MemoryStore implements KeyStore {
  data = new Map<string, string>();
  async get(n: string) {
    return this.data.get(n);
  }
  async set(n: string, v: string) {
    this.data.set(n, v);
  }
  async delete(n: string) {
    this.data.delete(n);
  }
  async list() {
    return [...this.data.keys()];
  }
}

describe("key file encryption", () => {
  it("round-trips keys", () => {
    const text = encryptKeys({ anthropic: "sk-ant-123", polza: "pz-456" }, "secret-pass");
    expect(text).not.toContain("sk-ant-123");
    expect(decryptKeys(text, "secret-pass")).toEqual({ anthropic: "sk-ant-123", polza: "pz-456" });
  });

  it("rejects a wrong password", () => {
    const text = encryptKeys({ a: "b" }, "right");
    expect(() => decryptKeys(text, "wrong")).toThrow(/Wrong password/);
  });

  it("rejects files that are not key files", () => {
    expect(() => decryptKeys("{}", "x")).toThrow(/not a key file/);
    expect(() => decryptKeys("hello", "x")).toThrow(/not a key file/);
  });

  it("exports from one store and imports into another", async () => {
    const a = new MemoryStore();
    await a.set("openai", "sk-1");
    await a.set("polza", "pz-2");
    const file = await exportKeys(a, "pw");
    const b = new MemoryStore();
    expect(await importKeys(b, file, "pw")).toEqual(["openai", "polza"]);
    expect(await b.get("polza")).toBe("pz-2");
  });

  it("masks keys", () => {
    expect(maskKey("sk-ant-api03-abcdefgh")).toBe("sk-a…efgh");
  });

  it("still imports key files exported by version 0.1", () => {
    const legacy = encryptKeys({ polza: "pz" }, "pw").replace('"dimosi-keys"', '"api-ai-keys"');
    expect(decryptKeys(legacy, "pw")).toEqual({ polza: "pz" });
  });
});
