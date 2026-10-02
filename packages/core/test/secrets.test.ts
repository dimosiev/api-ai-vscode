import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
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

  it("new files use a stronger scrypt (N = 2^17), and files made with the old one still open", () => {
    expect(JSON.parse(encryptKeys({ a: "1" }, "pw")).kdf.N).toBe(2 ** 17);
    // A file as dimosi 0.4.6 wrote it: N = 2^15.
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", scryptSync("pw", salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify({ polza: "pz-old" }), "utf8"), cipher.final()]);
    const old = JSON.stringify({
      format: "dimosi-keys",
      version: 1,
      kdf: { name: "scrypt", N: 2 ** 15, r: 8, p: 1, salt: salt.toString("base64") },
      cipher: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
    expect(decryptKeys(old, "pw")).toEqual({ polza: "pz-old" });
  });

  it("masks keys", () => {
    expect(maskKey("sk-ant-api03-abcdefgh")).toBe("sk-a…efgh");
  });

  it("still imports key files exported by version 0.1", () => {
    const legacy = encryptKeys({ polza: "pz" }, "pw").replace('"dimosi-keys"', '"api-ai-keys"');
    expect(decryptKeys(legacy, "pw")).toEqual({ polza: "pz" });
  });
});
