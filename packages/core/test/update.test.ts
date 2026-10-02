import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  downloadVerified,
  fetchManifest,
  isNewerVersion,
  parseManifest,
  sha256,
  signManifest,
  verifyManifest,
  type UpdateManifest,
} from "../src";

const HASH = "a".repeat(64);

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    priv: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    pub: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}
const owner = keyPair();
const signed = (m: UpdateManifest, priv = owner.priv): UpdateManifest => ({ ...m, signature: signManifest(m, priv) });

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

  it("accepts only .vsix and .tgz files and a YYYY-MM-DD date", () => {
    const ok = { version: "1.0.0", date: "2026-10-02", vsix: { file: "dimosi-1.0.0.vsix", sha256: HASH }, cli: { file: "dimosi-cli-1.0.0.tgz", sha256: HASH } };
    expect(parseManifest(ok).date).toBe("2026-10-02");
    expect(() => parseManifest({ ...ok, vsix: { file: "dimosi.exe", sha256: HASH } })).toThrow();
    expect(() => parseManifest({ ...ok, vsix: { file: "dimosi.vsix.sh", sha256: HASH } })).toThrow();
    expect(() => parseManifest({ ...ok, cli: { file: "dimosi-cli.vsix", sha256: HASH } })).toThrow();
    expect(() => parseManifest({ ...ok, date: "вчера" })).toThrow();
    expect(() => parseManifest({ ...ok, date: "2026-10-02\nnotes=x" })).toThrow();
  });

  it("compares versions numerically", () => {
    expect(isNewerVersion("0.3.0", "0.2.0")).toBe(true);
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.2.0", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.1.9", "0.2.0")).toBe(false);
  });
});

describe("release signature", () => {
  const base: UpdateManifest = {
    version: "0.4.0",
    date: "2026-10-02",
    notes: "Что нового",
    vsix: { file: "dimosi-0.4.0.vsix", sha256: HASH },
    cli: { file: "dimosi-cli-0.4.0.tgz", sha256: HASH },
  };

  it("accepts a manifest signed by a trusted key, after a JSON round trip", () => {
    const m = parseManifest(JSON.parse(JSON.stringify(signed(base))));
    expect(() => verifyManifest(m, [owner.pub])).not.toThrow();
  });

  it("accepts the second key while moving to a new one", () => {
    const next = keyPair();
    expect(() => verifyManifest(signed(base, next.priv), [owner.pub, next.pub])).not.toThrow();
  });

  it("rejects unsigned manifests and signatures from other keys", () => {
    expect(() => verifyManifest(base, [owner.pub])).toThrow(/не подписан/);
    expect(() => verifyManifest(signed(base, keyPair().priv), [owner.pub])).toThrow(/не сходится/);
    expect(() => verifyManifest(signed(base), [])).toThrow(/не сходится/);
  });

  it("rejects any change to a signed field", () => {
    const m = signed(base);
    const tampered: UpdateManifest[] = [
      { ...m, version: "99.0.0" },
      { ...m, vsix: { ...m.vsix, sha256: "b".repeat(64) } },
      { ...m, vsix: { ...m.vsix, file: "evil.vsix" } },
      { ...m, cli: undefined },
      { ...m, notes: "Перезагрузите и введите пароль" },
    ];
    for (const t of tampered) expect(() => verifyManifest(t, [owner.pub])).toThrow(/не сходится/);
  });
});

describe("download", () => {
  const realFetch = globalThis.fetch;
  const body = new TextEncoder().encode("vsix-bytes");

  it("fetches the manifest and verifies the checksum of the download", async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("latest.json")) {
        return new Response(JSON.stringify(signed({ version: "9.9.9", vsix: { file: "d.vsix", sha256: sha256(body) } })));
      }
      return new Response(body);
    }) as typeof fetch;
    try {
      const m = await fetchManifest("https://example.test/secret/", [owner.pub]);
      await expect(fetchManifest("https://example.test/secret/", [keyPair().pub])).rejects.toThrow(/не сходится/);
      expect(await downloadVerified("https://example.test/secret", m.vsix)).toEqual(body);
      await expect(downloadVerified("https://example.test/secret", { file: "d.vsix", sha256: HASH })).rejects.toThrow(/Контрольная сумма/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not read an endless latest.json or update file", async () => {
    // 12 MB: far over both limits, but finite, so old code can't eat the memory.
    const endless = () => {
      let chunks = 200;
      return new ReadableStream({
        pull(controller) {
          if (chunks-- > 0) controller.enqueue(new Uint8Array(64 * 1024).fill(32));
          else controller.close();
        },
      });
    };
    globalThis.fetch = (async () => new Response(endless())) as unknown as typeof fetch;
    try {
      await expect(fetchManifest("https://example.test/secret/", [owner.pub])).rejects.toThrow(/слишком большой/);
      await expect(downloadVerified("https://example.test/secret", { file: "d.vsix", sha256: HASH }, 120_000, 1024 * 1024)).rejects.toThrow(/слишком большой/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
