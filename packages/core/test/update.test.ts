import { describe, expect, it } from "vitest";
import { downloadVerified, fetchManifest, isNewerVersion, parseManifest, sha256 } from "../src";

const HASH = "a".repeat(64);

describe("update manifest", () => {
  it("accepts a valid manifest", () => {
    const m = parseManifest({ version: "0.3.0", notes: "Новое", vsix: { file: "dimosi-0.3.0.vsix", sha256: HASH } });
    expect(m.version).toBe("0.3.0");
    expect(m.cli).toBeUndefined();
  });

  it("rejects broken or suspicious manifests", () => {
    expect(() => parseManifest(null)).toThrow();
    expect(() => parseManifest({ version: "latest", vsix: { file: "a.vsix", sha256: HASH } })).toThrow();
    expect(() => parseManifest({ version: "1.0.0", vsix: { file: "../etc/passwd", sha256: HASH } })).toThrow();
    expect(() => parseManifest({ version: "1.0.0", vsix: { file: "a.vsix", sha256: "nope" } })).toThrow();
    expect(() => parseManifest({ version: "1.0.0", vsix: { file: "a.vsix", sha256: HASH }, cli: { file: "x y", sha256: HASH } })).toThrow();
  });

  it("compares versions numerically", () => {
    expect(isNewerVersion("0.3.0", "0.2.0")).toBe(true);
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.2.0", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.1.9", "0.2.0")).toBe(false);
  });
});

describe("download", () => {
  const realFetch = globalThis.fetch;
  const body = new TextEncoder().encode("vsix-bytes");

  it("fetches the manifest and verifies the checksum of the download", async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("latest.json")) {
        return new Response(JSON.stringify({ version: "9.9.9", vsix: { file: "d.vsix", sha256: sha256(body) } }));
      }
      return new Response(body);
    }) as typeof fetch;
    try {
      const m = await fetchManifest("https://example.test/secret/");
      expect(await downloadVerified("https://example.test/secret", m.vsix)).toEqual(body);
      await expect(downloadVerified("https://example.test/secret", { file: "d.vsix", sha256: HASH })).rejects.toThrow(/Контрольная сумма/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
