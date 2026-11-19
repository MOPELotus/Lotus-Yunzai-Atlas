import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAtlasGalleryImage } from "./gallery.ts";

test("uses the Atlas snapshot gallery without crossing its game or file boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-gallery-"));
  try {
    const data = join(root, "data");
    const gallery = join(root, "gallery", "gi");
    await mkdir(data);
    await mkdir(gallery, { recursive: true });
    await writeFile(join(gallery, "known.webp"), Uint8Array.of(1, 2, 3));
    await writeFile(join(root, "outside.webp"), Uint8Array.of(4));
    await symlink(join(root, "outside.webp"), join(gallery, "link.webp"));
    expect(await readAtlasGalleryImage(data, "gi", "gallery/gi/known.webp")).toEqual(Buffer.from([1, 2, 3]));
    expect(await readAtlasGalleryImage(data, "gi", "gallery/gi/link.webp")).toBeUndefined();
    expect(await readAtlasGalleryImage(data, "gi", "gallery/gi/../../outside.webp")).toBeUndefined();
    expect(await readAtlasGalleryImage(data, "hsr", "gallery/gi/known.webp")).toBeUndefined();
    expect(await readAtlasGalleryImage(data, "gi", "gallery/gi/known.webp", 2)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
