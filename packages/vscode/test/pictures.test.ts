import { mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isPicturePath, MAX_PREVIEW_BYTES, pictureDataUrl } from "../src/pictures";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);

describe("pictures for the chat panel", () => {
  it("knows a picture by its name", () => {
    expect(["a.png", "b.JPG", "c.jpeg", "d.webp"].map(isPicturePath)).toEqual([true, true, true, true]);
    expect(["a.svg", "b.txt", ".env", "png"].map(isPicturePath)).toEqual([false, false, false, false]);
  });

  it("gives a data address with the real type, whatever the name says", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dimosi-pic-"));
    await fs.writeFile(path.join(dir, "a.png"), PNG);
    await fs.writeFile(path.join(dir, "b.png"), JPEG);
    expect(await pictureDataUrl(path.join(dir, "a.png"))).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(await pictureDataUrl(path.join(dir, "b.png"))).toBe(`data:image/jpeg;base64,${JPEG.toString("base64")}`);
  });

  it("gives nothing for text under a picture's name, a picture under another name, a huge or a missing file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dimosi-pic-"));
    await fs.writeFile(path.join(dir, "secret.png"), "API_KEY=1");
    await fs.writeFile(path.join(dir, "picture.txt"), PNG);
    await fs.writeFile(path.join(dir, "huge.png"), Buffer.concat([PNG, Buffer.alloc(MAX_PREVIEW_BYTES)]));
    for (const name of ["secret.png", "picture.txt", "huge.png", "missing.png"]) {
      expect(await pictureDataUrl(path.join(dir, name)), name).toBeUndefined();
    }
  });
});
